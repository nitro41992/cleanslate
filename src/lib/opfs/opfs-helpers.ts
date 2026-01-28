/**
 * OPFS Helper Functions
 *
 * Utility functions for Origin Private File System operations.
 * Provides atomic file operations and cleanup helpers for data integrity.
 */

/**
 * Atomically rename a file by copying to new name and deleting original.
 * OPFS doesn't have a native rename operation, so we simulate it.
 *
 * This is the key primitive for atomic writes:
 * 1. Write to temp file (foo.tmp)
 * 2. Rename to final name (foo.parquet)
 *
 * If the app crashes during step 1, the temp file is orphaned (cleaned up later).
 * If the app crashes during step 2, either old or new file exists (never corrupt).
 *
 * @param dir Directory handle containing the files
 * @param oldName Current file name
 * @param newName New file name
 */
export async function renameFile(
  dir: FileSystemDirectoryHandle,
  oldName: string,
  newName: string
): Promise<void> {
  // Get the source file
  const sourceHandle = await dir.getFileHandle(oldName, { create: false })
  const sourceFile = await sourceHandle.getFile()
  const content = await sourceFile.arrayBuffer()

  // Write to destination (creates new file or overwrites existing)
  const destHandle = await dir.getFileHandle(newName, { create: true })
  const writable = await destHandle.createWritable()
  await writable.write(content)
  await writable.close()

  // Delete the source file
  await dir.removeEntry(oldName)
}

/**
 * Delete a file if it exists, silently ignore if it doesn't.
 * Useful for cleaning up temp files that may or may not exist.
 *
 * @param dir Directory handle containing the file
 * @param fileName File to delete
 */
export async function deleteFileIfExists(
  dir: FileSystemDirectoryHandle,
  fileName: string
): Promise<void> {
  try {
    await dir.removeEntry(fileName)
  } catch {
    // File doesn't exist, which is fine
  }
}

/**
 * Check if a file exists in the given directory.
 *
 * @param dir Directory handle to check in
 * @param fileName File name to look for
 * @returns true if file exists, false otherwise
 */
export async function fileExists(
  dir: FileSystemDirectoryHandle,
  fileName: string
): Promise<boolean> {
  try {
    await dir.getFileHandle(fileName, { create: false })
    return true
  } catch {
    return false
  }
}

/**
 * List all files matching a pattern in a directory.
 * Uses simple prefix/suffix matching (not full glob).
 *
 * @param dir Directory handle to list
 * @param options Filter options
 * @returns Array of matching file names
 */
export async function listFiles(
  dir: FileSystemDirectoryHandle,
  options?: { prefix?: string; suffix?: string }
): Promise<string[]> {
  const files: string[] = []

  // @ts-expect-error entries() exists at runtime but TypeScript's lib doesn't include it
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue

    if (options?.prefix && !name.startsWith(options.prefix)) continue
    if (options?.suffix && !name.endsWith(options.suffix)) continue

    files.push(name)
  }

  return files
}

/**
 * Clean up orphaned temp files (*.tmp) in a directory.
 * Called on startup to remove partial writes from crashed sessions.
 *
 * @param dir Directory handle to clean
 * @returns Number of temp files deleted
 */
export async function cleanupTempFiles(
  dir: FileSystemDirectoryHandle
): Promise<number> {
  const tempFiles = await listFiles(dir, { suffix: '.tmp' })
  let deletedCount = 0

  for (const fileName of tempFiles) {
    try {
      await dir.removeEntry(fileName)
      console.log(`[OPFS] Cleaned up orphaned temp file: ${fileName}`)
      deletedCount++
    } catch (err) {
      console.warn(`[OPFS] Failed to delete temp file ${fileName}:`, err)
    }
  }

  return deletedCount
}
