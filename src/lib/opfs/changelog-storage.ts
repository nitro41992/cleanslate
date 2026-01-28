/**
 * OPFS JSONL Changelog Storage
 *
 * Provides fast, durable persistence for cell edits using append-only JSONL files.
 * Cell edits are written immediately to OPFS (~2-3ms per write) instead of triggering
 * full Parquet exports (~10-30s for 1M rows).
 *
 * Storage format: JSON Lines (one JSON object per line, append-only)
 * ```
 * {"tableId":"Raw_Data","ts":1706450000000,"rowId":5,"column":"name","oldValue":"Jon","newValue":"John"}
 * {"tableId":"Raw_Data","ts":1706450001000,"rowId":10,"column":"email","oldValue":"","newValue":"john@example.com"}
 * ```
 *
 * Lifecycle:
 * 1. Cell edit → appendEdit() → instant OPFS write
 * 2. Periodic compaction → replay changelog into DuckDB → export to Parquet → clear changelog
 * 3. Page load → restore from Parquet → replay changelog → ready
 *
 * @see https://jsonlines.org/
 */

/**
 * A single cell edit entry in the changelog
 */
export interface ChangelogEntry {
  tableId: string    // Which table (matches tableStore.id)
  ts: number         // Timestamp in milliseconds
  rowId: number      // _cs_id of the edited row
  column: string     // Column name
  oldValue: unknown  // Previous value (for potential undo)
  newValue: unknown  // New cell value
}

/**
 * Abstraction layer for changelog storage.
 * Default implementation uses OPFS JSONL.
 * Can be swapped to IndexedDB if performance proves insufficient.
 */
export interface ChangelogStorage {
  /** Append a cell edit to the changelog (instant, durable) */
  appendEdit(entry: ChangelogEntry): Promise<void>

  /** Append multiple cell edits atomically */
  appendEdits(entries: ChangelogEntry[]): Promise<void>

  /** Get all changelog entries for a table (for replay on restore) */
  getChangelog(tableId: string): Promise<ChangelogEntry[]>

  /** Get all changelog entries across all tables */
  getAllChangelogs(): Promise<ChangelogEntry[]>

  /** Clear changelog for a table (after compaction into Parquet) */
  clearChangelog(tableId: string): Promise<void>

  /** Clear all changelogs */
  clearAllChangelogs(): Promise<void>

  /** Get count of entries for a table (for compaction threshold check) */
  getChangelogCount(tableId: string): Promise<number>

  /** Get total count across all tables */
  getTotalChangelogCount(): Promise<number>

  /** Check if any changelog has pending entries */
  hasAnyPendingChanges(): Promise<boolean>
}

/**
 * Directory path for changelog storage in OPFS
 */
const CLEANSLATE_DIR = 'cleanslate'
const CHANGELOG_FILE = 'changelog.jsonl'

/**
 * Get the OPFS directory for changelog storage
 */
async function getChangelogDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle(CLEANSLATE_DIR, { create: true })
  return appDir
}

/**
 * OPFS JSONL implementation of ChangelogStorage
 *
 * Design decisions:
 * - Single file for all tables (simpler, avoids file handle explosion)
 * - Append-only writes (fast, no read-modify-write)
 * - Filter by tableId on read (acceptable for <10k entries)
 * - Web Locks API for concurrent tab safety
 */
class OPFSChangelogStorage implements ChangelogStorage {
  private writeQueue: Promise<void> = Promise.resolve()

  async appendEdit(entry: ChangelogEntry): Promise<void> {
    return this.appendEdits([entry])
  }

  async appendEdits(entries: ChangelogEntry[]): Promise<void> {
    if (entries.length === 0) return

    // Queue writes to prevent concurrent OPFS access issues
    this.writeQueue = this.writeQueue.then(async () => {
      // Use Web Locks for cross-tab safety
      await navigator.locks.request('cleanslate-changelog-write', async () => {
        const dir = await getChangelogDir()
        const fileHandle = await dir.getFileHandle(CHANGELOG_FILE, { create: true })

        // Read existing content first (append requires knowing current content)
        const file = await fileHandle.getFile()
        const existingContent = await file.text()

        // Build new content to append
        const newLines = entries.map((entry) => JSON.stringify(entry)).join('\n')
        const separator = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : ''
        const finalContent = existingContent + separator + newLines + '\n'

        // Write atomically
        const writable = await fileHandle.createWritable()
        await writable.write(finalContent)
        await writable.close()

        console.log(`[Changelog] Appended ${entries.length} edit(s) to changelog`)
      })
    }).catch((err) => {
      console.error('[Changelog] Failed to append edits:', err)
      throw err
    })

    return this.writeQueue
  }

  async getChangelog(tableId: string): Promise<ChangelogEntry[]> {
    try {
      const dir = await getChangelogDir()
      let fileHandle: FileSystemFileHandle

      try {
        fileHandle = await dir.getFileHandle(CHANGELOG_FILE, { create: false })
      } catch {
        // File doesn't exist - no changelog
        return []
      }

      const file = await fileHandle.getFile()
      const content = await file.text()

      if (!content.trim()) return []

      const entries: ChangelogEntry[] = []
      const lines = content.trim().split('\n')

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as ChangelogEntry
          if (entry.tableId === tableId) {
            entries.push(entry)
          }
        } catch (parseErr) {
          console.warn('[Changelog] Skipping malformed line:', line, parseErr)
        }
      }

      return entries
    } catch (err) {
      console.error('[Changelog] Failed to read changelog:', err)
      return []
    }
  }

  async getAllChangelogs(): Promise<ChangelogEntry[]> {
    try {
      const dir = await getChangelogDir()
      let fileHandle: FileSystemFileHandle

      try {
        fileHandle = await dir.getFileHandle(CHANGELOG_FILE, { create: false })
      } catch {
        return []
      }

      const file = await fileHandle.getFile()
      const content = await file.text()

      if (!content.trim()) return []

      const entries: ChangelogEntry[] = []
      const lines = content.trim().split('\n')

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line) as ChangelogEntry)
        } catch (parseErr) {
          console.warn('[Changelog] Skipping malformed line:', line, parseErr)
        }
      }

      return entries
    } catch (err) {
      console.error('[Changelog] Failed to read all changelogs:', err)
      return []
    }
  }

  async clearChangelog(tableId: string): Promise<void> {
    await navigator.locks.request('cleanslate-changelog-write', async () => {
      const dir = await getChangelogDir()
      let fileHandle: FileSystemFileHandle

      try {
        fileHandle = await dir.getFileHandle(CHANGELOG_FILE, { create: false })
      } catch {
        // File doesn't exist - nothing to clear
        return
      }

      // Read all entries, filter out the cleared table, rewrite
      const file = await fileHandle.getFile()
      const content = await file.text()

      if (!content.trim()) return

      const lines = content.trim().split('\n')
      const remainingLines: string[] = []

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as ChangelogEntry
          if (entry.tableId !== tableId) {
            remainingLines.push(line)
          }
        } catch {
          // Keep malformed lines to avoid data loss
          remainingLines.push(line)
        }
      }

      // Rewrite file with remaining entries
      const writable = await fileHandle.createWritable()
      if (remainingLines.length > 0) {
        await writable.write(remainingLines.join('\n') + '\n')
      }
      await writable.close()

      console.log(`[Changelog] Cleared changelog for table ${tableId}`)
    })
  }

  async clearAllChangelogs(): Promise<void> {
    await navigator.locks.request('cleanslate-changelog-write', async () => {
      const dir = await getChangelogDir()

      try {
        await dir.removeEntry(CHANGELOG_FILE)
        console.log('[Changelog] Cleared all changelogs')
      } catch {
        // File doesn't exist - nothing to clear
      }
    })
  }

  async getChangelogCount(tableId: string): Promise<number> {
    const entries = await this.getChangelog(tableId)
    return entries.length
  }

  async getTotalChangelogCount(): Promise<number> {
    const entries = await this.getAllChangelogs()
    return entries.length
  }

  async hasAnyPendingChanges(): Promise<boolean> {
    try {
      const dir = await getChangelogDir()
      let fileHandle: FileSystemFileHandle

      try {
        fileHandle = await dir.getFileHandle(CHANGELOG_FILE, { create: false })
      } catch {
        return false
      }

      const file = await fileHandle.getFile()
      return file.size > 0
    } catch {
      return false
    }
  }
}

// Singleton instance
let changelogStorageInstance: ChangelogStorage | null = null

/**
 * Get the singleton changelog storage instance.
 * Uses OPFS JSONL by default.
 */
export function getChangelogStorage(): ChangelogStorage {
  if (!changelogStorageInstance) {
    changelogStorageInstance = new OPFSChangelogStorage()
  }
  return changelogStorageInstance
}

/**
 * Create a fresh changelog storage instance (for testing).
 */
export function createOPFSChangelogStorage(): ChangelogStorage {
  return new OPFSChangelogStorage()
}
