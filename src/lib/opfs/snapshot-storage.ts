/**
 * OPFS Parquet Snapshot Storage
 *
 * Provides cold storage for large table snapshots using Parquet compression.
 * Reduces RAM usage from ~1.5GB (in-memory table) to ~5MB (compressed file).
 *
 * CRITICAL: Registers OPFS file handles with DuckDB before writing.
 * Data flows directly from WASM to OPFS without touching JavaScript heap.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import * as duckdb from '@duckdb/duckdb-wasm'

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
 * Export a table to Parquet file in OPFS
 *
 * Uses DuckDB's file handle registration for zero-copy writes.
 * Data never touches JavaScript heap - flows from WASM to OPFS disk.
 *
 * For large tables (>250k rows), uses chunked files to reduce peak memory usage.
 * Each chunk is written separately, keeping RAM usage low.
 *
 * @param db - DuckDB instance (for file registration)
 * @param conn - Active DuckDB connection (for transaction consistency)
 * @param tableName - Source table to export
 * @param snapshotId - Unique snapshot identifier (e.g., "snapshot_abc_1234567890")
 *
 * Performance: ~2-3 seconds for 1M rows (includes compression)
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

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: true })

  // For large tables (>250k rows), use chunked files to reduce peak memory
  const CHUNK_THRESHOLD = 250_000
  if (rowCount > CHUNK_THRESHOLD) {
    console.log('[Snapshot] Using chunked Parquet export for large table')

    const batchSize = CHUNK_THRESHOLD
    let offset = 0
    let partIndex = 0

    while (offset < rowCount) {
      const fileName = `${snapshotId}_part_${partIndex}.parquet`
      const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: true })

      // Register file handle for this chunk
      await db.registerFileHandle(
        fileName,
        fileHandle,
        duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
        true
      )

      // Export chunk (only buffers batchSize rows)
      try {
        await conn.query(`
          COPY (
            SELECT * FROM "${tableName}"
            LIMIT ${batchSize} OFFSET ${offset}
          ) TO '${fileName}'
          (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `)

        // CRITICAL: Flush DuckDB write buffers to OPFS before unregistering
        await db.flushFiles()
      } finally {
        // Unregister file handle after write (always cleanup to prevent leaks)
        await db.dropFile(fileName)
      }

      offset += batchSize
      partIndex++
      console.log(`[Snapshot] Exported chunk ${partIndex}: ${Math.min(offset, rowCount).toLocaleString()}/${rowCount.toLocaleString()} rows`)
    }

    console.log(`[Snapshot] Exported ${partIndex} chunks to ${snapshotId}_part_*.parquet`)
  } else {
    // Small table - single file export
    const fileName = `${snapshotId}.parquet`
    const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: true })

    await db.registerFileHandle(
      fileName,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      true
    )

    try {
      await conn.query(`
        COPY "${tableName}" TO '${fileName}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
      `)

      // CRITICAL: Flush DuckDB write buffers to OPFS before unregistering
      await db.flushFiles()
    } finally {
      // Unregister file handle after write (always cleanup to prevent leaks)
      await db.dropFile(fileName)
    }

    console.log(`[Snapshot] Exported to ${fileName}`)
  }
}

/**
 * Import a table from Parquet file in OPFS
 *
 * Uses DuckDB's file handle registration for zero-copy reads.
 * Data never touches JavaScript heap - flows from OPFS disk to WASM.
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
    const fileHandles: FileSystemFileHandle[] = []

    while (true) {
      try {
        const fileName = `${snapshotId}_part_${partIndex}.parquet`
        const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
        fileHandles.push(fileHandle)

        await db.registerFileHandle(
          fileName,
          fileHandle,
          duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
          false // read-only
        )

        partIndex++
      } catch {
        break // No more chunks
      }
    }

    // Read all chunks with glob pattern
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

    await db.registerFileHandle(
      fileName,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      false
    )

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

    for await (const [name, _handle] of (snapshotsDir as FileSystemDirectoryHandle).entries()) {
      if (name.endsWith('.parquet')) {
        entries.push(name.replace('.parquet', ''))
      }
    }

    return entries
  } catch {
    return []
  }
}
