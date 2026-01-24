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
  // Ensure directory exists before export
  await ensureSnapshotDir()

  const fileName = `${snapshotId}.parquet`

  console.log(`[Snapshot] Exporting ${tableName} to OPFS...`)

  // Get OPFS file handle
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: true })
  const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: true })

  // Register the file handle with DuckDB (required for COPY TO)
  await db.registerFileHandle(
    fileName,
    fileHandle,
    duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
    true // writable
  )

  // Direct write to registered file - data stays in WASM layer
  // ZSTD compression: ~10x reduction (1.5GB → 150MB)
  await conn.query(`
    COPY "${tableName}" TO '${fileName}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
  `)

  console.log(`[Snapshot] Exported to ${fileName}`)
}

/**
 * Import a table from Parquet file in OPFS
 *
 * Uses DuckDB's file handle registration for zero-copy reads.
 * Data never touches JavaScript heap - flows from OPFS disk to WASM.
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
  const fileName = `${snapshotId}.parquet`

  console.log(`[Snapshot] Importing from ${fileName}...`)

  // Get OPFS file handle
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
  const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })

  // Register the file handle with DuckDB (required for read_parquet)
  await db.registerFileHandle(
    fileName,
    fileHandle,
    duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
    false // read-only
  )

  // Create table from Parquet - direct read from registered file
  await conn.query(`
    CREATE OR REPLACE TABLE "${targetTableName}" AS
    SELECT * FROM read_parquet('${fileName}')
  `)

  console.log(`[Snapshot] Restored ${targetTableName} from OPFS`)
}

/**
 * Delete a Parquet snapshot from OPFS
 *
 * Uses File System Access API to directly remove file.
 */
export async function deleteParquetSnapshot(snapshotId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    await snapshotsDir.removeEntry(`${snapshotId}.parquet`)

    console.log(`[Snapshot] Deleted ${snapshotId}.parquet`)
  } catch (err) {
    console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
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
