/**
 * OPFS Parquet Snapshot Storage
 *
 * Provides cold storage for large table snapshots using Parquet compression.
 * Reduces RAM usage from ~1.5GB (in-memory table) to ~5MB (compressed file).
 *
 * CRITICAL: DuckDB-WASM creates Parquet files in-memory, not via registered file handles.
 * Pattern: COPY TO → copyFileToBuffer() → write to OPFS → dropFile()
 * See: https://github.com/duckdb/duckdb-wasm/discussions/1714
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import * as duckdb from '@duckdb/duckdb-wasm'
import { CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN, initDuckDB } from '@/lib/duckdb'
import { deleteFileIfExists } from './opfs-helpers'

/**
 * Cooperative yield to browser main thread.
 * Uses scheduler.yield() when available (Chrome 115+) for priority-aware scheduling,
 * falls back to setTimeout(0) for older browsers.
 *
 * This prevents UI freezing during Parquet export by allowing the browser
 * to handle pending user input (scrolls, clicks) between chunks.
 *
 * @see https://developer.chrome.com/blog/use-scheduler-yield
 */
async function yieldToMain(): Promise<void> {
  // Check for scheduler.yield() support (Chrome 115+, Firefox 129+)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheduler = (globalThis as any).scheduler
  if (scheduler && typeof scheduler.yield === 'function') {
    await scheduler.yield()
  } else {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/**
 * File-level write locks to prevent concurrent OPFS writes to the same file.
 * OPFS doesn't allow multiple writable streams on the same file.
 * This Map tracks ongoing write operations by file name.
 */
const writeLocksInProgress = new Map<string, Promise<void>>()

/**
 * Global export queue - ensures only ONE Parquet export runs at a time.
 *
 * DuckDB's COPY TO operation creates large in-memory buffers (~500MB for 1M rows).
 * When multiple exports run concurrently (e.g., persistence save + step snapshot),
 * RAM spikes to 4GB+. By serializing exports, peak RAM stays under 2.5GB.
 *
 * This is separate from writeLocksInProgress which prevents concurrent writes
 * to the SAME file. This queue prevents concurrent COPY TO operations globally.
 */
let globalExportChain: Promise<void> = Promise.resolve()

/**
 * Execute a function with global export serialization.
 * Only one COPY TO operation can run at a time across the entire app.
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
 * Tables from older Parquet snapshots may be missing these columns.
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
    selectParts.push(`ROW_NUMBER() OVER () as "${CS_ID_COLUMN}"`)
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
 * Ensure the snapshots directory exists in OPFS
 * Must be called before first Parquet export to avoid DuckDB errors
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
 * Detect the correct ORDER BY column for deterministic export
 * Diff tables use sort_key (preserves original row order)
 * Regular tables use _cs_id
 * Uses raw connection to avoid mutex reentrancy (caller holds mutex)
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
 * Options for Parquet export operations
 */
export interface ExportOptions {
  /**
   * Callback for chunk progress during large (>250k row) exports.
   * Called after each chunk is written with current/total progress.
   */
  onChunkProgress?: (current: number, total: number, tableName: string) => void
}

/**
 * Export a table to Parquet file in OPFS
 *
 * CRITICAL MEMORY SAFETY: Uses in-memory buffer pattern with chunking.
 * - `COPY TO` creates in-memory virtual file in DuckDB-WASM
 * - `copyFileToBuffer()` retrieves buffer from WASM heap → JS heap (~50MB per chunk)
 * - Write buffer to OPFS using File System Access API
 * - `dropFile()` cleans up virtual file
 *
 * For tables >250k rows, uses chunked files to prevent JS heap OOM crashes.
 * Each chunk is ~50MB compressed, written separately, and buffer is GC'd immediately.
 *
 * @param db - DuckDB instance (for copyFileToBuffer/dropFile)
 * @param conn - Active DuckDB connection (for COPY TO)
 * @param tableName - Source table to export
 * @param snapshotId - Unique snapshot identifier (e.g., "snapshot_abc_1234567890")
 * @param options - Optional export options (chunk progress callback)
 *
 * Performance: ~2-3 seconds for 1M rows (includes compression + OPFS write)
 */
export async function exportTableToParquet(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string,
  options?: ExportOptions
): Promise<void> {
  // Use global export queue to serialize COPY TO operations (prevents RAM spikes)
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

    // CRITICAL: Always chunk for tables >250k rows to prevent JS heap OOM
    // copyFileToBuffer() copies data to JS heap, so we must limit buffer size
    // Uses atomic write pattern per chunk: write to .tmp file, then rename on success
    const CHUNK_THRESHOLD = 250_000
    if (rowCount > CHUNK_THRESHOLD) {
      console.log('[Snapshot] Using chunked Parquet export for large table')

      const batchSize = CHUNK_THRESHOLD
      const totalChunks = Math.ceil(rowCount / batchSize)
      let offset = 0
      let partIndex = 0

      // Track completed chunks for cleanup on failure
      const completedChunks: string[] = []

      try {
        while (offset < rowCount) {
          const duckdbTempFile = `duckdb_temp_${snapshotId}_part_${partIndex}.parquet`
          const opfsTempFile = `${snapshotId}_part_${partIndex}.parquet.tmp`
          const finalFileName = `${snapshotId}_part_${partIndex}.parquet`

          // 1. COPY TO in-memory file (DuckDB WASM memory)
          // CRITICAL: ORDER BY ensures deterministic row ordering across chunks
          const orderByCol = await getOrderByColumn(conn, tableName)
          const orderByClause = orderByCol ? `ORDER BY "${orderByCol}"` : ''

          await conn.query(`
            COPY (
              SELECT * FROM "${tableName}"
              ${orderByClause}
              LIMIT ${batchSize} OFFSET ${offset}
            ) TO '${duckdbTempFile}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
          `)

          // 2. Retrieve buffer from WASM memory → JS heap (~50MB compressed)
          let buffer: Uint8Array | null = await db.copyFileToBuffer(duckdbTempFile)

          // 3. Write to OPFS temp file (atomic step 1)
          const tempHandle = await snapshotsDir.getFileHandle(opfsTempFile, { create: true })
          const writable = await createWritableWithRetry(tempHandle)
          await writable.write(buffer)
          await writable.close()

          // Explicit buffer release to help GC reclaim memory faster
          buffer = null

          // CRITICAL: Small delay to ensure file handle is fully released
          await new Promise(resolve => setTimeout(resolve, 20))

          // Verify temp file was written
          const tempFile = await tempHandle.getFile()
          if (tempFile.size === 0) {
            throw new Error(`[Snapshot] Failed to write temp chunk ${opfsTempFile} - file is 0 bytes`)
          }

          // 4. Atomic rename: temp → final (atomic step 2)
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

          // 5. Cleanup: delete temp files
          await deleteFileIfExists(snapshotsDir, opfsTempFile)
          await db.dropFile(duckdbTempFile)

          completedChunks.push(finalFileName)
          offset += batchSize
          partIndex++
          console.log(`[Snapshot] Exported chunk ${partIndex}: ${Math.min(offset, rowCount).toLocaleString()}/${rowCount.toLocaleString()} rows`)

          // Report chunk progress via callback (for UI status bar)
          if (options?.onChunkProgress) {
            options.onChunkProgress(partIndex, totalChunks, tableName)
          }

          // Yield to browser between chunks to prevent UI freezing during large exports
          await yieldToMain()
        }

        // Clear chunk progress when done
        if (options?.onChunkProgress) {
          options.onChunkProgress(totalChunks, totalChunks, tableName)
        }

        console.log(`[Snapshot] Exported ${partIndex} chunks to ${snapshotId}_part_*.parquet`)
      } catch (error) {
        // Cleanup any temp files on failure (completed chunks are valid and kept)
        for (let i = 0; i <= partIndex; i++) {
          await deleteFileIfExists(snapshotsDir, `${snapshotId}_part_${i}.parquet.tmp`)
          try {
            await db.dropFile(`duckdb_temp_${snapshotId}_part_${i}.parquet`)
          } catch {
            // Ignore cleanup errors
          }
        }
        throw error
      }
  } else {
    // Single file export (ONLY safe for tables ≤250k rows)
    // Uses atomic write pattern: write to .tmp file, then rename on success
    const duckdbTempFile = `duckdb_temp_${snapshotId}.parquet`
    const opfsTempFile = `${snapshotId}.parquet.tmp`
    const finalFileName = `${snapshotId}.parquet`

    try {
      // 1. COPY TO in-memory file (DuckDB WASM memory)
      // Detect correct ORDER BY column for this table (handles diff tables with row_id)
      const orderByCol = await getOrderByColumn(conn, tableName)
      const orderByClause = orderByCol ? `ORDER BY "${orderByCol}"` : ''

      await conn.query(`
        COPY (
          SELECT * FROM "${tableName}"
          ${orderByClause}
        ) TO '${duckdbTempFile}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
      `)

      // 2. Retrieve buffer from WASM → JS heap (safe: <50MB)
      let buffer: Uint8Array | null = await db.copyFileToBuffer(duckdbTempFile)

      // 3. Write to OPFS temp file (atomic step 1: write to temp)
      const tempHandle = await snapshotsDir.getFileHandle(opfsTempFile, { create: true })
      const writable = await createWritableWithRetry(tempHandle)
      await writable.write(buffer)
      await writable.close()

      // Explicit buffer release to help GC reclaim memory faster
      buffer = null

      // CRITICAL: Small delay to ensure file handle is fully released
      await new Promise(resolve => setTimeout(resolve, 20))

      // Verify temp file was written
      const tempFile = await tempHandle.getFile()
      if (tempFile.size === 0) {
        throw new Error(`[Snapshot] Failed to write temp file ${opfsTempFile} - file is 0 bytes`)
      }

      // 4. Atomic rename: temp → final (atomic step 2)
      // Delete existing final file first (if any), then rename
      await deleteFileIfExists(snapshotsDir, finalFileName)
      const finalHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
      const finalWritable = await finalHandle.createWritable()
      const tempContent = await tempFile.arrayBuffer()
      await finalWritable.write(tempContent)
      await finalWritable.close()

      // Delay to ensure file handle is released
      await new Promise(resolve => setTimeout(resolve, 20))

      // Verify final file was written
      const file = await finalHandle.getFile()
      if (file.size === 0) {
        throw new Error(`[Snapshot] Failed to write ${finalFileName} - file is 0 bytes`)
      }
      console.log(`[Snapshot] Wrote ${(file.size / 1024 / 1024).toFixed(2)} MB to ${finalFileName}`)

      // 5. Cleanup: delete temp file and DuckDB virtual file
      await deleteFileIfExists(snapshotsDir, opfsTempFile)
      await db.dropFile(duckdbTempFile)

      console.log(`[Snapshot] Exported to ${finalFileName}`)
    } catch (error) {
      // Cleanup orphaned temp files on failure
      await deleteFileIfExists(snapshotsDir, opfsTempFile)
      try {
        await db.dropFile(duckdbTempFile)
      } catch {
        // Ignore cleanup errors
      }
      throw error
    }
  }

    // CHECKPOINT after large exports to release DuckDB buffer pool
    // This helps reclaim ~200-500MB of WASM memory after COPY TO operations
    if (rowCount > 100_000) {
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
 * Helper to register a file with retry and memory fallback
 * OPFS file handles can have locking issues - this provides resilience
 *
 * Exported for use by diff-engine.ts to handle the same file handle conflicts.
 */
export async function registerFileWithRetry(
  db: AsyncDuckDB,
  fileHandle: FileSystemFileHandle,
  fileName: string,
  maxRetries = 5
): Promise<'handle' | 'buffer'> {
  // Try file handle registration first (zero-copy, preferred)
  // Uses longer backoff (200ms base) to allow concurrent exports to finish
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await db.registerFileHandle(
        fileName,
        fileHandle,
        duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
        false // read-only
      )
      return 'handle'
    } catch (err) {
      const isLockError = String(err).includes('Access Handle')
      if (!isLockError || attempt === maxRetries) {
        // Not a lock error or last attempt - fall back to buffer
        console.warn(`[Snapshot] File handle registration failed for ${fileName} (attempt ${attempt}/${maxRetries}), using buffer fallback`)
        break
      }
      // Wait before retry (exponential backoff: 200ms, 400ms, 800ms, 1600ms)
      await new Promise(resolve => setTimeout(resolve, 200 * Math.pow(2, attempt - 1)))
    }
  }

  // CRITICAL: Drop any stale/partial file registration before buffer fallback
  // A failed registerFileHandle may leave a virtual file entry in DuckDB.
  // Without cleanup, registerFileBuffer creates a second entry for the same name,
  // causing TProtocolException when read_parquet glob reads the stale entry.
  try {
    await db.dropFile(fileName)
  } catch {
    // Ignore - file may not be registered
  }

  // Fallback: Read file into memory buffer
  // This avoids OPFS locking issues but uses more memory
  const file = await fileHandle.getFile()
  const buffer = await file.arrayBuffer()
  await db.registerFileBuffer(fileName, new Uint8Array(buffer))
  return 'buffer'
}

/**
 * Import a table from Parquet file in OPFS
 *
 * Uses DuckDB's file handle registration for zero-copy reads when possible.
 * Falls back to memory buffer if file handle registration fails (OPFS lock conflicts).
 *
 * Handles both chunked files (for large tables) and single files (for small tables).
 *
 * @param db - DuckDB instance (for file registration)
 * @param conn - Active DuckDB connection (for transaction consistency)
 * @param snapshotId - Unique snapshot identifier
 * @param targetTableName - Name for the restored table
 *
 * Performance: ~2-5 seconds for 1M rows (includes decompression)
 */
export async function importTableFromParquet(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  snapshotId: string,
  targetTableName: string
): Promise<void> {
  console.log(`[Snapshot] Importing from ${snapshotId}...`)

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  // Check if this is a chunked snapshot (multiple _part_N files) or single file
  let isChunked = false
  try {
    await snapshotsDir.getFileHandle(`${snapshotId}_part_0.parquet`, { create: false })
    isChunked = true
  } catch {
    // Not chunked, try single file
    isChunked = false
  }

  if (isChunked) {
    // Register all chunk files
    let partIndex = 0

    while (true) {
      try {
        const fileName = `${snapshotId}_part_${partIndex}.parquet`
        const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })

        await registerFileWithRetry(db, fileHandle, fileName)

        partIndex++
      } catch {
        break // No more chunks
      }
    }

    // Read all chunks with glob pattern
    // NOTE: Do NOT add ORDER BY here - it can cause non-stable re-sorting
    // Rely on preserve_insertion_order (default: true) to maintain Parquet file order
    // The export already wrote rows in _cs_id order
    await conn.query(`
      CREATE OR REPLACE TABLE "${targetTableName}" AS
      SELECT * FROM read_parquet('${snapshotId}_part_*.parquet')
    `)

    console.log(`[Snapshot] Restored ${targetTableName} from ${partIndex} chunks`)

    // Unregister all file handles
    for (let i = 0; i < partIndex; i++) {
      await db.dropFile(`${snapshotId}_part_${i}.parquet`)
    }
  } else {
    // Single file import (existing behavior)
    const fileName = `${snapshotId}.parquet`
    const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })

    await registerFileWithRetry(db, fileHandle, fileName)

    // NOTE: Do NOT add ORDER BY here - it can cause non-stable re-sorting
    // Rely on preserve_insertion_order (default: true) to maintain Parquet file order
    // The export already wrote rows in _cs_id order
    await conn.query(`
      CREATE OR REPLACE TABLE "${targetTableName}" AS
      SELECT * FROM read_parquet('${fileName}')
    `)

    console.log(`[Snapshot] Restored ${targetTableName} from single file`)

    await db.dropFile(fileName)
  }

  // Ensure identity columns exist (for snapshots from older versions)
  await ensureIdentityColumns(conn, targetTableName)
}

/**
 * Delete a Parquet snapshot from OPFS
 *
 * Uses File System Access API to directly remove file.
 * Handles both chunked files and single files.
 */
export async function deleteParquetSnapshot(snapshotId: string): Promise<void> {
  try {
    // CRITICAL: Unregister files from DuckDB BEFORE deleting from OPFS
    // Without this, the file lock prevents deletion (NoModificationAllowedError)
    // This fixes: deleting a table and re-importing leaves stale original snapshot
    try {
      const db = await initDuckDB()

      // Try to unregister single file
      try {
        await db.dropFile(`${snapshotId}.parquet`)
      } catch {
        // Ignore - file might not be registered
      }

      // Try to unregister chunked files
      let chunkIndex = 0
      while (chunkIndex < 100) { // Safety limit
        try {
          await db.dropFile(`${snapshotId}_part_${chunkIndex}.parquet`)
          chunkIndex++
        } catch {
          break // No more chunks
        }
      }

      if (chunkIndex > 0) {
        console.log(`[Snapshot] Unregistered ${chunkIndex} chunk(s) from DuckDB for ${snapshotId}`)
      }
    } catch (err) {
      // DuckDB not initialized or other error - proceed with OPFS deletion anyway
      console.log(`[Snapshot] Could not unregister from DuckDB (non-fatal):`, err)
    }

    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    // Delete all chunk files (if chunked) or single file
    let partIndex = 0
    let deletedCount = 0

    // Try deleting chunks first
    while (true) {
      try {
        const fileName = `${snapshotId}_part_${partIndex}.parquet`
        await snapshotsDir.removeEntry(fileName)
        deletedCount++
        partIndex++
      } catch {
        break // No more chunks
      }
    }

    // If no chunks found, try single file
    if (deletedCount === 0) {
      try {
        await snapshotsDir.removeEntry(`${snapshotId}.parquet`)
        deletedCount = 1
      } catch (err) {
        console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
      }
    }

    console.log(`[Snapshot] Deleted ${deletedCount} file(s) for ${snapshotId}`)
  } catch (err) {
    console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
  }
}

/**
 * Freeze a table to OPFS (export to Parquet and DROP from DuckDB).
 *
 * Part of the Single Active Table Policy: Only ONE table lives in DuckDB memory at a time.
 * When switching tabs, the current table is "frozen" (exported + dropped) and the new
 * table is "thawed" (imported from Parquet).
 *
 * Uses Safe Save pattern: write to temp file → rename → DROP table.
 * NEVER drops table until Parquet save is confirmed successful.
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
  // This prevents duplicate Parquet files (e.g., "Foo.parquet" vs "foo.parquet") in OPFS
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
    // If dirty, we MUST save to Parquet before dropping
    const { useUIStore } = await import('@/stores/uiStore')
    const isDirty = useUIStore.getState().dirtyTableIds.has(tableId)

    if (isDirty) {
      console.log(`[Freeze] Table ${tableName} is dirty, exporting to Parquet first`)

      // Export to Parquet using Safe Save pattern
      // This writes to temp file → renames → confirms success
      await exportTableToParquet(db, conn, tableName, normalizedSnapshotId)

      // Mark table as clean after successful export
      useUIStore.getState().markTableClean(tableId)
    } else {
      // Table is clean, but verify Parquet exists before dropping
      const snapshotExists = await checkSnapshotFileExists(normalizedSnapshotId)
      if (!snapshotExists) {
        console.log(`[Freeze] No Parquet snapshot for clean table ${tableName}, creating one`)
        await exportTableToParquet(db, conn, tableName, normalizedSnapshotId)
      }
    }

    // Step 3: DROP table from DuckDB (safe now that Parquet exists)
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
 * Thaw a table from OPFS (import from Parquet into DuckDB).
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

    // Step 2: Check if Parquet snapshot exists
    const snapshotExists = await checkSnapshotFileExists(normalizedSnapshotId)
    if (!snapshotExists) {
      console.error(`[Thaw] No Parquet snapshot found for ${tableName}`)
      return false
    }

    // Step 3: Import from Parquet
    await importTableFromParquet(db, conn, normalizedSnapshotId, tableName)
    console.log(`[Thaw] Imported ${tableName} into DuckDB from Parquet`)

    return true
  } catch (error) {
    console.error(`[Thaw] Failed to thaw ${tableName}:`, error)
    return false
  }
}

/**
 * Check if a Parquet snapshot file exists in OPFS
 * Handles both single files and chunked files
 *
 * @param snapshotId - Unique snapshot identifier (e.g., "original_abc123")
 * @returns true if snapshot exists (single or chunked), false otherwise
 */
export async function checkSnapshotFileExists(snapshotId: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    // Check for single file
    try {
      await snapshotsDir.getFileHandle(`${snapshotId}.parquet`, { create: false })
      return true
    } catch {
      // Check for chunked files (part_0 indicates chunked snapshot exists)
      try {
        await snapshotsDir.getFileHandle(`${snapshotId}_part_0.parquet`, { create: false })
        return true
      } catch {
        return false
      }
    }
  } catch {
    return false
  }
}

/**
 * List all Parquet snapshots in OPFS
 */
export async function listParquetSnapshots(): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    const entries: string[] = []

    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, _handle] of snapshotsDir.entries()) {
      if (name.endsWith('.parquet')) {
        entries.push(name.replace('.parquet', ''))
      }
    }

    return entries
  } catch {
    return []
  }
}

/**
 * Clean up orphaned diff files from OPFS
 *
 * Diff tables (_diff_*) are temporary tables created during diff operations.
 * They should be cleaned up when the diff view is closed, but if the user
 * refreshes the page before cleanup completes, orphaned files can remain.
 *
 * This function removes any _diff_* Parquet files from OPFS to prevent
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

      // Delete any _diff_* Parquet files (including chunked _diff_*_part_N.parquet)
      if (name.startsWith('_diff_') && name.endsWith('.parquet')) {
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
 * Scans the snapshots directory and deletes corrupt and orphaned files:
 * 1. 0-byte Parquet files (corrupt from failed writes)
 * 2. Orphaned .tmp files (from interrupted atomic writes)
 *
 * This is a self-healing step to recover from browser crashes or interrupted saves.
 *
 * Common causes of corrupt/orphaned files:
 * - Browser crash during Parquet export
 * - OPFS permission denied mid-write
 * - Out of disk quota during write
 * - User closed tab during save
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

    // Iterate over all files in the snapshots directory
    // Parquet files need at least ~200 bytes for magic bytes + minimal schema
    const MIN_PARQUET_SIZE = 200

    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind !== 'file') continue

      // Clean up orphaned temp files from atomic writes
      if (name.endsWith('.tmp')) {
        console.warn(`[Snapshot] Found orphaned temp file: ${name}. Deleting...`)
        await snapshotsDir.removeEntry(name)
        tempCount++
        continue
      }

      // Clean up corrupt Parquet files
      if (name.endsWith('.parquet')) {
        const file = await handle.getFile()
        if (file.size < MIN_PARQUET_SIZE) {
          console.warn(`[Snapshot] Found corrupt file (${file.size} bytes): ${name}. Deleting...`)
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
 * Clean up duplicate Parquet files caused by case mismatch.
 *
 * Prior to this fix, the timeline-engine created lowercase Parquet filenames
 * while the persistence system used original casing. This resulted in both
 * "foo.parquet" and "Foo.parquet" existing in OPFS (which is case-sensitive).
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

    // Collect all Parquet filenames
    const allFiles: string[] = []
    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.parquet')) {
        allFiles.push(name)
      }
    }

    // Group files by normalized (lowercase) name
    const normalizedGroups = new Map<string, string[]>()
    for (const fileName of allFiles) {
      // Normalize: remove extension, lowercase, re-add extension
      const baseName = fileName.replace('.parquet', '').replace(/_part_\d+$/, '')
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
        const base = f.replace('.parquet', '').replace(/_part_\d+$/, '')
        return base === base.toLowerCase()
      })

      // If there's at least one normalized file, delete non-normalized duplicates
      if (normalizedFiles.length > 0) {
        for (const file of files) {
          const base = file.replace('.parquet', '').replace(/_part_\d+$/, '')
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
