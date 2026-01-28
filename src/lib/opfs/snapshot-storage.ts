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
import { CS_ID_COLUMN } from '@/lib/duckdb'

/**
 * File-level write locks to prevent concurrent OPFS writes to the same file.
 * OPFS doesn't allow multiple writable streams on the same file.
 * This Map tracks ongoing write operations by file name.
 */
const writeLocksInProgress = new Map<string, Promise<void>>()

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
 *
 * Performance: ~2-3 seconds for 1M rows (includes compression + OPFS write)
 */
export async function exportTableToParquet(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string
): Promise<void> {
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
  const CHUNK_THRESHOLD = 250_000
  if (rowCount > CHUNK_THRESHOLD) {
    console.log('[Snapshot] Using chunked Parquet export for large table')

    const batchSize = CHUNK_THRESHOLD
    let offset = 0
    let partIndex = 0

    while (offset < rowCount) {
      const tempFileName = `temp_${snapshotId}_part_${partIndex}.parquet`
      const finalFileName = `${snapshotId}_part_${partIndex}.parquet`

      // 1. COPY TO in-memory file (DuckDB WASM memory)
      // CRITICAL: ORDER BY ensures deterministic row ordering across chunks
      // Detect correct ORDER BY column for this table (handles diff tables with row_id)
      const orderByCol = await getOrderByColumn(conn, tableName)
      const orderByClause = orderByCol ? `ORDER BY "${orderByCol}"` : ''

      await conn.query(`
        COPY (
          SELECT * FROM "${tableName}"
          ${orderByClause}
          LIMIT ${batchSize} OFFSET ${offset}
        ) TO '${tempFileName}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
      `)

      // 2. Retrieve buffer from WASM memory → JS heap (~50MB compressed)
      const buffer = await db.copyFileToBuffer(tempFileName)

      // 3. Write to OPFS (buffer cleared after write)
      const fileHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
      const writable = await createWritableWithRetry(fileHandle)
      await writable.write(buffer)
      await writable.close()

      // CRITICAL: Small delay to ensure file handle is fully released
      // Without this, immediate registration for reading can fail with:
      // "Access Handles cannot be created if there is another open Access Handle"
      await new Promise(resolve => setTimeout(resolve, 20))

      // Verify file was written
      const file = await fileHandle.getFile()
      if (file.size === 0) {
        throw new Error(`[Snapshot] Failed to write ${finalFileName} - file is 0 bytes`)
      }
      console.log(`[Snapshot] Wrote ${(file.size / 1024 / 1024).toFixed(2)} MB to ${finalFileName}`)

      // 4. Cleanup virtual file in WASM
      await db.dropFile(tempFileName)

      offset += batchSize
      partIndex++
      console.log(`[Snapshot] Exported chunk ${partIndex}: ${Math.min(offset, rowCount).toLocaleString()}/${rowCount.toLocaleString()} rows`)
    }

    console.log(`[Snapshot] Exported ${partIndex} chunks to ${snapshotId}_part_*.parquet`)
  } else {
    // Single file export (ONLY safe for tables ≤250k rows)
    // If rowCount == CHUNK_THRESHOLD, this path is safe (equality handled by > check above)
    const tempFileName = `temp_${snapshotId}.parquet`
    const finalFileName = `${snapshotId}.parquet`

    // 1. COPY TO in-memory file
    // Detect correct ORDER BY column for this table (handles diff tables with row_id)
    const orderByCol = await getOrderByColumn(conn, tableName)
    const orderByClause = orderByCol ? `ORDER BY "${orderByCol}"` : ''

    await conn.query(`
      COPY (
        SELECT * FROM "${tableName}"
        ${orderByClause}
      ) TO '${tempFileName}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
    `)

    // 2. Retrieve buffer from WASM → JS heap (safe: <50MB)
    const buffer = await db.copyFileToBuffer(tempFileName)

    // 3. Write to OPFS
    const fileHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
    const writable = await createWritableWithRetry(fileHandle)
    await writable.write(buffer)
    await writable.close()

    // CRITICAL: Small delay to ensure file handle is fully released
    // Without this, immediate registration for reading can fail with:
    // "Access Handles cannot be created if there is another open Access Handle"
    await new Promise(resolve => setTimeout(resolve, 20))

    // Verify file was written
    const file = await fileHandle.getFile()
    if (file.size === 0) {
      throw new Error(`[Snapshot] Failed to write ${finalFileName} - file is 0 bytes`)
    }
    console.log(`[Snapshot] Wrote ${(file.size / 1024 / 1024).toFixed(2)} MB to ${finalFileName}`)

    // 4. Cleanup virtual file
    await db.dropFile(tempFileName)

    console.log(`[Snapshot] Exported to ${finalFileName}`)
  }
  } finally {
    // Always release the write lock
    releaseLock()
  }
}

/**
 * Helper to register a file with retry and memory fallback
 * OPFS file handles can have locking issues - this provides resilience
 */
async function registerFileWithRetry(
  db: AsyncDuckDB,
  fileHandle: FileSystemFileHandle,
  fileName: string,
  maxRetries = 3
): Promise<'handle' | 'buffer'> {
  // Try file handle registration first (zero-copy, preferred)
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
        console.warn(`[Snapshot] File handle registration failed for ${fileName}, using buffer fallback`)
        break
      }
      // Wait before retry (exponential backoff: 50ms, 100ms, 200ms)
      await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)))
    }
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
}

/**
 * Delete a Parquet snapshot from OPFS
 *
 * Uses File System Access API to directly remove file.
 * Handles both chunked files and single files.
 */
export async function deleteParquetSnapshot(snapshotId: string): Promise<void> {
  try {
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
 * Scans the snapshots directory and deletes any 0-byte (corrupt) files.
 * This is a self-healing step to recover from failed writes or browser crashes.
 *
 * Common causes of 0-byte files:
 * - Browser crash during Parquet export
 * - OPFS permission denied mid-write
 * - Out of disk quota during write
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

    let deletedCount = 0

    // Iterate over all files in the snapshots directory
    // Parquet files need at least ~200 bytes for magic bytes + minimal schema
    const MIN_PARQUET_SIZE = 200

    // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.parquet')) {
        const file = await handle.getFile()
        if (file.size < MIN_PARQUET_SIZE) {
          console.warn(`[Snapshot] Found corrupt file (${file.size} bytes): ${name}. Deleting...`)
          await snapshotsDir.removeEntry(name)
          deletedCount++
        }
      }
    }

    if (deletedCount > 0) {
      console.log(`[Snapshot] Cleanup complete. Removed ${deletedCount} corrupt file(s).`)
    }
  } catch (error) {
    console.warn('[Snapshot] Failed to run corrupt file cleanup:', error)
  }
}
