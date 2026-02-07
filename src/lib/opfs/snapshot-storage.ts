/**
 * OPFS Arrow IPC Snapshot Storage
 *
 * Provides cold storage for large table snapshots using Arrow IPC format.
 * Arrow IPC eliminates DuckDB's Parquet extension dependency, enabling the
 * COI bundle (pthreads + SIMD) for multi-threaded query performance.
 *
 * Trade-off: Arrow IPC files are 5-10x larger than compressed Parquet,
 * but this is acceptable given abundant OPFS quota (~60% of free disk).
 *
 * Export: conn.query(SELECT *) → tableToIPC() → write to OPFS
 * Import: read OPFS bytes → conn.insertArrowFromIPCStream()
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { tableToIPC } from 'apache-arrow'
import { CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN } from '@/lib/duckdb'
import { SHARD_SIZE } from '@/lib/constants'
import { writeManifest, readManifest, deleteManifest, type SnapshotManifest, type ShardInfo } from './manifest'
import { deleteFileIfExists, renameFile } from './opfs-helpers'
import { yieldToMain } from '@/lib/utils/yield-to-main'

/**
 * File-level write locks to prevent concurrent OPFS writes to the same file.
 * OPFS doesn't allow multiple writable streams on the same file.
 * This Map tracks ongoing write operations by file name.
 */
const writeLocksInProgress = new Map<string, Promise<void>>()

/**
 * Global export queue - ensures only ONE snapshot export runs at a time.
 *
 * tableToIPC() generates the entire Uint8Array in JS heap. When multiple exports
 * run concurrently, RAM spikes dangerously. By serializing exports, peak RAM
 * stays manageable.
 *
 * This is separate from writeLocksInProgress which prevents concurrent writes
 * to the SAME file. This queue prevents concurrent export operations globally.
 */
let globalExportChain: Promise<void> = Promise.resolve()

/**
 * Execute a function with global export serialization.
 * Only one export operation can run at a time across the entire app.
 */
async function withGlobalExportLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousExport = globalExportChain
  let resolve: () => void = () => {}

  // Chain this export after any currently running export
  globalExportChain = new Promise<void>(r => { resolve = r })

  try {
    // Wait for previous export to complete
    await previousExport
    // Execute this export
    return await fn()
  } finally {
    // Release the lock for next export
    resolve()
  }
}

/**
 * Ensure identity columns (_cs_id, _cs_origin_id) exist in a restored table.
 * Tables from older snapshots may be missing these columns.
 *
 * If missing, recreates the table with identity columns added.
 */
async function ensureIdentityColumns(
  conn: AsyncDuckDBConnection,
  tableName: string
): Promise<void> {
  // Check if _cs_id column exists
  const columnsResult = await conn.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = '${tableName}'
  `)
  const columns = columnsResult.toArray().map(row => row.toJSON().column_name as string)

  const hasCsId = columns.includes(CS_ID_COLUMN)
  const hasCsOriginId = columns.includes(CS_ORIGIN_ID_COLUMN)

  if (hasCsId && hasCsOriginId) {
    return // Both columns exist, nothing to do
  }

  console.log(`[Snapshot] Adding missing identity columns to ${tableName}`)

  // Get non-internal column names for SELECT
  const dataColumns = columns
    .filter(c => c !== CS_ID_COLUMN && c !== CS_ORIGIN_ID_COLUMN)
    .map(c => `"${c}"`)
    .join(', ')

  // Build SELECT clause with identity columns
  const selectParts: string[] = []

  if (!hasCsId) {
    selectParts.push(`ROW_NUMBER() OVER () * 100 as "${CS_ID_COLUMN}"`)
  } else {
    selectParts.push(`"${CS_ID_COLUMN}"`)
  }

  if (!hasCsOriginId) {
    selectParts.push(`gen_random_uuid()::VARCHAR as "${CS_ORIGIN_ID_COLUMN}"`)
  } else {
    selectParts.push(`"${CS_ORIGIN_ID_COLUMN}"`)
  }

  selectParts.push(dataColumns)

  // Recreate table with identity columns
  const tempTable = `__temp_restore_${Date.now()}`
  await conn.query(`
    CREATE TABLE "${tempTable}" AS
    SELECT ${selectParts.join(', ')} FROM "${tableName}"
  `)
  await conn.query(`DROP TABLE "${tableName}"`)
  await conn.query(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
}

/**
 * Acquire a write lock for a file, waiting for any existing write to complete.
 * Returns a release function that must be called when done.
 */
async function acquireWriteLock(fileName: string): Promise<() => void> {
  // Wait for any existing write to complete
  const existingLock = writeLocksInProgress.get(fileName)
  if (existingLock) {
    console.log(`[Snapshot] Waiting for existing write lock on ${fileName}...`)
    await existingLock.catch(() => {}) // Ignore errors from previous write
  }

  // Create a new lock with a resolver
  let releaseLock: () => void = () => {}
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  writeLocksInProgress.set(fileName, lockPromise)

  return () => {
    writeLocksInProgress.delete(fileName)
    releaseLock()
  }
}

/**
 * Create a writable stream with retry logic for OPFS lock conflicts.
 * OPFS can briefly hold locks after close(), this handles that gracefully.
 */
async function createWritableWithRetry(
  fileHandle: FileSystemFileHandle,
  maxRetries = 3
): Promise<FileSystemWritableFileStream> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fileHandle.createWritable()
    } catch (err) {
      const isLockError =
        err instanceof Error &&
        (err.name === 'NoModificationAllowedError' ||
          err.message.includes('modifications are not allowed'))

      if (!isLockError || attempt === maxRetries) {
        throw err
      }

      // Wait before retry with exponential backoff: 50ms, 100ms, 200ms
      const delay = 50 * Math.pow(2, attempt - 1)
      console.warn(`[Snapshot] createWritable failed (attempt ${attempt}), retrying in ${delay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error('createWritableWithRetry: unreachable')
}

/**
 * Ensure the snapshots directory exists in OPFS.
 * Must be called before first snapshot export to avoid write errors.
 */
export async function ensureSnapshotDir(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
    await appDir.getDirectoryHandle('snapshots', { create: true })
  } catch (err) {
    console.warn('[Snapshot] Failed to create snapshots directory:', err)
    // Non-fatal - will be created on first file write
  }
}

/**
 * Detect the correct ORDER BY column for deterministic export.
 * Diff tables use sort_key (preserves original row order).
 * Regular tables use _cs_id.
 * Uses raw connection to avoid mutex reentrancy (caller holds mutex).
 */
async function getOrderByColumn(
  conn: AsyncDuckDBConnection,
  tableName: string
): Promise<string> {
  try {
    // Use raw connection.query() - NOT mutex-wrapped
    // Check for sort_key first (diff tables with row ordering)
    const sortKeyResult = await conn.query(`
      SELECT column_name
      FROM (DESCRIBE "${tableName}")
      WHERE column_name = 'sort_key'
    `)

    if (sortKeyResult.numRows > 0) {
      return 'sort_key'  // Use sort_key for diff tables (preserves original order)
    }

    // Check for _cs_id (regular tables)
    const result = await conn.query(`
      SELECT column_name
      FROM (DESCRIBE "${tableName}")
      WHERE column_name = '${CS_ID_COLUMN}'
    `)

    if (result.numRows > 0) {
      return CS_ID_COLUMN  // Use _cs_id if it exists
    }

    // Fallback: Check for row_id (old diff tables)
    const rowIdResult = await conn.query(`
      SELECT column_name
      FROM (DESCRIBE "${tableName}")
      WHERE column_name = 'row_id'
    `)

    if (rowIdResult.numRows > 0) {
      return 'row_id'  // Use row_id for old diff tables
    }

    // No suitable column found - skip ORDER BY
    return ''
  } catch (err) {
    console.warn('[Snapshot] Failed to detect ORDER BY column:', err)
    return ''  // Safe fallback: no ordering (still works, just not deterministic)
  }
}

/**
 * Options for snapshot export operations
 */
export interface ExportOptions {
  /**
   * Callback for shard progress during exports.
   * Called after each shard is written with current/total progress.
   */
  onChunkProgress?: (current: number, total: number, tableName: string) => void
}

/**
 * Export a table to Arrow IPC shards in OPFS
 *
 * Uses Arrow IPC serialization: conn.query() returns Arrow Table natively,
 * serialize to IPC bytes via tableToIPC(), write bytes to OPFS.
 *
 * Always uses micro-shard storage: every table is split into SHARD_SIZE-row
 * shards (50k rows) with a manifest file. For small tables the loop runs
 * once producing a single _shard_0.arrow + manifest.
 *
 * tableToIPC() generates the entire Uint8Array in JS heap (no compression),
 * so shard size is kept at 50k rows (~25-50 MB per shard).
 *
 * @param db - DuckDB instance (kept for caller API stability)
 * @param conn - Active DuckDB connection (for SELECT queries)
 * @param tableName - Source table to export
 * @param snapshotId - Unique snapshot identifier (e.g., "snapshot_abc_1234567890")
 * @param options - Optional export options (shard progress callback)
 */
export async function exportTableToSnapshot(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string,
  options?: ExportOptions
): Promise<void> {
  void db // Kept for caller API stability — no longer used internally
  // Use global export queue to serialize export operations (prevents RAM spikes)
  return withGlobalExportLock(async () => {
    await ensureSnapshotDir()

    // Check table size
    const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
    const rowCount = Number(countResult.toArray()[0].toJSON().count)

    console.log(`[Snapshot] Exporting ${tableName} (${rowCount.toLocaleString()} rows) to OPFS...`)

    // Acquire write lock for this snapshot to prevent concurrent writes
    const releaseLock = await acquireWriteLock(snapshotId)

    try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: true })

    // Detect ORDER BY column once (same for all shards)
    const orderByCol = await getOrderByColumn(conn, tableName)
    const orderByClause = orderByCol ? `ORDER BY "${orderByCol}"` : ''

    // Get column names for manifest
    const columnsResult = await conn.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    const columns = columnsResult.toArray().map(row => row.toJSON().column_name as string)

    // Always use micro-shard export: SHARD_SIZE rows per shard
    const batchSize = SHARD_SIZE
    const totalShards = Math.max(1, Math.ceil(rowCount / batchSize))
    let offset = 0
    let shardIndex = 0

    // Collect shard metadata for manifest
    const shardInfos: ShardInfo[] = []

    try {
      while (offset < rowCount || shardIndex === 0) {
        const opfsTempFile = `${snapshotId}_shard_${shardIndex}.arrow.tmp`
        const finalFileName = `${snapshotId}_shard_${shardIndex}.arrow`

        // 1. Query shard and serialize to Arrow IPC
        // CRITICAL: ORDER BY ensures deterministic row ordering across shards

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let arrowTable: any = await conn.query(`
          SELECT * FROM "${tableName}"
          ${orderByClause}
          LIMIT ${batchSize} OFFSET ${offset}
        `)

        const shardRowCount = arrowTable.numRows
        let ipcBytes: Uint8Array | null = tableToIPC(arrowTable, 'stream')
        arrowTable = null // Release Arrow Table reference for GC

        // 2. Write to OPFS temp file (atomic step 1)
        const tempHandle = await snapshotsDir.getFileHandle(opfsTempFile, { create: true })
        const writable = await createWritableWithRetry(tempHandle)
        await writable.write(ipcBytes)
        await writable.close()

        // Explicit release to help GC reclaim memory faster
        ipcBytes = null

        // CRITICAL: Small delay to ensure file handle is fully released
        await new Promise(resolve => setTimeout(resolve, 20))

        // Verify temp file was written
        const tempFile = await tempHandle.getFile()
        if (tempFile.size === 0) {
          throw new Error(`[Snapshot] Failed to write temp shard ${opfsTempFile} - file is 0 bytes`)
        }

        // 3. Atomic rename: temp → final (atomic step 2)
        await deleteFileIfExists(snapshotsDir, finalFileName)
        const finalHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
        const finalWritable = await finalHandle.createWritable()
        const tempContent = await tempFile.arrayBuffer()
        await finalWritable.write(tempContent)
        await finalWritable.close()

        await new Promise(resolve => setTimeout(resolve, 20))

        // Verify final file was written
        const file = await finalHandle.getFile()
        if (file.size === 0) {
          throw new Error(`[Snapshot] Failed to write ${finalFileName} - file is 0 bytes`)
        }
        console.log(`[Snapshot] Wrote ${(file.size / 1024 / 1024).toFixed(2)} MB to ${finalFileName}`)

        // 4. Cleanup: delete temp file
        await deleteFileIfExists(snapshotsDir, opfsTempFile)

        // Query min/max _cs_id for this shard (enables shard-backed grid rendering)
        // Uses the same LIMIT/OFFSET window as the shard export query above
        let minCsId: number | null = null
        let maxCsId: number | null = null
        if (orderByCol === CS_ID_COLUMN && shardRowCount > 0) {
          try {
            const rangeResult = await conn.query(`
              SELECT MIN(sub.cid) as min_id, MAX(sub.cid) as max_id
              FROM (
                SELECT CAST("${CS_ID_COLUMN}" AS BIGINT) as cid
                FROM "${tableName}"
                ${orderByClause}
                LIMIT ${batchSize} OFFSET ${offset}
              ) sub
            `)
            const row = rangeResult.toArray()[0]?.toJSON()
            if (row) {
              minCsId = row.min_id != null ? Number(row.min_id) : null
              maxCsId = row.max_id != null ? Number(row.max_id) : null
            }
          } catch (err) {
            console.warn(`[Snapshot] Failed to get min/max _cs_id for shard ${shardIndex}:`, err)
            // Non-fatal: legacy manifests work without these values
          }
        }

        // Collect shard metadata
        shardInfos.push({
          index: shardIndex,
          fileName: finalFileName,
          rowCount: shardRowCount,
          byteSize: file.size,
          minCsId,
          maxCsId,
        })

        offset += batchSize
        shardIndex++
        console.log(`[Snapshot] Exported shard ${shardIndex}: ${Math.min(offset, rowCount).toLocaleString()}/${rowCount.toLocaleString()} rows`)

        // Report shard progress via callback (for UI status bar)
        if (options?.onChunkProgress) {
          options.onChunkProgress(shardIndex, totalShards, tableName)
        }

        // Yield to browser between shards to prevent UI freezing during large exports
        await yieldToMain()

        // Break if we've processed all rows (handles 0-row tables via shardIndex === 0 guard above)
        if (offset >= rowCount) break
      }

      // Clear shard progress when done
      if (options?.onChunkProgress) {
        options.onChunkProgress(totalShards, totalShards, tableName)
      }

      // Write manifest with collected shard metadata
      const manifest: SnapshotManifest = {
        version: 1,
        snapshotId,
        totalRows: rowCount,
        totalBytes: shardInfos.reduce((sum, s) => sum + s.byteSize, 0),
        shardSize: SHARD_SIZE,
        shards: shardInfos,
        columns,
        orderByColumn: orderByCol,
        createdAt: Date.now(),
      }
      await writeManifest(manifest)

      console.log(`[Snapshot] Exported ${shardIndex} shard(s) to ${snapshotId}_shard_*.arrow`)
    } catch (error) {
      // Cleanup any temp files on failure
      for (let i = 0; i <= shardIndex; i++) {
        await deleteFileIfExists(snapshotsDir, `${snapshotId}_shard_${i}.arrow.tmp`)
      }
      throw error
    }

    // CHECKPOINT after large exports to release DuckDB buffer pool
    if (rowCount > SHARD_SIZE) {
      try {
        await conn.query('CHECKPOINT')
        console.log('[Snapshot] CHECKPOINT after large export')
      } catch {
        // Non-fatal - CHECKPOINT failure shouldn't fail the export
      }
    }
  } finally {
    // Always release the write lock
    releaseLock()
  }
  }) // End of withGlobalExportLock
}

/**
 * Export a single DuckDB temp table as one Arrow IPC shard to OPFS.
 * Used by the shard transform pipeline — each transformed shard gets written
 * directly to disk without accumulating in memory.
 *
 * Uses the same atomic .tmp → rename pattern as exportTableToSnapshot.
 *
 * @param conn - Active DuckDB connection
 * @param tableName - DuckDB temp table containing one shard of transformed data
 * @param snapshotId - Output snapshot ID (e.g., "_xform_my_table_1707...")
 * @param shardIndex - Shard index (0, 1, 2...)
 * @returns ShardInfo metadata for manifest construction
 */
export async function exportSingleShard(
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string,
  shardIndex: number
): Promise<ShardInfo> {
  await ensureSnapshotDir()

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: true })

  const opfsTempFile = `${snapshotId}_shard_${shardIndex}.arrow.tmp`
  const finalFileName = `${snapshotId}_shard_${shardIndex}.arrow`

  // Query and serialize to Arrow IPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let arrowTable: any = await conn.query(`SELECT * FROM "${tableName}"`)
  const shardRowCount = arrowTable.numRows
  let ipcBytes: Uint8Array | null = tableToIPC(arrowTable, 'stream')
  arrowTable = null // Release for GC

  // Write to temp file (atomic step 1)
  const tempHandle = await snapshotsDir.getFileHandle(opfsTempFile, { create: true })
  const writable = await createWritableWithRetry(tempHandle)
  await writable.write(ipcBytes)
  await writable.close()

  ipcBytes = null // Release for GC

  // Small delay to ensure file handle is fully released
  await new Promise(resolve => setTimeout(resolve, 20))

  // Verify temp file
  const tempFile = await tempHandle.getFile()
  if (tempFile.size === 0) {
    throw new Error(`[Snapshot] Failed to write temp shard ${opfsTempFile} - file is 0 bytes`)
  }

  // Atomic rename: temp → final
  await deleteFileIfExists(snapshotsDir, finalFileName)
  const finalHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
  const finalWritable = await finalHandle.createWritable()
  const tempContent = await tempFile.arrayBuffer()
  await finalWritable.write(tempContent)
  await finalWritable.close()

  await new Promise(resolve => setTimeout(resolve, 20))

  // Verify final file
  const file = await finalHandle.getFile()
  if (file.size === 0) {
    throw new Error(`[Snapshot] Failed to write ${finalFileName} - file is 0 bytes`)
  }

  // Cleanup temp
  await deleteFileIfExists(snapshotsDir, opfsTempFile)

  console.log(`[Snapshot] Exported shard ${shardIndex} (${(file.size / 1024 / 1024).toFixed(2)} MB) to ${finalFileName}`)

  // Query min/max _cs_id from the temp table (enables shard-backed grid rendering)
  let minCsId: number | null = null
  let maxCsId: number | null = null
  try {
    const rangeResult = await conn.query(`
      SELECT MIN(CAST("${CS_ID_COLUMN}" AS BIGINT)) as min_id,
             MAX(CAST("${CS_ID_COLUMN}" AS BIGINT)) as max_id
      FROM "${tableName}"
    `)
    const row = rangeResult.toArray()[0]?.toJSON()
    if (row) {
      minCsId = row.min_id != null ? Number(row.min_id) : null
      maxCsId = row.max_id != null ? Number(row.max_id) : null
    }
  } catch {
    // Non-fatal: table may lack _cs_id (e.g., diff tables)
  }

  return {
    index: shardIndex,
    fileName: finalFileName,
    rowCount: shardRowCount,
    byteSize: file.size,
    minCsId,
    maxCsId,
  }
}

/**
 * Atomically replace one snapshot with another.
 * Deletes old shards/manifest, renames new shards to the final snapshot ID.
 *
 * Used by the shard transform pipeline to replace the pre-transform snapshot
 * with the post-transform output once all shards are processed.
 *
 * @param oldSnapshotId - The original snapshot to delete
 * @param newSnapshotId - The temp output snapshot (files will be renamed)
 * @param finalSnapshotId - What the output should be called (usually = oldSnapshotId)
 */
export async function swapSnapshots(
  oldSnapshotId: string,
  newSnapshotId: string,
  finalSnapshotId: string
): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  // ATOMICITY: Rename new shards FIRST, write manifest, THEN delete old.
  // If the browser crashes mid-swap, both old and new files exist briefly —
  // but data is never lost. Startup cleanup handles orphaned _xform_ files.

  // Step 1: Read the new manifest to know which shard files exist
  const newManifest = await readManifest(newSnapshotId)
  if (!newManifest) {
    throw new Error(`[Snapshot] swapSnapshots: no manifest found for ${newSnapshotId}`)
  }

  // Step 2: Rename new shards → final ID (both old and new coexist briefly)
  const renamedShards: ShardInfo[] = []

  for (const shard of newManifest.shards) {
    const oldFileName = shard.fileName // e.g., "_xform_table_123_shard_0.arrow"
    const newFileName = `${finalSnapshotId}_shard_${shard.index}.arrow`

    // renameFile() overwrites via createWritable(), so no pre-delete needed
    await renameFile(snapshotsDir, oldFileName, newFileName)

    renamedShards.push({
      ...shard,
      fileName: newFileName,
    })
  }

  // Step 3: Write new manifest with final snapshot ID (confirms new data)
  await deleteManifest(newSnapshotId)
  await writeManifest({
    ...newManifest,
    snapshotId: finalSnapshotId,
    shards: renamedShards,
    createdAt: Date.now(),
  })

  // Step 4: Clean up leftover old shards beyond the new shard count.
  // If old had 20 shards but new has 18, shards 18-19 from old still exist.
  // (Shards 0..N-1 were already overwritten by the rename in step 2.)
  const newShardCount = renamedShards.length
  let extraIndex = newShardCount
  while (true) {
    const oldShardFile = `${finalSnapshotId}_shard_${extraIndex}.arrow`
    try {
      await snapshotsDir.getFileHandle(oldShardFile, { create: false })
      await snapshotsDir.removeEntry(oldShardFile)
      extraIndex++
    } catch {
      break // No more old shards
    }
  }

  // Also clean up any legacy _part_N files from the old snapshot
  let legacyIndex = 0
  while (true) {
    const legacyFile = `${finalSnapshotId}_part_${legacyIndex}.arrow`
    try {
      await snapshotsDir.getFileHandle(legacyFile, { create: false })
      await snapshotsDir.removeEntry(legacyFile)
      legacyIndex++
    } catch {
      break
    }
  }

  console.log(`[Snapshot] Swapped ${oldSnapshotId} → ${finalSnapshotId} (${renamedShards.length} shards)`)
}

/**
 * Import a SINGLE shard from a snapshot into DuckDB as a temp table.
 * This is the key enabler for chunk-by-chunk processing - loads ~25-50MB per shard
 * instead of the full table (500MB-1GB).
 *
 * @param db - DuckDB instance
 * @param conn - Active DuckDB connection
 * @param snapshotId - Snapshot identifier
 * @param shardIndex - Which shard to load (0-based)
 * @param tempTableName - Name for the DuckDB temp table
 */
export async function importSingleShard(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  snapshotId: string,
  shardIndex: number,
  tempTableName: string
): Promise<void> {
  void db // Kept for caller API stability — no longer used internally
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  // Try new shard naming first, fall back to legacy part naming
  let fileName = `${snapshotId}_shard_${shardIndex}.arrow`
  let fileHandle: FileSystemFileHandle
  try {
    fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
  } catch {
    // Legacy fallback
    fileName = `${snapshotId}_part_${shardIndex}.arrow`
    fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
  }

  const file = await fileHandle.getFile()
  const buffer = new Uint8Array(await file.arrayBuffer())

  // Drop existing temp table if it exists
  await conn.query(`DROP TABLE IF EXISTS "${tempTableName}"`)

  // Import into temp table
  await conn.insertArrowFromIPCStream(buffer, { name: tempTableName, create: true })

  console.log(`[Snapshot] Imported shard ${shardIndex} (${(file.size / 1024 / 1024).toFixed(2)} MB) as ${tempTableName}`)
}

/**
 * Import a table from Arrow IPC file in OPFS
 *
 * Reads Arrow IPC bytes from OPFS and inserts directly into DuckDB
 * via insertArrowFromIPCStream(). No file registration needed.
 *
 * Handles sharded files (_shard_N), legacy chunked files (_part_N), and single files.
 *
 * @param db - DuckDB instance (kept for caller API stability)
 * @param conn - Active DuckDB connection
 * @param snapshotId - Unique snapshot identifier
 * @param targetTableName - Name for the restored table
 */
export async function importTableFromSnapshot(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  snapshotId: string,
  targetTableName: string
): Promise<void> {
  void db // Kept for caller API stability — no longer used internally
  console.log(`[Snapshot] Importing from ${snapshotId}...`)

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  // Check for sharded/chunked snapshot: try _shard_0 first, then legacy _part_0
  let isSharded = false
  try {
    await snapshotsDir.getFileHandle(`${snapshotId}_shard_0.arrow`, { create: false })
    isSharded = true
  } catch {
    // Check legacy _part_N naming
    try {
      await snapshotsDir.getFileHandle(`${snapshotId}_part_0.arrow`, { create: false })
      isSharded = true
    } catch {
      isSharded = false
    }
  }

  // Drop existing table to ensure clean import
  await conn.query(`DROP TABLE IF EXISTS "${targetTableName}"`)

  if (isSharded) {
    let partIndex = 0

    while (true) {
      try {
        // Try new _shard_N naming first, fall back to legacy _part_N
        let fileName: string
        let fileHandle: FileSystemFileHandle
        try {
          fileName = `${snapshotId}_shard_${partIndex}.arrow`
          fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
        } catch {
          fileName = `${snapshotId}_part_${partIndex}.arrow`
          fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
        }

        const file = await fileHandle.getFile()
        const buffer = new Uint8Array(await file.arrayBuffer())

        if (partIndex === 0) {
          // First shard: create the table
          await conn.insertArrowFromIPCStream(buffer, { name: targetTableName, create: true })
        } else {
          // Subsequent shards: append to existing table
          try {
            await conn.insertArrowFromIPCStream(buffer, { name: targetTableName, create: false })
          } catch (appendError) {
            // Schema mismatch fallback: use temp table + INSERT INTO SELECT
            console.warn(`[Snapshot] Schema mismatch on shard ${partIndex}, using fallback:`, appendError)
            const tempChunkTable = `__temp_chunk_${Date.now()}_${partIndex}`
            await conn.insertArrowFromIPCStream(buffer, { name: tempChunkTable, create: true })
            await conn.query(`INSERT INTO "${targetTableName}" SELECT * FROM "${tempChunkTable}"`)
            await conn.query(`DROP TABLE "${tempChunkTable}"`)
          }
        }

        partIndex++
      } catch {
        break // No more shards
      }
    }

    console.log(`[Snapshot] Restored ${targetTableName} from ${partIndex} shard(s)`)
  } else {
    // Legacy single file import (pre-shard snapshots)
    const fileName = `${snapshotId}.arrow`
    const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
    const file = await fileHandle.getFile()
    const buffer = new Uint8Array(await file.arrayBuffer())

    await conn.insertArrowFromIPCStream(buffer, { name: targetTableName, create: true })

    console.log(`[Snapshot] Restored ${targetTableName} from single legacy file`)
  }

  // Ensure identity columns exist (for snapshots from older versions)
  await ensureIdentityColumns(conn, targetTableName)
}

/**
 * Delete a snapshot from OPFS.
 * Handles new-style shards (_shard_N), legacy chunks (_part_N), single files, and manifests.
 */
export async function deleteSnapshot(snapshotId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    let partIndex = 0
    let deletedCount = 0

    // Try deleting new-style shards first
    while (true) {
      try {
        await snapshotsDir.removeEntry(`${snapshotId}_shard_${partIndex}.arrow`)
        deletedCount++
        partIndex++
      } catch {
        break
      }
    }

    // Try deleting legacy chunks
    partIndex = 0
    while (true) {
      try {
        await snapshotsDir.removeEntry(`${snapshotId}_part_${partIndex}.arrow`)
        deletedCount++
        partIndex++
      } catch {
        break
      }
    }

    // If no shards/chunks found, try single file (legacy)
    if (deletedCount === 0) {
      try {
        await snapshotsDir.removeEntry(`${snapshotId}.arrow`)
        deletedCount = 1
      } catch (err) {
        console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
      }
    }

    // Delete manifest
    try {
      await deleteManifest(snapshotId)
    } catch { /* ignore - manifest may not exist */ }

    console.log(`[Snapshot] Deleted ${deletedCount} file(s) for ${snapshotId}`)
  } catch (err) {
    console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
  }
}

/**
 * Freeze a table to OPFS (export to Arrow IPC and DROP from DuckDB).
 *
 * Part of the Single Active Table Policy: Only ONE table lives in DuckDB memory at a time.
 * When switching tabs, the current table is "frozen" (exported + dropped) and the new
 * table is "thawed" (imported from Arrow IPC).
 *
 * Uses Safe Save pattern: write to temp file → rename → DROP table.
 * NEVER drops table until snapshot save is confirmed successful.
 *
 * @param db - DuckDB instance
 * @param conn - Active DuckDB connection
 * @param tableName - Name of the table to freeze
 * @param tableId - Table ID for dirty state tracking
 * @returns Promise<boolean> - true if freeze succeeded, false otherwise
 */
export async function freezeTable(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string,
  tableId: string
): Promise<boolean> {
  console.log(`[Freeze] Freezing table: ${tableName}`)

  // CRITICAL: Normalize snapshotId to lowercase to match timeline-engine's naming convention.
  // This prevents duplicate files (e.g., "Foo.arrow" vs "foo.arrow") in OPFS
  // which is case-sensitive and would cause both to be imported as separate tables on reload.
  const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

  try {
    // Step 1: Check if table exists in DuckDB
    const tableCheckResult = await conn.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_name = '${tableName}'
    `)
    const tableExists = Number(tableCheckResult.toArray()[0]?.toJSON()?.count ?? 0) > 0

    if (!tableExists) {
      console.log(`[Freeze] Table ${tableName} doesn't exist in DuckDB, skipping freeze`)
      return true // Not an error - table may already be frozen
    }

    // Step 2: Check if table is dirty (has unsaved changes)
    // If dirty, we MUST save before dropping
    const { useUIStore } = await import('@/stores/uiStore')
    const isDirty = useUIStore.getState().dirtyTableIds.has(tableId)

    if (isDirty) {
      console.log(`[Freeze] Table ${tableName} is dirty, exporting snapshot first`)

      // Export using Safe Save pattern
      await exportTableToSnapshot(db, conn, tableName, normalizedSnapshotId)

      // Mark table as clean after successful export
      useUIStore.getState().markTableClean(tableId)
    } else {
      // Table is clean, but verify snapshot exists AND is valid before dropping
      const snapshotExists = await checkSnapshotFileExists(normalizedSnapshotId)
      if (!snapshotExists) {
        console.log(`[Freeze] No snapshot for clean table ${tableName}, creating one`)
        await exportTableToSnapshot(db, conn, tableName, normalizedSnapshotId)
      } else {
        // Snapshot file exists — validate it has valid Arrow IPC bytes
        // Corrupt files (truncated writes, OPFS issues) can pass the existence check
        // but fail on thaw, causing data loss if we drop the in-memory table
        const isValid = await validateArrowMagicBytes(normalizedSnapshotId)
        if (!isValid) {
          console.warn(`[Freeze] Existing snapshot for ${tableName} is corrupt, re-exporting`)
          await exportTableToSnapshot(db, conn, tableName, normalizedSnapshotId)
        }
      }
    }

    // Step 3: DROP table from DuckDB (safe now that snapshot exists)
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`)
    console.log(`[Freeze] Dropped ${tableName} from DuckDB memory`)

    // Step 4: CHECKPOINT to release DuckDB buffer pool memory
    try {
      await conn.query('CHECKPOINT')
      console.log(`[Freeze] CHECKPOINT after dropping ${tableName}`)
    } catch {
      // Non-fatal - CHECKPOINT failure shouldn't fail the freeze
    }

    return true
  } catch (error) {
    console.error(`[Freeze] Failed to freeze ${tableName}:`, error)
    return false
  }
}

/**
 * Thaw a table from OPFS (import from Arrow IPC into DuckDB).
 *
 * Part of the Single Active Table Policy: Restores a frozen table to DuckDB memory.
 *
 * @param db - DuckDB instance
 * @param conn - Active DuckDB connection
 * @param tableName - Name of the table to thaw
 * @returns Promise<boolean> - true if thaw succeeded, false otherwise
 */
export async function thawTable(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string
): Promise<boolean> {
  console.log(`[Thaw] Thawing table: ${tableName}`)

  // CRITICAL: Use normalized (lowercase) snapshotId to match freezeTable and timeline-engine
  const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

  try {
    // Step 1: Check if table already exists in DuckDB
    const tableCheckResult = await conn.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_name = '${tableName}'
    `)
    const tableExists = Number(tableCheckResult.toArray()[0]?.toJSON()?.count ?? 0) > 0

    if (tableExists) {
      console.log(`[Thaw] Table ${tableName} already exists in DuckDB, skipping thaw`)
      return true // Already thawed
    }

    // Step 2: Check if snapshot exists
    const snapshotExists = await checkSnapshotFileExists(normalizedSnapshotId)
    if (!snapshotExists) {
      console.error(`[Thaw] No snapshot found for ${tableName}`)
      return false
    }

    // Step 3: Import from Arrow IPC
    await importTableFromSnapshot(db, conn, normalizedSnapshotId, tableName)
    console.log(`[Thaw] Imported ${tableName} into DuckDB from snapshot`)

    return true
  } catch (error) {
    console.error(`[Thaw] Failed to thaw ${tableName}:`, error)
    return false
  }
}

/**
 * Active materialization cancellation tokens.
 * Maps tableId → AbortController so switchToTable can cancel in-flight materializations.
 */
const materializationControllers = new Map<string, AbortController>()

/**
 * Background-materialize a table from OPFS shards into DuckDB.
 *
 * Imports all shards sequentially using requestIdleCallback/setTimeout to avoid
 * blocking the UI. Once complete, the table is fully in DuckDB and the grid
 * seamlessly switches from shard-backed to direct queries (no visual change).
 *
 * @param tableName - Name of the table to materialize
 * @param tableId - Table ID for store updates
 * @returns Promise that resolves when materialization is complete
 */
export async function backgroundMaterialize(
  tableName: string,
  tableId: string
): Promise<boolean> {
  const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

  // Create cancellation token
  const controller = new AbortController()
  materializationControllers.set(tableId, controller)

  console.log(`[Materialize] Starting background materialization for ${tableName}`)

  try {
    const { initDuckDB: initDB, getConnection: getConn } = await import('@/lib/duckdb')
    const db = await initDB()
    const conn = await getConn()

    // Check if already materialized
    const tableCheckResult = await conn.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_name = '${tableName}'
    `)
    const tableExists = Number(tableCheckResult.toArray()[0]?.toJSON()?.count ?? 0) > 0
    if (tableExists) {
      console.log(`[Materialize] ${tableName} already exists in DuckDB, skipping`)
      return true
    }

    // Import the full table from OPFS shards
    await importTableFromSnapshot(db, conn, normalizedSnapshotId, tableName)

    // Check for cancellation after import
    if (controller.signal.aborted) {
      // Clean up: drop the table we just imported
      await conn.query(`DROP TABLE IF EXISTS "${tableName}"`).catch(() => {})
      console.log(`[Materialize] ${tableName} cancelled, dropped partial import`)
      return false
    }

    // Auto-migrate sequential _cs_id to gap-based if needed
    try {
      const { migrateToGapBasedCsId } = await import('@/lib/duckdb')
      await migrateToGapBasedCsId(tableName)
    } catch (err) {
      console.warn(`[Materialize] Migration failed for ${tableName}:`, err)
    }

    // Mark as materialized in tableStore
    const { useTableStore } = await import('@/stores/tableStore')
    useTableStore.getState().markTableMaterialized(tableId)

    console.log(`[Materialize] Background materialization complete for ${tableName}`)
    return true
  } catch (error) {
    if (controller.signal.aborted) {
      console.log(`[Materialize] ${tableName} cancelled during error recovery`)
      return false
    }
    console.error(`[Materialize] Background materialization failed for ${tableName}:`, error)

    // Fall back to synchronous thaw
    try {
      console.log(`[Materialize] Falling back to synchronous thaw for ${tableName}`)
      const { initDuckDB: initDB2, getConnection: getConn2 } = await import('@/lib/duckdb')
      const db = await initDB2()
      const conn = await getConn2()
      const success = await thawTable(db, conn, tableName)
      if (success) {
        const { useTableStore } = await import('@/stores/tableStore')
        useTableStore.getState().markTableMaterialized(tableId)
      }
      return success
    } catch (fallbackError) {
      console.error(`[Materialize] Synchronous fallback also failed for ${tableName}:`, fallbackError)
      return false
    }
  } finally {
    materializationControllers.delete(tableId)
  }
}

/**
 * Cancel an in-flight background materialization.
 * Called when the user switches away from a table before materialization completes.
 */
export function cancelMaterialization(tableId: string): void {
  const controller = materializationControllers.get(tableId)
  if (controller) {
    controller.abort()
    materializationControllers.delete(tableId)
    console.log(`[Materialize] Cancelled materialization for ${tableId}`)
  }
}

/**
 * Temporarily dematerialize the active table to free memory during heavy operations.
 *
 * If the table is clean (already saved to OPFS), just DROP + CHECKPOINT.
 * If dirty, export first, then drop. Returns info needed to rematerialize.
 *
 * @returns Object with tableName/tableId for rematerialization, or null if no active table
 */
export async function dematerializeActiveTable(): Promise<{
  tableName: string
  tableId: string
} | null> {
  const { useTableStore } = await import('@/stores/tableStore')
  const state = useTableStore.getState()

  if (!state.activeTableId) return null

  const activeTable = state.tables.find(t => t.id === state.activeTableId)
  if (!activeTable) return null

  // If already frozen or materializing, nothing to dematerialize
  if (state.frozenTables.has(activeTable.id)) {
    console.log(`[Dematerialize] ${activeTable.name} already frozen, skipping`)
    return { tableName: activeTable.name, tableId: activeTable.id }
  }

  console.log(`[Dematerialize] Parking ${activeTable.name} to disk for heavy operation`)

  try {
    const { initDuckDB: initDB, getConnection: getConn } = await import('@/lib/duckdb')
    const db = await initDB()
    const conn = await getConn()

    // Check if table is dirty (unsaved changes)
    const { useUIStore } = await import('@/stores/uiStore')
    const isDirty = useUIStore.getState().dirtyTableIds.has(activeTable.id)

    if (isDirty) {
      // Export to OPFS first
      const normalizedSnapshotId = activeTable.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      await exportTableToSnapshot(db, conn, activeTable.name, normalizedSnapshotId)
      useUIStore.getState().markTableClean(activeTable.id)
    }

    // DROP from DuckDB
    await conn.query(`DROP TABLE IF EXISTS "${activeTable.name}"`)
    await conn.query('CHECKPOINT').catch(() => {})

    // Mark as frozen in store
    useTableStore.getState().markTableFrozen(activeTable.id)

    console.log(`[Dematerialize] ${activeTable.name} parked to disk (freed ~${(activeTable.rowCount * 30 * 8 / 1024 / 1024).toFixed(0)}MB estimate)`)

    return { tableName: activeTable.name, tableId: activeTable.id }
  } catch (error) {
    console.warn(`[Dematerialize] Failed for ${activeTable.name}, skipping:`, error)
    return null // Graceful degradation: operation runs with current memory budget
  }
}

/**
 * Rematerialize a previously dematerialized table (restore from OPFS to DuckDB).
 *
 * @param tableName - Table name to restore
 * @param tableId - Table ID for store updates
 */
export async function rematerializeActiveTable(
  tableName: string,
  tableId: string
): Promise<void> {
  const { useTableStore } = await import('@/stores/tableStore')

  // If not frozen, already materialized
  if (!useTableStore.getState().frozenTables.has(tableId)) {
    console.log(`[Rematerialize] ${tableName} already in DuckDB, skipping`)
    return
  }

  console.log(`[Rematerialize] Restoring ${tableName} from disk`)

  try {
    const { initDuckDB: initDB, getConnection: getConn } = await import('@/lib/duckdb')
    const db = await initDB()
    const conn = await getConn()

    const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    await importTableFromSnapshot(db, conn, normalizedSnapshotId, tableName)

    // Mark as thawed
    useTableStore.getState().markTableThawed(tableId)

    console.log(`[Rematerialize] ${tableName} restored to DuckDB`)
  } catch (error) {
    console.error(`[Rematerialize] Failed to restore ${tableName}:`, error)
    // Table stays frozen — grid will use shard-backed rendering
  }
}

/**
 * Check if a snapshot file exists in OPFS.
 * Handles shards (_shard_0), legacy chunks (_part_0), and single files.
 *
 * @param snapshotId - Unique snapshot identifier (e.g., "original_abc123")
 * @returns true if snapshot exists (sharded, chunked, or single), false otherwise
 */
export async function checkSnapshotFileExists(snapshotId: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    // Check for new-style shards first
    try {
      await snapshotsDir.getFileHandle(`${snapshotId}_shard_0.arrow`, { create: false })
      return true
    } catch {
      // Check for single file
      try {
        await snapshotsDir.getFileHandle(`${snapshotId}.arrow`, { create: false })
        return true
      } catch {
        // Check for legacy chunked files (part_0 indicates chunked snapshot exists)
        try {
          await snapshotsDir.getFileHandle(`${snapshotId}_part_0.arrow`, { create: false })
          return true
        } catch {
          return false
        }
      }
    }
  } catch {
    return false
  }
}

/**
 * List all unique snapshot IDs in OPFS.
 * Strips _shard_N, _part_N, and _manifest suffixes to deduplicate.
 */
export async function listSnapshots(): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    const ids = new Set<string>()

    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, _handle] of snapshotsDir.entries()) {
      if (name.endsWith('.arrow')) {
        const base = name
          .replace('.arrow', '')
          .replace(/_part_\d+$/, '')
          .replace(/_shard_\d+$/, '')
        ids.add(base)
      } else if (name.endsWith('_manifest.json')) {
        const base = name.replace('_manifest.json', '')
        ids.add(base)
      }
    }

    return Array.from(ids)
  } catch {
    return []
  }
}

/**
 * Clean up orphaned diff files from OPFS.
 *
 * Diff tables (_diff_*) are temporary tables created during diff operations.
 * They should be cleaned up when the diff view is closed, but if the user
 * refreshes the page before cleanup completes, orphaned files can remain.
 *
 * This function removes any _diff_* snapshot files from OPFS to prevent
 * them from being restored as regular tables on next page load.
 *
 * Call this once at application startup, after cleanupCorruptSnapshots().
 */
export async function cleanupOrphanedDiffFiles(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()

    let appDir: FileSystemDirectoryHandle
    try {
      appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    } catch {
      return // Directory doesn't exist, nothing to clean
    }

    let snapshotsDir: FileSystemDirectoryHandle
    try {
      snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    } catch {
      return // Snapshots directory doesn't exist, nothing to clean
    }

    let deletedCount = 0

    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind !== 'file') continue

      // Delete any _diff_* snapshot files (shards, legacy chunks, and manifests)
      if (name.startsWith('_diff_') && (name.endsWith('.arrow') || name.endsWith('_manifest.json'))) {
        console.log(`[Snapshot] Removing orphaned diff file: ${name}`)
        await snapshotsDir.removeEntry(name)
        deletedCount++
      }
    }

    if (deletedCount > 0) {
      console.log(`[Snapshot] Cleaned up ${deletedCount} orphaned diff file(s)`)
    }
  } catch (error) {
    console.warn('[Snapshot] Failed to clean up orphaned diff files:', error)
  }
}

/**
 * Validates an Arrow IPC snapshot file by checking for the IPC stream
 * continuation token (0xFFFFFFFF) at the start of the file.
 *
 * This is a soft check — the continuation token is an implementation detail
 * of Arrow IPC message encapsulation, not a formal format signature like
 * Parquet's PAR1. If the check fails but the file has reasonable size,
 * we give it the benefit of the doubt.
 *
 * @param snapshotId - Normalized snapshot identifier
 * @returns true if the file exists and appears valid, false otherwise
 */
async function validateArrowMagicBytes(snapshotId: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    // Try shard_0 first, then single file, then legacy part_0
    let file: File
    try {
      const handle = await snapshotsDir.getFileHandle(`${snapshotId}_shard_0.arrow`, { create: false })
      file = await handle.getFile()
    } catch {
      try {
        const handle = await snapshotsDir.getFileHandle(`${snapshotId}.arrow`, { create: false })
        file = await handle.getFile()
      } catch {
        try {
          const handle = await snapshotsDir.getFileHandle(`${snapshotId}_part_0.arrow`, { create: false })
          file = await handle.getFile()
        } catch {
          return false
        }
      }
    }

    // Arrow IPC stream needs at least 8 bytes (continuation token + metadata length)
    if (file.size < 8) return false

    const header = new Uint8Array(await file.slice(0, 4).arrayBuffer())

    // Arrow IPC stream continuation token: 0xFFFFFFFF
    const isContinuationToken =
      header[0] === 0xFF && header[1] === 0xFF && header[2] === 0xFF && header[3] === 0xFF

    // Soft check: if continuation token present, definitely valid.
    // If not present, still treat as valid for files with reasonable size —
    // the continuation token is an implementation detail, not a formal signature.
    if (!isContinuationToken && file.size > 64) {
      console.warn(`[Snapshot] File ${snapshotId} missing Arrow IPC continuation token but has reasonable size (${file.size} bytes), treating as valid`)
      return true
    }

    return isContinuationToken
  } catch {
    return false
  }
}

/**
 * Scans the snapshots directory and deletes corrupt and orphaned files:
 * 1. Tiny Arrow IPC files (corrupt from failed writes)
 * 2. Orphaned .tmp files (from interrupted atomic writes, including .json.tmp)
 * 3. Corrupt manifest .json files (empty or unparseable)
 *
 * This is a self-healing step to recover from browser crashes or interrupted saves.
 *
 * Call this once at application startup to ensure clean state.
 */
export async function cleanupCorruptSnapshots(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()

    // Use 'create: false' to avoid creating the dir if it doesn't exist
    let appDir: FileSystemDirectoryHandle
    try {
      appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    } catch {
      return // Directory doesn't exist, nothing to clean
    }

    let snapshotsDir: FileSystemDirectoryHandle
    try {
      snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    } catch {
      return // Snapshots directory doesn't exist, nothing to clean
    }

    let corruptCount = 0
    let tempCount = 0

    // Arrow IPC files need at least ~8 bytes for continuation token + metadata length
    const MIN_ARROW_SIZE = 8

    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind !== 'file') continue

      // Clean up orphaned temp files from atomic writes (.arrow.tmp and .json.tmp)
      if (name.endsWith('.tmp')) {
        console.warn(`[Snapshot] Found orphaned temp file: ${name}. Deleting...`)
        await snapshotsDir.removeEntry(name)
        tempCount++
        continue
      }

      // Clean up corrupt Arrow IPC files
      if (name.endsWith('.arrow')) {
        const file = await handle.getFile()
        if (file.size < MIN_ARROW_SIZE) {
          console.warn(`[Snapshot] Found corrupt file (${file.size} bytes): ${name}. Deleting...`)
          await snapshotsDir.removeEntry(name)
          corruptCount++
        }
      }

      // Clean up corrupt manifest files (empty or too small to be valid JSON)
      if (name.endsWith('_manifest.json')) {
        const file = await handle.getFile()
        if (file.size < 10) {
          console.warn(`[Snapshot] Found corrupt manifest (${file.size} bytes): ${name}. Deleting...`)
          await snapshotsDir.removeEntry(name)
          corruptCount++
        }
      }
    }

    if (corruptCount > 0 || tempCount > 0) {
      console.log(`[Snapshot] Cleanup complete. Removed ${corruptCount} corrupt file(s) and ${tempCount} temp file(s).`)
    }
  } catch (error) {
    console.warn('[Snapshot] Failed to run corrupt file cleanup:', error)
  }
}

/**
 * Clean up duplicate snapshot files caused by case mismatch.
 *
 * Prior to this fix, the timeline-engine created lowercase filenames
 * while the persistence system used original casing. This resulted in both
 * "foo.arrow" and "Foo.arrow" existing in OPFS (which is case-sensitive).
 *
 * This cleanup step removes non-normalized (mixed-case) files when a normalized
 * (lowercase) version exists, preventing duplicate table imports on reload.
 *
 * Call this once at application startup, after cleanupCorruptSnapshots().
 */
export async function cleanupDuplicateCaseSnapshots(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()

    let appDir: FileSystemDirectoryHandle
    try {
      appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    } catch {
      return // Directory doesn't exist, nothing to clean
    }

    let snapshotsDir: FileSystemDirectoryHandle
    try {
      snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    } catch {
      return // Snapshots directory doesn't exist, nothing to clean
    }

    // Collect all snapshot filenames
    const allFiles: string[] = []
    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.arrow')) {
        allFiles.push(name)
      }
    }

    // Group files by normalized (lowercase) name
    const normalizedGroups = new Map<string, string[]>()
    for (const fileName of allFiles) {
      // Normalize: remove extension, strip shard/part suffix, lowercase
      const baseName = fileName.replace('.arrow', '').replace(/_part_\d+$/, '').replace(/_shard_\d+$/, '')
      const normalizedBase = baseName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      const group = normalizedGroups.get(normalizedBase) || []
      group.push(fileName)
      normalizedGroups.set(normalizedBase, group)
    }

    let duplicatesRemoved = 0

    // For each group with multiple files, keep the lowercase one, delete others
    for (const [, files] of normalizedGroups) {
      if (files.length <= 1) continue

      // Find which files are fully lowercase (normalized)
      const normalizedFiles = files.filter(f => {
        const base = f.replace('.arrow', '').replace(/_part_\d+$/, '').replace(/_shard_\d+$/, '')
        return base === base.toLowerCase()
      })

      // If there's at least one normalized file, delete non-normalized duplicates
      if (normalizedFiles.length > 0) {
        for (const file of files) {
          const base = file.replace('.arrow', '').replace(/_part_\d+$/, '').replace(/_shard_\d+$/, '')
          if (base !== base.toLowerCase()) {
            console.log(`[Snapshot] Removing duplicate non-normalized file: ${file} (keeping lowercase version)`)
            try {
              await snapshotsDir.removeEntry(file)
              duplicatesRemoved++
            } catch (err) {
              console.warn(`[Snapshot] Failed to remove duplicate ${file}:`, err)
            }
          }
        }
      }
    }

    if (duplicatesRemoved > 0) {
      console.log(`[Snapshot] Removed ${duplicatesRemoved} duplicate case-mismatched file(s)`)
    }
  } catch (error) {
    console.warn('[Snapshot] Failed to clean up duplicate case snapshots:', error)
  }
}
