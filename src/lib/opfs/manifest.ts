/**
 * Snapshot Manifest System
 *
 * Every snapshot is a collection of 50k-row shards with a manifest file.
 * The manifest provides instant metadata access (row counts, shard sizes,
 * column info) without probing individual files.
 *
 * Stored at: cleanslate/snapshots/{snapshotId}_manifest.json
 * Atomic writes via .tmp rename (same pattern as Arrow IPC).
 */

import { deleteFileIfExists } from './opfs-helpers'

/**
 * Metadata for a single shard file within a snapshot.
 */
export interface ShardInfo {
  /** Shard index (0, 1, 2...) */
  index: number
  /** File name in OPFS (e.g., "my_table_shard_0.arrow") */
  fileName: string
  /** Exact row count in this shard */
  rowCount: number
  /** File size in bytes */
  byteSize: number
  /** Minimum _cs_id value in this shard (for range lookups), null if unknown */
  minCsId: number | null
  /** Maximum _cs_id value in this shard (for range lookups), null if unknown */
  maxCsId: number | null
}

/**
 * Manifest describing a complete snapshot (all shards + metadata).
 */
export interface SnapshotManifest {
  /** Manifest format version */
  version: 1
  /** Unique snapshot identifier */
  snapshotId: string
  /** Total row count across all shards */
  totalRows: number
  /** Total bytes across all shard files */
  totalBytes: number
  /** Target rows per shard (50,000) */
  shardSize: number
  /** Ordered list of shards */
  shards: ShardInfo[]
  /** Column names (for metadata-only hydration without loading data) */
  columns: string[]
  /** Column used for ORDER BY during export ("_cs_id" or "sort_key") */
  orderByColumn: string
  /** Manifest creation timestamp (epoch ms) */
  createdAt: number
}

/**
 * Get the snapshots directory handle from OPFS.
 * Returns null if the directory doesn't exist.
 */
async function getSnapshotsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create })
    return await appDir.getDirectoryHandle('snapshots', { create })
  } catch {
    return null
  }
}

/**
 * Get the manifest file name for a snapshot.
 */
function getManifestFileName(snapshotId: string): string {
  return `${snapshotId}_manifest.json`
}

/**
 * Read a manifest from OPFS.
 *
 * @param snapshotId - Unique snapshot identifier
 * @returns The manifest, or null if not found
 */
export async function readManifest(snapshotId: string): Promise<SnapshotManifest | null> {
  const snapshotsDir = await getSnapshotsDir()
  if (!snapshotsDir) return null

  try {
    const fileName = getManifestFileName(snapshotId)
    const handle = await snapshotsDir.getFileHandle(fileName, { create: false })
    const file = await handle.getFile()
    const text = await file.text()
    const manifest = JSON.parse(text) as SnapshotManifest

    // Basic validation
    if (manifest.version !== 1 || !Array.isArray(manifest.shards)) {
      console.warn(`[Manifest] Invalid manifest for ${snapshotId}:`, manifest)
      return null
    }

    return manifest
  } catch {
    return null // File doesn't exist or is unreadable
  }
}

/**
 * Write a manifest to OPFS.
 * Uses atomic write pattern: write to .tmp, then rename to final.
 *
 * @param manifest - The manifest to write
 */
export async function writeManifest(manifest: SnapshotManifest): Promise<void> {
  const snapshotsDir = await getSnapshotsDir(true)
  if (!snapshotsDir) {
    throw new Error('[Manifest] Cannot access snapshots directory')
  }

  const finalFileName = getManifestFileName(manifest.snapshotId)
  const tmpFileName = `${finalFileName}.tmp`

  try {
    // Step 1: Write to temp file
    const tmpHandle = await snapshotsDir.getFileHandle(tmpFileName, { create: true })
    const writable = await tmpHandle.createWritable()
    const jsonStr = JSON.stringify(manifest, null, 2)
    await writable.write(jsonStr)
    await writable.close()

    // Step 2: Atomic rename - delete old, write final
    await deleteFileIfExists(snapshotsDir, finalFileName)
    const finalHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
    const finalWritable = await finalHandle.createWritable()
    await finalWritable.write(jsonStr)
    await finalWritable.close()

    // Step 3: Clean up temp
    await deleteFileIfExists(snapshotsDir, tmpFileName)

    console.log(`[Manifest] Written for ${manifest.snapshotId}: ${manifest.shards.length} shard(s), ${manifest.totalRows.toLocaleString()} rows`)
  } catch (error) {
    // Clean up temp file on failure
    await deleteFileIfExists(snapshotsDir, tmpFileName)
    throw error
  }
}

/**
 * Delete a manifest from OPFS.
 *
 * @param snapshotId - Unique snapshot identifier
 */
export async function deleteManifest(snapshotId: string): Promise<void> {
  const snapshotsDir = await getSnapshotsDir()
  if (!snapshotsDir) return

  const fileName = getManifestFileName(snapshotId)
  await deleteFileIfExists(snapshotsDir, fileName)
  // Also clean up any orphaned temp
  await deleteFileIfExists(snapshotsDir, `${fileName}.tmp`)

  console.log(`[Manifest] Deleted for ${snapshotId}`)
}

/**
 * Check if a manifest exists for a snapshot.
 *
 * @param snapshotId - Unique snapshot identifier
 * @returns true if manifest exists
 */
export async function hasManifest(snapshotId: string): Promise<boolean> {
  const snapshotsDir = await getSnapshotsDir()
  if (!snapshotsDir) return false

  try {
    await snapshotsDir.getFileHandle(getManifestFileName(snapshotId), { create: false })
    return true
  } catch {
    return false
  }
}
