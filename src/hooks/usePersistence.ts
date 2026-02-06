/**
 * Persistence Hook - Hybrid OPFS Persistence with Incremental Changelog
 *
 * Workaround for DuckDB-WASM OPFS bug #2096.
 * Uses a dual-layer persistence strategy for optimal performance:
 *
 * 1. CHANGELOG (fast): Cell edits → OPFS JSONL (~2-3ms per write)
 * 2. SNAPSHOT (reliable): Transforms → Full Arrow IPC snapshot export
 *
 * Lifecycle:
 * 1. App opens → Import Arrow IPC snapshots → Replay changelog → Ready
 * 2. Cell edit → Instant OPFS changelog write (non-blocking)
 * 3. Transform → Arrow IPC snapshot export (background, non-blocking)
 * 4. Periodic compaction → Merge changelog into snapshot → Clear changelog
 * 5. App closes → Attempt final compaction (best-effort)
 *
 * @see https://github.com/duckdb/duckdb-wasm/issues/2096
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTableStore } from '@/stores/tableStore'
import { useUIStore } from '@/stores/uiStore'
import { initDuckDB, getConnection, getTableColumns, CS_ID_COLUMN, migrateToGapBasedCsId } from '@/lib/duckdb'
import {
  listSnapshots,
  importTableFromSnapshot,
  exportTableToSnapshot,
  deleteSnapshot,
  cleanupCorruptSnapshots,
  cleanupOrphanedDiffFiles,
  cleanupDuplicateCaseSnapshots,
} from '@/lib/opfs/snapshot-storage'
import {
  getChangelogStorage,
  type CellEditEntry,
  type InsertRowEntry,
  type DeleteRowEntry,
} from '@/lib/opfs/changelog-storage'
import { toast } from 'sonner'
import { writeManifest, type SnapshotManifest, type ShardInfo } from '@/lib/opfs/manifest'

// Module-level flag to prevent double-hydration from React StrictMode
let hydrationPromise: Promise<void> | null = null

// Flag to signal that re-hydration is needed (after worker restart)
let rehydrationRequested = false

// Flag to suppress snapshot deletion during rehydration
// When true, clearTables() won't trigger snapshot deletion
let isRehydratingFlag = false

// Save queue to prevent concurrent exports and coalesce rapid changes
const saveInProgress = new Map<string, Promise<void>>()
// Track pending saves: false = normal (can skip if clean), true = priority (MUST save)
const pendingSave = new Map<string, boolean>()
// Track tables that are starting a save (between entering saveTable and setting saveInProgress)
// This prevents race conditions where multiple concurrent calls pass the saveInProgress.has() check
// before any of them set saveInProgress (which happens after the first await)
const saveStarting = new Set<string>()

// Compaction configuration
const COMPACTION_THRESHOLD = 1000        // Compact when changelog exceeds this many entries
const COMPACTION_IDLE_TIMEOUT = 30_000   // Compact after 30s of idle time
const COMPACTION_CHECK_INTERVAL = 10_000 // Check compaction conditions every 10s

// Track last activity for idle detection
let lastActivityTimestamp = Date.now()

/**
 * Update last activity timestamp (called on any user action)
 */
export function touchActivity(): void {
  lastActivityTimestamp = Date.now()
}

/**
 * Replay changelog entries into DuckDB.
 * Called after snapshot import to apply pending cell edits.
 */
async function replayChangelogEntries(
  conn: Awaited<ReturnType<typeof getConnection>>,
  tableIdToName: Map<string, string>
): Promise<number> {
  const changelog = getChangelogStorage()
  const allEntries = await changelog.getAllChangelogs()

  if (allEntries.length === 0) {
    return 0
  }

  console.log(`[Persistence] Replaying ${allEntries.length} changelog entries...`)

  // Sort by timestamp for deterministic replay
  allEntries.sort((a, b) => a.ts - b.ts)

  let replayedCount = 0
  let errorCount = 0

  for (const entry of allEntries) {
    const tableName = tableIdToName.get(entry.tableId)
    if (!tableName) {
      console.warn(`[Persistence] Cannot replay entry - table ${entry.tableId} not found`)
      errorCount++
      continue
    }

    try {
      const entryType = entry.type ?? 'cell_edit' // Legacy entries lack 'type'

      if (entryType === 'cell_edit') {
        const cellEntry = entry as CellEditEntry
        // Escape value for SQL
        let escapedValue: string
        if (cellEntry.newValue === null || cellEntry.newValue === undefined) {
          escapedValue = 'NULL'
        } else if (typeof cellEntry.newValue === 'string') {
          escapedValue = `'${cellEntry.newValue.replace(/'/g, "''")}'`
        } else if (typeof cellEntry.newValue === 'boolean') {
          escapedValue = cellEntry.newValue ? 'true' : 'false'
        } else {
          escapedValue = String(cellEntry.newValue)
        }

        const sql = `
          UPDATE "${tableName}"
          SET "${cellEntry.column}" = ${escapedValue}
          WHERE "${CS_ID_COLUMN}" = ${cellEntry.rowId}
        `
        await conn.query(sql)

      } else if (entryType === 'insert_row') {
        const insertEntry = entry as InsertRowEntry
        // Replay: INSERT a new row with the stored _cs_id and _cs_origin_id
        const columnNames = insertEntry.columnNames.map(c => `"${c}"`).join(', ')
        const values = insertEntry.columnNames.map(col => {
          if (col === '_cs_id') return `'${insertEntry.csId}'`
          if (col === '_cs_origin_id') return `'${insertEntry.originId}'`
          return 'NULL'
        }).join(', ')

        await conn.query(`INSERT INTO "${tableName}" (${columnNames}) VALUES (${values})`)

      } else if (entryType === 'delete_row') {
        const deleteEntry = entry as DeleteRowEntry
        // Replay: DELETE the specified rows
        const idList = deleteEntry.csIds.map(id => `'${id}'`).join(', ')
        await conn.query(`DELETE FROM "${tableName}" WHERE "_cs_id" IN (${idList})`)
      }

      replayedCount++
    } catch (err) {
      console.error(`[Persistence] Failed to replay entry:`, entry, err)
      errorCount++
    }
  }

  if (errorCount > 0) {
    console.warn(`[Persistence] Changelog replay: ${replayedCount} succeeded, ${errorCount} failed`)
  } else {
    console.log(`[Persistence] Changelog replay complete: ${replayedCount} entries applied`)
  }

  return replayedCount
}

/**
 * Perform hydration - import tables from Arrow IPC snapshots into DuckDB.
 * Can be called from useEffect (initial load) or after worker restart.
 *
 * LAZY HYDRATION (Phase 4): Only the activeTableId table is fully imported.
 * All other tables are added to the store with metadata only (marked frozen).
 * This supports the Single Active Table Policy for memory efficiency.
 *
 * @param isRehydration - If true, skips state restoration (already done) and clears tableStore
 * @returns Promise that resolves when hydration is complete
 */
export async function performHydration(isRehydration = false): Promise<void> {
  console.log('[Persistence] Starting hydration...', isRehydration ? '(re-hydration after restart)' : '')

  // Clear tables if this is a re-hydration (worker was restarted)
  // The tableStore still has metadata but DuckDB tables are gone
  if (isRehydration) {
    const existingTables = useTableStore.getState().tables
    if (existingTables.length > 0) {
      console.log(`[Persistence] Re-hydration: clearing ${existingTables.length} stale table(s) from store`)
      // CRITICAL: Set flag to prevent deletion subscription from deleting snapshot files
      isRehydratingFlag = true
      useTableStore.getState().clearTables()
    }
  }

  const { initDuckDB, getConnection, getTableColumns } = await import('@/lib/duckdb')
  const db = await initDuckDB()
  const conn = await getConnection()

  // Wait for state restoration to complete (only on initial load, not re-hydration)
  // This provides savedTableIds and savedActiveTableId
  let savedActiveTableId: string | null = null
  if (!isRehydration) {
    const { stateRestorationPromise } = await import('@/hooks/useDuckDB')
    if (stateRestorationPromise) {
      await stateRestorationPromise
      console.log('[Persistence] State restoration complete, proceeding with hydration')
    }
    // Get saved active table ID for lazy hydration
    savedActiveTableId = (window as Window & { __CLEANSLATE_SAVED_ACTIVE_TABLE_ID__?: string | null }).__CLEANSLATE_SAVED_ACTIVE_TABLE_ID__ ?? null
  }

  // Clean up corrupt and orphaned files
  await cleanupCorruptSnapshots()
  await cleanupOrphanedDiffFiles()
  // Clean up duplicate case-mismatched files (migration from pre-fix state)
  await cleanupDuplicateCaseSnapshots()

  // Migrate legacy snapshots (no manifest) to manifest format
  await migrateLegacySnapshots()

  // List all saved snapshot files
  const snapshots = await listSnapshots()

  if (snapshots.length === 0) {
    console.log('[Persistence] No saved snapshots found.')
    // Still replay changelog in case there are orphaned entries
    // (e.g., user made edits but snapshot export failed)
    return
  }

  // Filter to user tables only (exclude internal timeline/diff tables)
  const uniqueTables = [...new Set(
    snapshots
      .map(name => name
        .replace(/_part_\d+$/, '')
        .replace(/_shard_\d+$/, '')
        .replace(/_manifest$/, '')
      )
      .filter(name => {
        if (name.startsWith('original_')) return false
        if (name.startsWith('snapshot_')) return false
        if (name.startsWith('_timeline_')) return false
        if (name.startsWith('_diff_')) return false
        return true
      })
  )]

  console.log(`[Persistence] Found ${uniqueTables.length} tables to restore:`, uniqueTables)

  // Get saved table IDs for consistency
  const savedTableIds = (window as Window & { __CLEANSLATE_SAVED_TABLE_IDS__?: Record<string, string> }).__CLEANSLATE_SAVED_TABLE_IDS__

  // Build normalized lookup map: lowercase table name → original tableId
  // This handles case mismatch between snapshot filenames (lowercase) and app-state.json (original casing)
  const normalizedSavedTableIds = new Map<string, string>()
  if (savedTableIds) {
    for (const [name, id] of Object.entries(savedTableIds)) {
      const normalizedName = name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      normalizedSavedTableIds.set(normalizedName, id)
    }
  }

  // Build tableName → tableId mapping using normalized lookup
  const tableNameToId = new Map<string, string>()
  for (const tableName of uniqueTables) {
    const tableId = normalizedSavedTableIds.get(tableName) ?? tableName
    tableNameToId.set(tableName, tableId)
  }

  // Determine which table to thaw (load into DuckDB)
  // Priority: savedActiveTableId > first table
  let tableToThaw: string | null = null

  if (savedActiveTableId) {
    // Find the table name for the saved active table ID
    for (const [name, id] of tableNameToId) {
      if (id === savedActiveTableId) {
        tableToThaw = name
        break
      }
    }
  }

  // Fallback to first table if savedActiveTableId not found
  if (!tableToThaw && uniqueTables.length > 0) {
    tableToThaw = uniqueTables[0]
    console.log(`[Persistence] Saved active table not found, using first table: ${tableToThaw}`)
  }

  console.log(`[Persistence] Lazy hydration - will thaw: ${tableToThaw}, freeze ${uniqueTables.length - 1} other table(s)`)

  const addTable = useTableStore.getState().addTable
  const markTableFrozen = useTableStore.getState().markTableFrozen
  let restoredCount = 0
  const tableIdToName = new Map<string, string>()

  // Build normalized lookup for savedTables: lowercase name → original savedTable entry
  // This allows matching snapshot filenames (lowercase) to app-state entries (original casing)
  const savedTables = (window as Window & { __CLEANSLATE_SAVED_TABLES__?: Array<{ id: string; name: string; columns: Array<{ name: string; type: string; nullable: boolean }>; rowCount: number; columnOrder?: string[] }> }).__CLEANSLATE_SAVED_TABLES__
  const normalizedSavedTables = new Map<string, { id: string; name: string; columns: Array<{ name: string; type: string; nullable: boolean }>; rowCount: number; columnOrder?: string[] }>()
  if (savedTables) {
    for (const t of savedTables) {
      const normalizedName = t.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      normalizedSavedTables.set(normalizedName, t)
    }
  }

  for (const snapshotName of uniqueTables) {
    try {
      const tableId = tableNameToId.get(snapshotName) ?? snapshotName
      const savedTable = normalizedSavedTables.get(snapshotName)
      // Use original name from app-state.json if available, otherwise use snapshot name
      const tableName = savedTable?.name ?? snapshotName

      // Skip if already exists (prevents duplicates)
      const existingTables = useTableStore.getState().tables
      const normalizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      if (existingTables.some(t => {
        const normalizedExisting = t.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
        return normalizedExisting === normalizedTableName || t.id === tableId
      })) {
        console.log(`[Persistence] Skipping ${tableName} - already in store`)
        continue
      }

      const shouldThaw = snapshotName === tableToThaw

      if (shouldThaw) {
        // THAW: Import from Arrow IPC snapshot into DuckDB (full hydration)
        // Use snapshotName (lowercase) for snapshot file, tableName (original casing) for DuckDB table
        await importTableFromSnapshot(db, conn, snapshotName, tableName)

        // Auto-migrate sequential _cs_id to gap-based (one-time migration)
        await migrateToGapBasedCsId(tableName)

        // Get metadata from DuckDB
        const cols = await getTableColumns(tableName)
        const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
        const rowCount = Number(countResult.toArray()[0].toJSON().count)

        // Track tableId → tableName mapping for changelog replay
        tableIdToName.set(tableId, tableName)

        addTable(tableName, cols, rowCount, tableId)
        // Restore column order if saved
        if (savedTable?.columnOrder) {
          useTableStore.getState().setColumnOrder(tableId, savedTable.columnOrder)
        }
        console.log(`[Persistence] Thawed ${tableName} (${rowCount.toLocaleString()} rows)`)
      } else {
        // FREEZE: Add metadata only, don't import into DuckDB
        if (savedTable) {
          // Use saved metadata with original table name
          addTable(tableName, savedTable.columns, savedTable.rowCount, tableId)
          // Restore column order if saved
          if (savedTable.columnOrder) {
            useTableStore.getState().setColumnOrder(tableId, savedTable.columnOrder)
          }
          markTableFrozen(tableId)
          console.log(`[Persistence] Frozen ${tableName} (${savedTable.rowCount.toLocaleString()} rows) - metadata from app-state`)
        } else {
          // Fallback: Read snapshot metadata directly
          // We need to briefly import to get accurate metadata, then drop
          console.log(`[Persistence] No saved metadata for ${snapshotName}, reading from snapshot metadata...`)
          await importTableFromSnapshot(db, conn, snapshotName, tableName)
          const cols = await getTableColumns(tableName)
          const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
          const rowCount = Number(countResult.toArray()[0].toJSON().count)

          // Drop from DuckDB memory (it's frozen, not active)
          await conn.query(`DROP TABLE IF EXISTS "${tableName}"`)

          addTable(tableName, cols, rowCount, tableId)
          markTableFrozen(tableId)
          console.log(`[Persistence] Frozen ${tableName} (${rowCount.toLocaleString()} rows) - metadata from snapshot`)
        }
      }

      restoredCount++
    } catch (err) {
      console.error(`[Persistence] Failed to restore ${snapshotName}:`, err)
    }
  }

  // Replay changelog entries only for the thawed table
  // (Frozen tables will replay when thawed via switchToTable)
  if (tableIdToName.size > 0) {
    const replayedCount = await replayChangelogEntries(conn, tableIdToName)
    if (replayedCount > 0) {
      console.log(`[Persistence] Applied ${replayedCount} pending cell edits from changelog`)
    }
  }

  if (restoredCount > 0) {
    console.log(`[Persistence] Hydration complete: restored ${restoredCount} table(s), thawed 1, frozen ${restoredCount - 1}`)

    // Set active table to the thawed table
    const tableId = tableNameToId.get(tableToThaw!)
    if (tableId) {
      useTableStore.getState().setActiveTable(tableId)
      console.log(`[Persistence] Set active table to thawed: ${tableId}`)
    }
  }

  // Reset rehydration flag - safe to delete snapshots again on normal table removal
  if (isRehydration) {
    isRehydratingFlag = false
    console.log('[Persistence] Re-hydration complete, snapshot deletion re-enabled')
  }
}

/**
 * Request re-hydration after a worker restart.
 * This resets the hydration flag so the next usePersistence effect can re-run.
 * Called by useDuckDB after terminateAndReinitialize().
 */
export function requestRehydration(): void {
  hydrationPromise = null
  rehydrationRequested = true
  console.log('[Persistence] Re-hydration requested - will import from snapshots on next effect')
}

/**
 * Save a cell edit to the changelog (instant, non-blocking).
 * This is the fast path for cell edits - avoids full snapshot export.
 *
 * @param tableId - Table ID (from tableStore)
 * @param rowId - _cs_id of the edited row
 * @param column - Column name
 * @param oldValue - Previous value
 * @param newValue - New value
 */
export async function saveCellEditToChangelog(
  tableId: string,
  rowId: number,
  column: string,
  oldValue: unknown,
  newValue: unknown
): Promise<void> {
  touchActivity()

  const entry: CellEditEntry = {
    type: 'cell_edit',
    tableId,
    ts: Date.now(),
    rowId,
    column,
    oldValue,
    newValue,
  }

  const changelog = getChangelogStorage()
  await changelog.appendEdit(entry)
}

/**
 * Save multiple cell edits to the changelog (batch, non-blocking).
 *
 * @param entries - Array of cell edit entries
 */
export async function saveCellEditsToChangelog(
  entries: Array<{
    tableId: string
    rowId: number
    column: string
    oldValue: unknown
    newValue: unknown
  }>
): Promise<void> {
  if (entries.length === 0) return

  touchActivity()

  const changelogEntries: CellEditEntry[] = entries.map((e) => ({
    type: 'cell_edit' as const,
    tableId: e.tableId,
    ts: Date.now(),
    rowId: e.rowId,
    column: e.column,
    oldValue: e.oldValue,
    newValue: e.newValue,
  }))

  const changelog = getChangelogStorage()
  await changelog.appendEdits(changelogEntries)
}

/**
 * Save a row insert to the changelog (instant, non-blocking).
 * This is the fast path for row inserts — avoids full snapshot export.
 */
export async function saveInsertRowToChangelog(
  tableId: string,
  csId: string,
  originId: string,
  insertAfterCsId: string | null,
  columnNames: string[]
): Promise<void> {
  touchActivity()

  const entry: InsertRowEntry = {
    type: 'insert_row',
    tableId,
    ts: Date.now(),
    csId,
    originId,
    insertAfterCsId,
    columnNames,
  }

  const changelog = getChangelogStorage()
  await changelog.appendEdit(entry)
}

/**
 * Save a row delete to the changelog (instant, non-blocking).
 * This is the fast path for row deletes — avoids full snapshot export.
 */
export async function saveDeleteRowToChangelog(
  tableId: string,
  csIds: string[],
  deletedRows: Record<string, unknown>[],
  columnNames: string[]
): Promise<void> {
  touchActivity()

  const entry: DeleteRowEntry = {
    type: 'delete_row',
    tableId,
    ts: Date.now(),
    csIds,
    deletedRows,
    columnNames,
  }

  const changelog = getChangelogStorage()
  await changelog.appendEdit(entry)
}

/**
 * Compact the changelog by merging pending edits into Arrow IPC snapshots.
 * Called periodically when idle or when changelog exceeds threshold.
 *
 * Flow:
 * 1. Check if compaction needed (entry count or idle time)
 * 2. Export affected tables to snapshot (changelog already applied to DuckDB)
 * 3. Clear changelog for those tables
 *
 * @param force - If true, compact regardless of thresholds
 * @returns Number of tables compacted
 */
export async function compactChangelog(force = false): Promise<number> {
  const changelog = getChangelogStorage()

  // Check if compaction is needed
  const totalEntries = await changelog.getTotalChangelogCount()

  // Update pending count in UI store (for status bar indicator)
  const { useUIStore } = await import('@/stores/uiStore')
  useUIStore.getState().setPendingChangelogCount(totalEntries)

  if (!force && totalEntries === 0) {
    return 0
  }

  const idleTime = Date.now() - lastActivityTimestamp
  const shouldCompact = force ||
    totalEntries >= COMPACTION_THRESHOLD ||
    (totalEntries > 0 && idleTime >= COMPACTION_IDLE_TIMEOUT)

  if (!shouldCompact) {
    return 0
  }

  console.log(`[Persistence] Starting changelog compaction (${totalEntries} entries, idle ${Math.round(idleTime / 1000)}s)...`)

  // Mark compaction as running
  useUIStore.getState().setCompactionStatus('running')

  // Use Web Locks to prevent concurrent compaction across tabs
  let compactedCount = 0

  try {
    await navigator.locks.request('cleanslate-compaction', async () => {
      // Get all changelog entries grouped by table
      const allEntries = await changelog.getAllChangelogs()
      const tableIds = new Set(allEntries.map((e) => e.tableId))

      // Get table names for each tableId
      const tableState = useTableStore.getState()

      // Initialize DuckDB connection once for all checks
      const db = await initDuckDB()
      const conn = await getConnection()

      for (const tableId of tableIds) {
        const table = tableState.tables.find((t) => t.id === tableId)
        if (!table) {
          console.warn(`[Persistence] Compaction: table ${tableId} not found, clearing orphaned entries`)
          await changelog.clearChangelog(tableId)
          continue
        }

        try {
          // Skip tables that are currently being transformed (have staging table)
          // During transforms, the table is temporarily renamed to _staging_{tableName}
          const stagingCheck = await conn.query(`
            SELECT COUNT(*) as cnt FROM information_schema.tables
            WHERE table_name = '_staging_${table.name}'
          `)
          const hasStagingTable = Number(stagingCheck.toArray()[0]?.toJSON()?.cnt ?? 0) > 0
          if (hasStagingTable) {
            console.log(`[Persistence] Compaction: skipping ${table.name} - transform in progress`)
            continue
          }

          // Export table to snapshot (includes all changes since changelog is already in DuckDB)
          // Track in UI store for status bar indicator
          useUIStore.getState().addSavingTable(table.name)

          // CRITICAL: Normalize snapshotId to lowercase to match timeline-engine's naming convention.
          const normalizedSnapshotId = table.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

          await exportTableToSnapshot(db, conn, table.name, normalizedSnapshotId, {
            onChunkProgress: (current, total, tableName) => {
              useUIStore.getState().setChunkProgress({ tableName, currentChunk: current, totalChunks: total })
            },
          })

          // Mark table as clean and recently saved to prevent redundant debounced save
          // This is critical - without this, the debounced save subscription will
          // also export the same data again since it doesn't know compaction just saved it
          useUIStore.getState().markTableClean(tableId)
          markTableAsRecentlySaved(tableId, 10_000) // 10s window for large tables

          useUIStore.getState().removeSavingTable(table.name)

          // Clear changelog for this table
          await changelog.clearChangelog(tableId)

          compactedCount++
          console.log(`[Persistence] Compacted ${table.name}`)
        } catch (err) {
          console.error(`[Persistence] Compaction failed for ${table.name}:`, err)
        }
      }
    })
  } catch (err) {
    console.error('[Persistence] Compaction lock acquisition failed:', err)
  }

  // Mark compaction as idle and update pending count
  const updatedCount = await changelog.getTotalChangelogCount()
  useUIStore.getState().setCompactionStatus('idle')
  useUIStore.getState().setPendingChangelogCount(updatedCount)

  if (compactedCount > 0) {
    console.log(`[Persistence] Compaction complete: ${compactedCount} table(s)`)
  }

  return compactedCount
}

// Track tables that were just saved (e.g., during import) to skip redundant auto-saves
// Stores expiry timestamp (Date.now() + duration) for each table
const recentlySavedTables = new Map<string, number>()
const DEFAULT_RECENTLY_SAVED_WINDOW_MS = 5_000 // 5 second default window

// Track when each table first became dirty (for maxWait enforcement)
// This ensures saves happen even during continuous rapid editing
const firstDirtyAt = new Map<string, number>()

/**
 * Mark a table as recently saved to prevent redundant auto-save.
 * Called by useDuckDB after direct snapshot export during import,
 * and by timeline-engine after snapshot creation.
 *
 * @param tableId - The table ID to mark
 * @param durationMs - Optional custom duration (defaults to DEFAULT_RECENTLY_SAVED_WINDOW_MS)
 */
export function markTableAsRecentlySaved(tableId: string, durationMs?: number): void {
  // Store expiry timestamp (when this entry should expire)
  const effectiveWindow = durationMs ?? DEFAULT_RECENTLY_SAVED_WINDOW_MS
  const expiryTime = Date.now() + effectiveWindow
  recentlySavedTables.set(tableId, expiryTime)
  console.log(`[Persistence] Marked ${tableId} as recently saved (will skip auto-save for ${effectiveWindow}ms)`)
}

/**
 * Force save all dirty tables immediately.
 * This is a fallback for when tables get stuck in "unsaved" state.
 * Bypasses debounce and saves all dirty tables to snapshots.
 */
export async function forceSaveAll(): Promise<void> {
  const { useUIStore } = await import('@/stores/uiStore')
  const { useTableStore } = await import('@/stores/tableStore')

  const uiState = useUIStore.getState()
  const tableState = useTableStore.getState()

  // Get all dirty table IDs
  const dirtyIds = Array.from(uiState.dirtyTableIds)

  if (dirtyIds.length === 0) {
    console.log('[Persistence] forceSaveAll: No dirty tables to save')
    return
  }

  console.log(`[Persistence] forceSaveAll: Saving ${dirtyIds.length} dirty table(s)...`)

  // Set status to saving
  uiState.setPersistenceStatus('saving')

  const db = await initDuckDB()
  const conn = await getConnection()

  let savedCount = 0
  let errorCount = 0

  for (const tableId of dirtyIds) {
    const table = tableState.tables.find(t => t.id === tableId)
    if (!table) {
      console.warn(`[Persistence] forceSaveAll: Table ${tableId} not found, skipping`)
      continue
    }

    try {
      // Track in UI store
      uiState.addSavingTable(table.name)

      // CRITICAL: Normalize snapshotId to lowercase to match timeline-engine's naming convention.
      const normalizedSnapshotId = table.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

      // Export to snapshot
      await exportTableToSnapshot(db, conn, table.name, normalizedSnapshotId, {
        onChunkProgress: (current, total, tableName) => {
          uiState.setChunkProgress({ tableName, currentChunk: current, totalChunks: total })
        },
      })

      // Mark table as clean
      uiState.markTableClean(tableId)
      uiState.removeSavingTable(table.name)

      savedCount++
      console.log(`[Persistence] forceSaveAll: Saved ${table.name}`)
    } catch (err) {
      console.error(`[Persistence] forceSaveAll: Failed to save ${table.name}:`, err)
      uiState.removeSavingTable(table.name)
      errorCount++
    }
  }

  // Force compact changelog as well
  try {
    await compactChangelog(true)
  } catch (err) {
    console.error('[Persistence] forceSaveAll: Compaction failed:', err)
  }

  // Update status
  if (errorCount > 0) {
    uiState.setPersistenceStatus('error')
  } else if (savedCount > 0) {
    uiState.setPersistenceStatus('saved')
  }

  console.log(`[Persistence] forceSaveAll complete: ${savedCount} saved, ${errorCount} errors`)
}

/**
 * Check if a table was recently saved (within its time window).
 * Returns true if the table should be skipped, false otherwise.
 * Does NOT consume the flag - allows multiple subscription calls to see it.
 */
function wasRecentlySaved(tableId: string): boolean {
  const expiryTime = recentlySavedTables.get(tableId)
  if (!expiryTime) return false

  if (Date.now() >= expiryTime) {
    // Expired - clean up and return false
    recentlySavedTables.delete(tableId)
    return false
  }

  // Still within window - don't delete, just return true
  return true
}

/**
 * Get debounce time based on table row count.
 * Larger tables get longer debounce to batch more edits per save.
 */
function getDebounceTime(rowCount: number): number {
  if (rowCount > 1_000_000) return 10_000  // 10s for >1M rows
  if (rowCount > 500_000) return 5_000     // 5s for >500k rows
  if (rowCount > 100_000) return 3_000     // 3s for >100k rows
  return 2_000                              // 2s default
}

/**
 * Get maximum wait time before forcing a save.
 * This ensures saves happen even during continuous rapid editing.
 * Larger tables get more time to batch edits before forcing a save.
 */
function getMaxWaitTime(rowCount: number): number {
  if (rowCount > 1_000_000) return 45_000  // 45s for >1M rows
  if (rowCount > 500_000) return 30_000    // 30s for >500k rows
  if (rowCount > 100_000) return 20_000    // 20s for >100k rows
  return 15_000                             // 15s default
}

/**
 * Migrate legacy snapshots that lack a _manifest.json.
 *
 * Detects snapshots with _part_N.arrow files but no manifest, and creates
 * a manifest from the existing files. Does NOT re-chunk — just adds metadata.
 * Re-chunking to 50k-row shards happens lazily on next export.
 *
 * Called once at startup, after cleanupCorruptSnapshots().
 */
export async function migrateLegacySnapshots(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()

    let appDir: FileSystemDirectoryHandle
    try {
      appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    } catch {
      return // No app directory yet
    }

    let snapshotsDir: FileSystemDirectoryHandle
    try {
      snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    } catch {
      return // No snapshots directory yet
    }

    // Collect all snapshot files
    const allFiles: string[] = []
    // @ts-expect-error entries() exists at runtime
    for await (const [name, handle] of snapshotsDir.entries()) {
      if (handle.kind === 'file') {
        allFiles.push(name)
      }
    }

    // Group files by snapshot ID (strip _part_N.arrow, _shard_N.arrow, .arrow suffixes)
    const snapshotGroups = new Map<string, string[]>()
    for (const fileName of allFiles) {
      if (!fileName.endsWith('.arrow')) continue
      if (fileName.endsWith('.arrow.tmp')) continue // Skip temp files

      // Extract snapshot ID
      let snapshotId: string
      const shardMatch = fileName.match(/^(.+)_shard_\d+\.arrow$/)
      const partMatch = fileName.match(/^(.+)_part_\d+\.arrow$/)
      const singleMatch = fileName.match(/^(.+)\.arrow$/)

      if (shardMatch) {
        snapshotId = shardMatch[1]
      } else if (partMatch) {
        snapshotId = partMatch[1]
      } else if (singleMatch) {
        snapshotId = singleMatch[1]
      } else {
        continue
      }

      // Skip internal snapshots
      if (snapshotId.startsWith('original_')) continue
      if (snapshotId.startsWith('snapshot_')) continue
      if (snapshotId.startsWith('_timeline_')) continue
      if (snapshotId.startsWith('_diff_')) continue

      const group = snapshotGroups.get(snapshotId) || []
      group.push(fileName)
      snapshotGroups.set(snapshotId, group)
    }

    let migratedCount = 0

    for (const [snapshotId, files] of snapshotGroups) {
      // Skip if manifest already exists
      const manifestFileName = `${snapshotId}_manifest.json`
      if (allFiles.includes(manifestFileName)) continue

      // Skip if already using new shard naming (already has manifest or is new format)
      const hasShardFiles = files.some(f => f.includes('_shard_'))
      if (hasShardFiles) continue

      // This is a legacy snapshot — build manifest from existing files
      const isMultiPart = files.some(f => f.includes('_part_'))
      const isSingle = files.length === 1 && files[0] === `${snapshotId}.arrow`

      if (!isMultiPart && !isSingle) continue // Unknown format

      const shards: Array<{ index: number; fileName: string; rowCount: number; byteSize: number }> = []

      if (isMultiPart) {
        // Multi-part legacy: _part_0.arrow, _part_1.arrow, ...
        const partFiles = files
          .filter(f => f.includes('_part_'))
          .sort((a, b) => {
            const numA = parseInt(a.match(/_part_(\d+)/)?.[1] || '0')
            const numB = parseInt(b.match(/_part_(\d+)/)?.[1] || '0')
            return numA - numB
          })

        for (let i = 0; i < partFiles.length; i++) {
          const fileName = partFiles[i]
          try {
            const handle = await snapshotsDir.getFileHandle(fileName, { create: false })
            const file = await handle.getFile()
            shards.push({
              index: i,
              fileName,
              rowCount: 0, // Unknown — will be filled on first full load
              byteSize: file.size,
            })
          } catch {
            console.warn(`[Migration] Could not read ${fileName}`)
          }
        }
      } else {
        // Single file legacy: snapshotId.arrow
        const fileName = `${snapshotId}.arrow`
        try {
          const handle = await snapshotsDir.getFileHandle(fileName, { create: false })
          const file = await handle.getFile()
          shards.push({
            index: 0,
            fileName,
            rowCount: 0, // Unknown
            byteSize: file.size,
          })
        } catch {
          console.warn(`[Migration] Could not read ${fileName}`)
          continue
        }
      }

      if (shards.length === 0) continue

      // Write manifest with what we know
      // rowCount=0 means "unknown, needs re-scan"
      const manifest: SnapshotManifest = {
        version: 1,
        snapshotId,
        totalRows: 0, // Unknown for legacy — filled on next full import
        totalBytes: shards.reduce((sum, s) => sum + s.byteSize, 0),
        shardSize: isMultiPart ? 100_000 : 0, // Legacy used 100k chunks
        shards: shards.map(s => ({
          index: s.index,
          fileName: s.fileName,
          rowCount: s.rowCount,
          byteSize: s.byteSize,
          minCsId: null,
          maxCsId: null,
        } satisfies ShardInfo)),
        columns: [], // Unknown — filled on next full import
        orderByColumn: '_cs_id',
        createdAt: Date.now(),
      }

      await writeManifest(manifest)
      migratedCount++
      console.log(`[Migration] Created manifest for legacy snapshot: ${snapshotId} (${shards.length} part(s))`)
    }

    if (migratedCount > 0) {
      console.log(`[Migration] Migrated ${migratedCount} legacy snapshot(s) to manifest format`)
    }
  } catch (error) {
    console.warn('[Migration] Legacy snapshot migration failed (non-fatal):', error)
  }
}

export function usePersistence() {
  const [isRestoring, setIsRestoring] = useState(true)
  const addTable = useTableStore((s) => s.addTable)

  // 1. HYDRATION: Run once on mount to restore data from Arrow IPC snapshots
  //    Can also be triggered after worker restart via requestRehydration()
  useEffect(() => {
    // Prevent double-hydration from React StrictMode
    // BUT allow re-hydration if explicitly requested (after worker restart)
    if (hydrationPromise && !rehydrationRequested) {
      console.log('[Persistence] Hydration already in progress, waiting...')
      hydrationPromise.then(() => setIsRestoring(false))
      return
    }

    // Clear the re-hydration flag if set
    const isRehydration = rehydrationRequested
    if (rehydrationRequested) {
      rehydrationRequested = false
      console.log('[Persistence] Re-hydration triggered after worker restart')
    }

    const hydrate = async () => {
      console.log('[Persistence] Starting hydration...', isRehydration ? '(re-hydration)' : '')

      try {
        // Clear any existing tables to prevent duplicates
        // This ensures snapshots are the single source of truth
        // Skip during re-hydration - tables were already cleared by worker restart
        const existingTables = useTableStore.getState().tables
        if (existingTables.length > 0 && !isRehydration) {
          console.log(`[Persistence] Clearing ${existingTables.length} existing table(s) before hydration`)
          useTableStore.getState().clearTables()
        }

        const db = await initDuckDB()
        const conn = await getConnection()

        // Wait for state restoration to complete (sets __CLEANSLATE_SAVED_TABLE_IDS__)
        // Skip during re-hydration - state restoration already happened
        let savedActiveTableId: string | null = null
        if (!isRehydration) {
          const { stateRestorationPromise } = await import('@/hooks/useDuckDB')
          if (stateRestorationPromise) {
            await stateRestorationPromise
            console.log('[Persistence] State restoration complete, proceeding with hydration')
          }
          // Get saved active table ID for lazy hydration
          savedActiveTableId = (window as Window & { __CLEANSLATE_SAVED_ACTIVE_TABLE_ID__?: string | null }).__CLEANSLATE_SAVED_ACTIVE_TABLE_ID__ ?? null
        }

        // Clean up any corrupt 0-byte files from failed writes
        await cleanupCorruptSnapshots()

        // Clean up any orphaned diff files that survived browser refresh
        await cleanupOrphanedDiffFiles()

        // Clean up duplicate case-mismatched files (migration from pre-fix state)
        await cleanupDuplicateCaseSnapshots()

        // Migrate legacy snapshots (no manifest) to manifest format
        await migrateLegacySnapshots()

        // List all saved snapshot files
        const snapshots = await listSnapshots()

        if (snapshots.length === 0) {
          console.log('[Persistence] No saved snapshots found.')
          // Clear stale app-state.json to prevent orphan metadata issues
          try {
            const { clearAppState } = await import('@/lib/persistence/state-persistence')
            await clearAppState()
            console.log('[Persistence] Cleared stale app-state.json')
          } catch {
            // Ignore if already cleared
          }
          setIsRestoring(false)
          return
        }

        // Filter to only get unique table names (remove _part_N/_shard_N/_manifest suffixes and duplicates)
        // Also filter out internal timeline tables (original_*, snapshot_*, _timeline_*)
        const uniqueTables = [...new Set(
          snapshots
            .map(name => name
              .replace(/_part_\d+$/, '')
              .replace(/_shard_\d+$/, '')
              .replace(/_manifest$/, '')
            )
            .filter(name => {
              // Skip internal timeline tables
              if (name.startsWith('original_')) return false  // timeline original snapshots
              if (name.startsWith('snapshot_')) return false  // timeline snapshots
              if (name.startsWith('_timeline_')) return false  // timeline internal
              if (name.startsWith('_diff_')) return false      // diff temporary tables
              return true
            })
        )]

        console.log(`[Persistence] Found ${uniqueTables.length} tables to restore:`, uniqueTables)

        // Get saved table IDs for consistency
        const savedTableIds = (window as Window & { __CLEANSLATE_SAVED_TABLE_IDS__?: Record<string, string> }).__CLEANSLATE_SAVED_TABLE_IDS__

        // Build normalized lookup map: lowercase table name → original tableId
        // This handles case mismatch between snapshot filenames (lowercase) and app-state.json (original casing)
        const normalizedSavedTableIds = new Map<string, string>()
        if (savedTableIds) {
          for (const [name, id] of Object.entries(savedTableIds)) {
            const normalizedName = name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
            normalizedSavedTableIds.set(normalizedName, id)
          }
        }

        // Build tableName → tableId mapping using normalized lookup
        const tableNameToId = new Map<string, string>()
        for (const tableName of uniqueTables) {
          const tableId = normalizedSavedTableIds.get(tableName) ?? tableName
          tableNameToId.set(tableName, tableId)
        }

        // LAZY HYDRATION (Phase 4): Determine which table to thaw
        // Priority: savedActiveTableId > first table
        let tableToThaw: string | null = null

        if (savedActiveTableId) {
          // Find the table name for the saved active table ID
          for (const [name, id] of tableNameToId) {
            if (id === savedActiveTableId) {
              tableToThaw = name
              break
            }
          }
        }

        // Fallback to first table if savedActiveTableId not found
        if (!tableToThaw && uniqueTables.length > 0) {
          tableToThaw = uniqueTables[0]
          console.log(`[Persistence] Saved active table not found, using first table: ${tableToThaw}`)
        }

        console.log(`[Persistence] Lazy hydration - will thaw: ${tableToThaw}, freeze ${uniqueTables.length - 1} other table(s)`)

        const markTableFrozen = useTableStore.getState().markTableFrozen
        let restoredCount = 0
        const tableIdToName = new Map<string, string>()

        // Build normalized lookup for savedTables: lowercase name → original savedTable entry
        // This allows matching snapshot filenames (lowercase) to app-state entries (original casing)
        const savedTables = (window as Window & { __CLEANSLATE_SAVED_TABLES__?: Array<{ id: string; name: string; columns: Array<{ name: string; type: string; nullable: boolean }>; rowCount: number; columnOrder?: string[] }> }).__CLEANSLATE_SAVED_TABLES__
        const normalizedSavedTables = new Map<string, { id: string; name: string; columns: Array<{ name: string; type: string; nullable: boolean }>; rowCount: number; columnOrder?: string[] }>()
        if (savedTables) {
          for (const t of savedTables) {
            const normalizedName = t.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
            normalizedSavedTables.set(normalizedName, t)
          }
        }

        for (const snapshotName of uniqueTables) {
          try {
            const tableId = tableNameToId.get(snapshotName) ?? snapshotName
            const savedTable = normalizedSavedTables.get(snapshotName)
            // Use original name from app-state.json if available, otherwise use snapshot name
            const tableName = savedTable?.name ?? snapshotName

            // Skip if table already exists in store (prevents duplicates on hot reload)
            const existingTables = useTableStore.getState().tables
            const normalizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
            if (existingTables.some(t => {
              const normalizedExisting = t.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
              return normalizedExisting === normalizedTableName || t.id === tableId
            })) {
              console.log(`[Persistence] Skipping ${tableName} - already in store`)
              continue
            }

            const shouldThaw = snapshotName === tableToThaw

            if (shouldThaw) {
              // THAW: Import from Arrow IPC snapshot into DuckDB (full hydration)
              // Use snapshotName (lowercase) for snapshot file, tableName (original casing) for DuckDB table
              await importTableFromSnapshot(db, conn, snapshotName, tableName)

              // Auto-migrate sequential _cs_id to gap-based (one-time migration)
              await migrateToGapBasedCsId(tableName)

              // Get metadata from DuckDB
              const cols = await getTableColumns(tableName)
              const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
              const rowCount = Number(countResult.toArray()[0].toJSON().count)

              // Track tableId → tableName mapping for changelog replay
              tableIdToName.set(tableId, tableName)

              addTable(tableName, cols, rowCount, tableId)
              // Restore column order if saved
              if (savedTable?.columnOrder) {
                useTableStore.getState().setColumnOrder(tableId, savedTable.columnOrder)
              }
              console.log(`[Persistence] Thawed ${tableName} (${rowCount.toLocaleString()} rows)`)
            } else {
              // FREEZE: Add metadata only, don't import into DuckDB
              if (savedTable) {
                // Use saved metadata with original table name
                addTable(tableName, savedTable.columns, savedTable.rowCount, tableId)
                // Restore column order if saved
                if (savedTable.columnOrder) {
                  useTableStore.getState().setColumnOrder(tableId, savedTable.columnOrder)
                }
                markTableFrozen(tableId)
                console.log(`[Persistence] Frozen ${tableName} (${savedTable.rowCount.toLocaleString()} rows) - metadata from app-state`)
              } else {
                // Fallback: Read snapshot metadata directly (requires brief import)
                console.log(`[Persistence] No saved metadata for ${snapshotName}, reading from snapshot metadata...`)
                await importTableFromSnapshot(db, conn, snapshotName, tableName)
                const cols = await getTableColumns(tableName)
                const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
                const rowCount = Number(countResult.toArray()[0].toJSON().count)

                // Drop from DuckDB memory (it's frozen, not active)
                await conn.query(`DROP TABLE IF EXISTS "${tableName}"`)

                addTable(tableName, cols, rowCount, tableId)
                markTableFrozen(tableId)
                console.log(`[Persistence] Frozen ${tableName} (${rowCount.toLocaleString()} rows) - metadata from snapshot`)
              }
            }

            restoredCount++
          } catch (err) {
            console.error(`[Persistence] Failed to restore ${snapshotName}:`, err)
          }
        }

        // Replay changelog entries only for the thawed table
        // (Frozen tables will replay when thawed via switchToTable)
        if (tableIdToName.size > 0) {
          const replayedCount = await replayChangelogEntries(conn, tableIdToName)
          if (replayedCount > 0) {
            console.log(`[Persistence] Applied ${replayedCount} pending cell edits from changelog`)
          }
        }

        if (restoredCount > 0) {
          const frozenCount = restoredCount - 1
          toast.success(`Restored ${restoredCount} table(s) from storage${frozenCount > 0 ? ` (${frozenCount} on disk)` : ''}`)

          // Set active table to the thawed table
          const thawedTableId = tableNameToId.get(tableToThaw!)
          if (thawedTableId) {
            useTableStore.getState().setActiveTable(thawedTableId)
            console.log(`[Persistence] Set active table to thawed: ${thawedTableId}`)
          }
        }
      } catch (err) {
        console.error('[Persistence] Critical hydration failure:', err)
        toast.error('Failed to restore data')
      } finally {
        setIsRestoring(false)
        hydrationPromise = null
      }
    }

    hydrationPromise = hydrate()
  }, [addTable])

  // 2. SAVING: Call this to save a specific table to snapshot
  // Uses queue with coalescing to prevent concurrent exports
  // priority: when true, MUST save even if previous save marked table clean (for row inserts/deletes)
  const saveTable = useCallback(async (tableName: string, priority = false): Promise<void> => {
    // If already saving OR starting to save this table, queue for re-save after completion
    // Check BOTH saveInProgress AND saveStarting SYNCHRONOUSLY before any async work.
    // saveStarting guards against the race condition where multiple concurrent calls
    // pass this check before any of them set saveInProgress (which happens after the first await).
    if (saveInProgress.has(tableName) || saveStarting.has(tableName)) {
      console.log(`[Persistence] ${tableName} save in progress, queuing...${priority ? ' (PRIORITY)' : ''}`)
      const existingPriority = pendingSave.get(tableName) || false
      pendingSave.set(tableName, priority || existingPriority)
      // Track pending in UI store for indicator
      useUIStore.getState().addPendingTable(tableName)
      // Return existing promise if available, otherwise return a promise that never resolves
      // (the caller doesn't await this anyway, and the real save will complete eventually)
      return saveInProgress.get(tableName) ?? new Promise(() => {})
    }

    // CRITICAL: Mark save as starting SYNCHRONOUSLY BEFORE any await.
    // This prevents concurrent saves from both proceeding past the check above.
    saveStarting.add(tableName)

    // CRITICAL: Track in savingTables SYNCHRONOUSLY BEFORE any await.
    // This prevents a race condition where tests poll savingTables.size === 0
    // during the gap between saveTable being called and the first await yielding.
    // useUIStore is imported at module level, so we can use it synchronously.
    useUIStore.getState().addSavingTable(tableName)
    useUIStore.getState().removePendingTable(tableName)

    // CRITICAL: Skip save if a timeline replay is in progress
    // During replay, tables are dropped and recreated. Attempting to export
    // during this transient state causes "table does not exist" errors.
    // The save will be triggered again after replay completes.
    const { useTimelineStore } = await import('@/stores/timelineStore')
    if (useTimelineStore.getState().isReplaying) {
      console.log(`[Persistence] Skipping save for ${tableName} - replay in progress`)
      saveStarting.delete(tableName)  // Clean up early bailout
      useUIStore.getState().removeSavingTable(tableName)  // Clean up early bailout
      return
    }

    // CRITICAL: Create and register promise SYNCHRONOUSLY before any await
    // This prevents race conditions when multiple calls happen nearly simultaneously
    const savePromise = (async () => {
      // Dynamic import inside the IIFE - after promise is registered
      const { useUIStore } = await import('@/stores/uiStore')
      const uiStore = useUIStore.getState()

      // Note: addSavingTable/removePendingTable already called above synchronously
      // No need to call again here

      try {
        // CRITICAL: Flush any pending batch edits for this table before exporting
        // This ensures all cell edits are captured in the snapshot file, even if
        // the user made rapid edits that haven't been flushed yet.
        const tableForFlush = useTableStore.getState().tables.find(t => t.name === tableName)
        if (tableForFlush) {
          const { useEditBatchStore } = await import('@/stores/editBatchStore')
          const hasPendingEdits = useEditBatchStore.getState().hasPendingEdits(tableForFlush.id)
          if (hasPendingEdits) {
            console.log(`[Persistence] Flushing pending edits before saving ${tableName}`)
            await useEditBatchStore.getState().flushAll()
          }
        }

        const db = await initDuckDB()
        const conn = await getConnection()

        // Set saving status when export starts
        if (uiStore.persistenceStatus === 'dirty') {
          uiStore.setPersistenceStatus('saving')
        }

        console.log(`[Persistence] Saving ${tableName}...`)

        // CRITICAL: Normalize snapshotId to lowercase to match timeline-engine's naming convention.
        // This prevents duplicate snapshot files in OPFS which is case-sensitive.
        const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

        // Export table to snapshot (overwrites existing snapshot)
        // Pass chunk progress callback for large table UI feedback
        await exportTableToSnapshot(db, conn, tableName, normalizedSnapshotId, {
          onChunkProgress: (current, total, table) => {
            useUIStore.getState().setChunkProgress({ tableName: table, currentChunk: current, totalChunks: total })
          },
        })

        // Mark table as clean after successful snapshot export
        const tableForClean = useTableStore.getState().tables.find(t => t.name === tableName)
        if (tableForClean) {
          useUIStore.getState().markTableClean(tableForClean.id)
        }

        console.log(`[Persistence] ${tableName} saved`)
      } catch (err) {
        console.error(`[Persistence] Save failed for ${tableName}:`, err)
        useUIStore.getState().setPersistenceStatus('error')
        toast.error(`Failed to save ${tableName}`)
      }
    })()

    // Register IMMEDIATELY (synchronous) - before the IIFE's first await yields
    saveInProgress.set(tableName, savePromise)
    // Clear saveStarting now that saveInProgress is set
    // Any new calls to saveTable will see saveInProgress.has() === true
    saveStarting.delete(tableName)

    // Handle cleanup and re-save after promise settles
    // CRITICAL: This must be SYNCHRONOUS (not async) to prevent race conditions.
    // If we use `await import()` here, there's a window during the await where:
    // 1. saveInProgress is deleted (synchronous)
    // 2. A new save starts (calls addSavingTable)
    // 3. Old finally continues and removes the NEW save's savingTable entry
    // Result: savingTables empty but saveInProgress has the new entry = test race condition
    savePromise.finally(() => {
      saveInProgress.delete(tableName)

      // If another save was requested while we were saving, re-save only if:
      // 1. Table is actually dirty, OR
      // 2. The pending save was marked as priority (e.g., row insert/delete)
      // Priority saves MUST run because they contain data changes that weren't
      // captured in the previous save (due to race between saves).
      //
      // CRITICAL: Check pending save BEFORE calling removeSavingTable.
      // This prevents a race condition where:
      // 1. removeSavingTable sets savingTables.size to 0
      // 2. Test polls and sees no saves in progress
      // 3. We start the pending save, but test already moved on
      const isPendingPriority = pendingSave.get(tableName)
      const willResave = isPendingPriority !== undefined
      console.log(`[Persistence] ${tableName} save finished - pendingPriority: ${isPendingPriority}, willResave: ${willResave}, pendingSave keys: ${Array.from(pendingSave.keys()).join(',')}`)

      // Remove from saving tables in UI store
      // But if we're about to re-save, keep it in savingTables to prevent poll race
      // NOTE: useUIStore is imported at module level (line 22), so no await needed
      if (!willResave) {
        useUIStore.getState().removeSavingTable(tableName)
      }

      if (willResave) {
        pendingSave.delete(tableName)

        const table = useTableStore.getState().tables.find(t => t.name === tableName)
        const tableIdForCheck = table?.id
        const isDirty = tableIdForCheck && useUIStore.getState().dirtyTableIds.has(tableIdForCheck)

        if (isPendingPriority || isDirty) {
          console.log(`[Persistence] ${tableName} re-saving... (priority: ${isPendingPriority}, dirty: ${isDirty})`)
          // Note: saveTable will call addSavingTable internally, keeping the table in savingTables
          saveTable(tableName, isPendingPriority).catch(console.error)
        } else {
          console.log(`[Persistence] ${tableName} is clean (not priority), dropping pending save`)
          // Now safe to remove since we're not re-saving
          useUIStore.getState().removeSavingTable(tableName)
        }
      }
    })

    return savePromise
  }, [])

  // 3. DELETE: Call this when a table is deleted to remove its snapshot file
  const deleteTableSnapshot = useCallback(async (tableName: string) => {
    try {
      // CRITICAL: Normalize table name to match how snapshots are saved (lowercase, underscores)
      // Without this, deletion of "My_Table" would look for "My_Table.arrow" but file is "my_table.arrow"
      const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      await deleteSnapshot(normalizedSnapshotId)
      console.log(`[Persistence] Deleted snapshot for ${tableName} (normalized: ${normalizedSnapshotId})`)
    } catch (err) {
      console.error(`[Persistence] Failed to delete snapshot for ${tableName}:`, err)
    }
  }, [])

  // 4. SAVE ALL: Save all tables (useful for manual "Save All" button)
  const saveAllTables = useCallback(async () => {
    const currentTables = useTableStore.getState().tables
    console.log(`[Persistence] Saving all ${currentTables.length} tables...`)

    for (const table of currentTables) {
      await saveTable(table.name)
    }

    toast.success(`Saved ${currentTables.length} table(s)`)
  }, [saveTable])

  // 5. CLEAR: Remove all snapshot files from OPFS
  const clearStorage = useCallback(async () => {
    try {
      const snapshots = await listSnapshots()
      const uniqueTables = [...new Set(
        snapshots.map(name => name
          .replace(/_part_\d+$/, '')
          .replace(/_shard_\d+$/, '')
          .replace(/_manifest$/, '')
        )
      )]

      for (const tableName of uniqueTables) {
        await deleteSnapshot(tableName)
      }

      console.log(`[Persistence] Cleared ${uniqueTables.length} table snapshots`)
      toast.success('Storage cleared')
    } catch (err) {
      console.error('[Persistence] Failed to clear storage:', err)
      toast.error('Failed to clear storage')
    }
  }, [])

  // 6. SAVE ON CHANGE: Debounced save when table data changes OR new tables added
  // This ensures edits are persisted quickly rather than waiting for 30s interval
  // Uses maxWait to guarantee saves happen even during continuous rapid editing
  useEffect(() => {
    if (isRestoring) return

    let saveTimeout: NodeJS.Timeout | null = null
    let maxWaitTimeout: NodeJS.Timeout | null = null
    const knownTableIds = new Set<string>()
    const lastDataVersions = new Map<string, number>()

    // Initialize with current tables (these were restored from snapshots, don't re-save)
    useTableStore.getState().tables.forEach(t => {
      knownTableIds.add(t.id)
      lastDataVersions.set(t.id, t.dataVersion ?? 0)
    })

    // Helper to execute save and clear firstDirtyAt tracking
    // isPriority: when true, ensures save runs even if a previous save marked table clean
    const executeSave = (tables: { id: string; name: string }[], reason: string, rowCount: number, isPriority = false) => {
      console.log(`[Persistence] ${reason}: ${tables.map(t => t.name).join(', ')} (${rowCount.toLocaleString()} rows)${isPriority ? ' [PRIORITY]' : ''}`)
      tables.forEach(t => {
        saveTable(t.name, isPriority)
          .then(() => {
            // Clear firstDirtyAt after successful save
            firstDirtyAt.delete(t.id)
          })
          .catch(console.error)
      })
    }

    const unsubscribe = useTableStore.subscribe(async (state) => {
      const tablesToSave: { id: string; name: string; rowCount: number }[] = []

      for (const table of state.tables) {
        const isNewTable = !knownTableIds.has(table.id)
        const currentVersion = table.dataVersion ?? 0
        const lastVersion = lastDataVersions.get(table.id) ?? 0
        const hasDataChanged = currentVersion > lastVersion

        // Skip tables that were just saved (e.g., during import)
        // This prevents redundant saves - the table is already persisted
        // Uses time-window check to handle multiple subscription calls
        // EXCEPTION: Don't skip if this table has a priority save requested
        // (e.g., row insert/transform completed - data changed and needs saving)
        const { useUIStore } = await import('@/stores/uiStore')
        const hasPriorityRequest = useUIStore.getState().hasPrioritySave(table.id)
        if (wasRecentlySaved(table.id) && !hasPriorityRequest) {
          console.log(`[Persistence] Skipping ${table.name} - was just saved during import`)
          knownTableIds.add(table.id)           // Track it as known
          lastDataVersions.set(table.id, currentVersion)
          continue
        }

        // Skip tables currently being saved - prevents redundant saves when
        // subscription fires multiple times during a single save operation
        // EXCEPTION: If this is a priority save request, we need to queue it
        // so it runs after the current save completes
        if (saveInProgress.has(table.name)) {
          // If there's a priority request while saving, we need to ensure it runs after
          // by calling saveTable which will queue it as a pending save
          if (hasPriorityRequest) {
            console.log(`[Persistence] Priority save requested for ${table.name} while save in progress - queueing`)
            saveTable(table.name, true).catch(console.error)
          }
          knownTableIds.add(table.id)
          lastDataVersions.set(table.id, currentVersion)
          continue
        }

        // CRITICAL: Include tables with priority save requests even if dataVersion didn't change
        // This handles LOCAL_ONLY_COMMANDS (row insert/delete) that skip dataVersion bump
        // to avoid grid scroll reset but still need their data persisted to snapshot
        if (isNewTable || hasDataChanged || hasPriorityRequest) {
          tablesToSave.push({ id: table.id, name: table.name, rowCount: table.rowCount })
          knownTableIds.add(table.id)
          lastDataVersions.set(table.id, currentVersion)

          if (isNewTable) {
            console.log(`[Persistence] New table detected: ${table.name}`)
          }
          if (hasPriorityRequest && !hasDataChanged && !isNewTable) {
            console.log(`[Persistence] Priority save for ${table.name} (no dataVersion change)`)
          }
        }
      }

      if (tablesToSave.length === 0) return

      // Filter out internal timeline tables and diff tables from saving
      const filteredTables = tablesToSave.filter(t => {
        if (t.name.startsWith('original_')) return false  // timeline original snapshots
        if (t.name.startsWith('snapshot_')) return false  // timeline snapshots
        if (t.name.startsWith('_timeline_')) return false  // timeline internal
        if (t.name.startsWith('_diff_')) return false      // diff temporary tables
        return true
      })

      if (filteredTables.length === 0) return

      // Mark tables dirty IMMEDIATELY (before debounce)
      // This shows the "Unsaved changes" indicator right away
      const { useUIStore } = await import('@/stores/uiStore')
      for (const table of filteredTables) {
        useUIStore.getState().markTableDirty(table.id)

        // Track when table first became dirty (for maxWait enforcement)
        if (!firstDirtyAt.has(table.id)) {
          firstDirtyAt.set(table.id, Date.now())
        }
      }

      // Compute adaptive debounce based on largest table being saved
      // Larger tables get longer debounce to batch more edits per export
      const maxRowCount = Math.max(...filteredTables.map(t => t.rowCount))
      const debounceTime = getDebounceTime(maxRowCount)
      const maxWait = getMaxWaitTime(maxRowCount)

      // Check for PRIORITY saves (transforms) - these bypass debounce entirely
      // This prevents data loss when user refreshes immediately after a transform
      const prioritySaveIds = useUIStore.getState().getPrioritySaveTables()
      const priorityTables = filteredTables.filter(t => prioritySaveIds.includes(t.id))

      if (priorityTables.length > 0) {
        // Force IMMEDIATE save for priority tables (e.g., after transform completion)
        if (saveTimeout) clearTimeout(saveTimeout)
        if (maxWaitTimeout) clearTimeout(maxWaitTimeout)

        console.log(`[Persistence] Priority save triggered for: ${priorityTables.map(t => t.name).join(', ')}`)

        // Clear priority flags before saving
        for (const table of priorityTables) {
          useUIStore.getState().clearPrioritySave(table.id)
        }

        executeSave(
          priorityTables,
          'Priority save (transform completed)',
          maxRowCount,
          true  // isPriority = true: MUST save even if previous save marked table clean
        )

        // Still schedule debounced save for remaining non-priority tables
        const remainingTables = filteredTables.filter(
          t => !priorityTables.some(p => p.id === t.id)
        )
        if (remainingTables.length > 0) {
          saveTimeout = setTimeout(() => {
            executeSave(remainingTables, 'Debounced save', maxRowCount)
          }, debounceTime)
        }
        return
      }

      // Check if any table has exceeded maxWait - force immediate save
      const now = Date.now()
      const tablesExceedingMaxWait = filteredTables.filter(t => {
        const dirtyTime = firstDirtyAt.get(t.id)
        return dirtyTime && (now - dirtyTime >= maxWait)
      })

      if (tablesExceedingMaxWait.length > 0) {
        // Force immediate save for tables that exceeded maxWait
        if (saveTimeout) clearTimeout(saveTimeout)
        if (maxWaitTimeout) clearTimeout(maxWaitTimeout)

        executeSave(
          tablesExceedingMaxWait,
          `Forcing save (exceeded maxWait ${maxWait}ms)`,
          maxRowCount
        )

        // Still schedule debounced save for remaining tables
        const remainingTables = filteredTables.filter(
          t => !tablesExceedingMaxWait.some(e => e.id === t.id)
        )
        if (remainingTables.length > 0) {
          saveTimeout = setTimeout(() => {
            executeSave(remainingTables, 'Debounced save', maxRowCount)
          }, debounceTime)
        }
        return
      }

      // Normal debounced save path
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(() => {
        executeSave(filteredTables, 'Debounced save', maxRowCount)
      }, debounceTime)

      // Also schedule maxWait timeout as a safety net
      // This ensures save happens even if debounce keeps resetting
      if (maxWaitTimeout) clearTimeout(maxWaitTimeout)
      const oldestDirtyTime = Math.min(
        ...filteredTables
          .map(t => firstDirtyAt.get(t.id) ?? now)
      )
      const timeUntilMaxWait = Math.max(0, maxWait - (now - oldestDirtyTime))

      if (timeUntilMaxWait > 0 && timeUntilMaxWait < maxWait) {
        maxWaitTimeout = setTimeout(() => {
          // Re-check which tables still need saving
          const stillDirtyTables = filteredTables.filter(t => firstDirtyAt.has(t.id))
          if (stillDirtyTables.length > 0) {
            if (saveTimeout) clearTimeout(saveTimeout)
            executeSave(stillDirtyTables, `MaxWait triggered (${maxWait}ms)`, maxRowCount)
          }
        }, timeUntilMaxWait)
      }
    })

    return () => {
      unsubscribe()
      if (saveTimeout) clearTimeout(saveTimeout)
      if (maxWaitTimeout) clearTimeout(maxWaitTimeout)
    }
  }, [isRestoring, saveTable])

  // 6a. REMOVED: Priority saves are now handled in Effect 6 above.
  // The separate Effect 6a was causing concurrent snapshot exports (memory spike bug).
  // Priority saves now bypass debounce within Effect 6's unified handler.

  // 6b. WATCH DIRTY TABLES: Cell edits are persisted to changelog (fast path)
  // Cell edits skip dataVersion increment to preserve grid scroll position,
  // but they DO call markTableDirty(). This subscription marks the table
  // as clean since cell edits are already saved to changelog in DataGrid.tsx.
  //
  // IMPORTANT: This effect only handles the "cell edit" case where:
  // - Table is newly marked dirty (in dirtyTableIds)
  // - dataVersion did NOT change (effect 6 won't fire)
  //
  // For structural transforms where dataVersion changes, effect 6 handles it
  // with full snapshot export.
  //
  // Cell edits are NOT saved to snapshot here - they go to changelog (fast path).
  // Compaction (Effect 9) merges changelog into snapshot periodically.
  useEffect(() => {
    if (isRestoring) return

    let prevDirtyTableIds = new Set<string>()
    const lastSeenDataVersions = new Map<string, number>()

    // Initialize with current tables' dataVersions
    useTableStore.getState().tables.forEach(t => {
      lastSeenDataVersions.set(t.id, t.dataVersion ?? 0)
    })

    // Import stores dynamically to avoid circular dependencies
    const setupSubscription = async () => {
      const { useUIStore } = await import('@/stores/uiStore')
      const { useEditBatchStore } = await import('@/stores/editBatchStore')

      // Initialize with current dirty tables
      prevDirtyTableIds = new Set(useUIStore.getState().dirtyTableIds)

      const unsubscribe = useUIStore.subscribe(
        (state) => {
          const currentDirtyIds = state.dirtyTableIds

          // Find newly dirty tables (not previously dirty)
          const newlyDirty: string[] = []
          for (const tableId of currentDirtyIds) {
            if (!prevDirtyTableIds.has(tableId)) {
              newlyDirty.push(tableId)
            }
          }
          prevDirtyTableIds = new Set(currentDirtyIds)

          if (newlyDirty.length === 0) return

          // Look up table names and filter to only cell-edit cases
          // (tables where dataVersion didn't change)
          const tableState = useTableStore.getState()
          const cellEditTables = newlyDirty
            .map(id => tableState.tables.find(t => t.id === id))
            .filter((t): t is NonNullable<typeof t> => {
              if (!t) return false

              // Check if dataVersion changed - if so, effect 6 will handle it
              const currentVersion = t.dataVersion ?? 0
              const lastVersion = lastSeenDataVersions.get(t.id) ?? 0
              lastSeenDataVersions.set(t.id, currentVersion)

              // Only handle if dataVersion DIDN'T change (cell edit case)
              return currentVersion === lastVersion
            })

          if (cellEditTables.length === 0) return

          // For cell edits: data should be saved to changelog in DataGrid.tsx
          // BUT if there are pending edits in editBatchStore (deferred during transforms),
          // the changelog write hasn't happened yet - DON'T mark clean!
          //
          // We DON'T trigger snapshot export here - that's wasteful for cell edits.
          // Compaction (Effect 9) will merge changelog into snapshot periodically.

          // Mark tables as "saved" ONLY if no pending edits waiting to be flushed
          // This gives the user immediate feedback that their edit is safe
          for (const table of cellEditTables) {
            const hasPending = useEditBatchStore.getState().hasPendingEdits(table.id)
            if (hasPending) {
              // Edits are deferred (e.g., transform in progress) - don't mark clean yet
              // The edits will be flushed when the transform completes, and markTableClean
              // will be called after the changelog write succeeds
              console.log(`[Persistence] Cell edit detected for ${table.name} - pending flush (deferred)`)
            } else {
              // No pending edits - changelog write has completed
              console.log(`[Persistence] Cell edit detected for ${table.name} - saved to changelog (fast path)`)
              useUIStore.getState().markTableClean(table.id)
            }
          }
        }
      )

      return unsubscribe
    }

    let unsubscribePromise: Promise<() => void> | null = null
    unsubscribePromise = setupSubscription()

    return () => {
      unsubscribePromise?.then(unsub => unsub()).catch(() => {})
    }
  }, [isRestoring])

  // 7. WATCH FOR DELETIONS: Subscribe to tableStore and delete snapshots when tables removed
  useEffect(() => {
    if (isRestoring) return

    // Track both names (for snapshot deletion) and IDs (for dirty state cleanup)
    let previousTables = new Map(
      useTableStore.getState().tables.map(t => [t.id, t.name])
    )

    const unsubscribe = useTableStore.subscribe((state) => {
      const currentTableIds = new Set(state.tables.map(t => t.id))

      // Find tables that were removed
      for (const [id, name] of previousTables) {
        if (!currentTableIds.has(id)) {
          // Skip deletion during rehydration - we're just clearing store metadata,
          // not actually deleting tables. The snapshot files should remain.
          if (isRehydratingFlag) {
            console.log(`[Persistence] Skipping snapshot deletion during rehydration: ${name}`)
            continue
          }
          console.log(`[Persistence] Table removed, deleting snapshot: ${name}`)
          deleteTableSnapshot(name).catch(console.error)

          // Clean up dirty state for the removed table
          // This prevents status from getting stuck at 'saving' when a dirty table is deleted
          useUIStore.getState().markTableClean(id)
        }
      }

      previousTables = new Map(state.tables.map(t => [t.id, t.name]))
    })

    return () => unsubscribe()
  }, [isRestoring, deleteTableSnapshot])

  // 8. BEFOREUNLOAD: Best-effort compaction and save warning
  // - Warn user if there are unsaved changes (dirty tables or saves in progress)
  // - Attempt to compact changelog before unload (if entries exist)
  useEffect(() => {
    const handleBeforeUnload = async (e: BeforeUnloadEvent) => {
      // Check if any saves are in progress
      if (saveInProgress.size > 0) {
        const tableNames = Array.from(saveInProgress.keys()).join(', ')
        console.warn(`[Persistence] Blocking navigation - saves in progress for: ${tableNames}`)

        // Standard way to trigger browser's "Leave site?" dialog
        e.preventDefault()
        // Legacy browsers need returnValue set
        e.returnValue = 'Changes are being saved. Leave anyway?'
        return 'Changes are being saved. Leave anyway?'
      }

      // Check if there are dirty tables (unsaved changes waiting for debounce)
      const { useUIStore } = await import('@/stores/uiStore')
      const dirtyTableIds = useUIStore.getState().dirtyTableIds
      if (dirtyTableIds.size > 0) {
        console.warn(`[Persistence] Blocking navigation - ${dirtyTableIds.size} table(s) have unsaved changes`)

        // Standard way to trigger browser's "Leave site?" dialog
        e.preventDefault()
        e.returnValue = 'You have unsaved changes. Leave anyway?'
        return 'You have unsaved changes. Leave anyway?'
      }

      // Best-effort compaction (async, may not complete before unload)
      // This is a "nice to have" - data is safe in changelog regardless
      const changelog = getChangelogStorage()
      const hasChanges = await changelog.hasAnyPendingChanges()
      if (hasChanges) {
        console.log('[Persistence] beforeunload: attempting final compaction...')
        // Don't await - let the browser decide if there's time
        compactChangelog(true).catch(() => {
          console.log('[Persistence] beforeunload: compaction interrupted (this is fine)')
        })
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, []) // No dependencies - saveInProgress is module-level

  // 9. COMPACTION SCHEDULER: Periodically check if compaction is needed
  // Triggers compaction when:
  // - Changelog exceeds COMPACTION_THRESHOLD entries (1000)
  // - User has been idle for COMPACTION_IDLE_TIMEOUT (30s) with pending changes
  const compactionIntervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (isRestoring) return

    // Start compaction check interval
    compactionIntervalRef.current = setInterval(async () => {
      // Only run compaction check if no saves are in progress
      if (saveInProgress.size > 0) {
        return
      }

      try {
        await compactChangelog()
      } catch (err) {
        console.error('[Persistence] Compaction check failed:', err)
      }
    }, COMPACTION_CHECK_INTERVAL)

    return () => {
      if (compactionIntervalRef.current) {
        clearInterval(compactionIntervalRef.current)
      }
    }
  }, [isRestoring])

  return {
    isRestoring,
    saveTable,
    deleteTableSnapshot,
    saveAllTables,
    clearStorage,
    compactChangelog, // Expose for manual compaction (e.g., before export)
  }
}
