/**
 * Persistence Hook - Hybrid OPFS Persistence with Incremental Changelog
 *
 * Workaround for DuckDB-WASM OPFS bug #2096.
 * Uses a dual-layer persistence strategy for optimal performance:
 *
 * 1. CHANGELOG (fast): Cell edits → OPFS JSONL (~2-3ms per write)
 * 2. PARQUET (reliable): Transforms → Full snapshot export
 *
 * Lifecycle:
 * 1. App opens → Import Parquet files → Replay changelog → Ready
 * 2. Cell edit → Instant OPFS changelog write (non-blocking)
 * 3. Transform → Parquet snapshot export (background, non-blocking)
 * 4. Periodic compaction → Merge changelog into Parquet → Clear changelog
 * 5. App closes → Attempt final compaction (best-effort)
 *
 * @see https://github.com/duckdb/duckdb-wasm/issues/2096
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTableStore } from '@/stores/tableStore'
import { useUIStore } from '@/stores/uiStore'
import { initDuckDB, getConnection, getTableColumns, CS_ID_COLUMN } from '@/lib/duckdb'
import {
  listParquetSnapshots,
  importTableFromParquet,
  exportTableToParquet,
  deleteParquetSnapshot,
  cleanupCorruptSnapshots,
  cleanupOrphanedDiffFiles,
  cleanupDuplicateCaseSnapshots,
} from '@/lib/opfs/snapshot-storage'
import {
  getChangelogStorage,
  type ChangelogEntry,
} from '@/lib/opfs/changelog-storage'
import { toast } from 'sonner'

// Module-level flag to prevent double-hydration from React StrictMode
let hydrationPromise: Promise<void> | null = null

// Flag to signal that re-hydration is needed (after worker restart)
let rehydrationRequested = false

// Flag to suppress Parquet deletion during rehydration
// When true, clearTables() won't trigger snapshot deletion
let isRehydratingFlag = false

// Save queue to prevent concurrent exports and coalesce rapid changes
const saveInProgress = new Map<string, Promise<void>>()
const pendingSave = new Map<string, boolean>()

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
 * Called after Parquet import to apply pending cell edits.
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
      // Escape value for SQL
      let escapedValue: string
      if (entry.newValue === null || entry.newValue === undefined) {
        escapedValue = 'NULL'
      } else if (typeof entry.newValue === 'string') {
        escapedValue = `'${entry.newValue.replace(/'/g, "''")}'`
      } else if (typeof entry.newValue === 'boolean') {
        escapedValue = entry.newValue ? 'true' : 'false'
      } else {
        escapedValue = String(entry.newValue)
      }

      const sql = `
        UPDATE "${tableName}"
        SET "${entry.column}" = ${escapedValue}
        WHERE "${CS_ID_COLUMN}" = ${entry.rowId}
      `

      await conn.query(sql)
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
 * Perform hydration - import tables from Parquet files into DuckDB.
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
      // CRITICAL: Set flag to prevent deletion subscription from deleting Parquet files
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

  // List all saved Parquet files
  const snapshots = await listParquetSnapshots()

  if (snapshots.length === 0) {
    console.log('[Persistence] No saved snapshots found.')
    // Still replay changelog in case there are orphaned entries
    // (e.g., user made edits but Parquet export failed)
    return
  }

  // Filter to user tables only (exclude internal timeline/diff tables)
  const uniqueTables = [...new Set(
    snapshots
      .map(name => name.replace(/_part_\d+$/, ''))
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
  // This handles case mismatch between Parquet filenames (lowercase) and app-state.json (original casing)
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
  // This allows matching Parquet filenames (lowercase) to app-state entries (original casing)
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
        // THAW: Import from Parquet into DuckDB (full hydration)
        // Use snapshotName (lowercase) for Parquet file, tableName (original casing) for DuckDB table
        await importTableFromParquet(db, conn, snapshotName, tableName)

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
          // Fallback: Read Parquet metadata directly
          // We need to briefly import to get accurate metadata, then drop
          console.log(`[Persistence] No saved metadata for ${snapshotName}, reading from Parquet header...`)
          await importTableFromParquet(db, conn, snapshotName, tableName)
          const cols = await getTableColumns(tableName)
          const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
          const rowCount = Number(countResult.toArray()[0].toJSON().count)

          // Drop from DuckDB memory (it's frozen, not active)
          await conn.query(`DROP TABLE IF EXISTS "${tableName}"`)

          addTable(tableName, cols, rowCount, tableId)
          markTableFrozen(tableId)
          console.log(`[Persistence] Frozen ${tableName} (${rowCount.toLocaleString()} rows) - metadata from Parquet`)
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
  console.log('[Persistence] Re-hydration requested - will import from Parquet on next effect')
}

/**
 * Save a cell edit to the changelog (instant, non-blocking).
 * This is the fast path for cell edits - avoids full Parquet export.
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

  const entry: ChangelogEntry = {
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

  const changelogEntries: ChangelogEntry[] = entries.map((e) => ({
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
 * Compact the changelog by merging pending edits into Parquet snapshots.
 * Called periodically when idle or when changelog exceeds threshold.
 *
 * Flow:
 * 1. Check if compaction needed (entry count or idle time)
 * 2. Export affected tables to Parquet (changelog already applied to DuckDB)
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

          // Export table to Parquet (includes all changes since changelog is already in DuckDB)
          // Track in UI store for status bar indicator
          useUIStore.getState().addSavingTable(table.name)

          // CRITICAL: Normalize snapshotId to lowercase to match timeline-engine's naming convention.
          const normalizedSnapshotId = table.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

          await exportTableToParquet(db, conn, table.name, normalizedSnapshotId, {
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
 * Called by useDuckDB after direct Parquet export during import,
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
 * Bypasses debounce and saves all dirty tables to Parquet.
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

      // Export to Parquet
      await exportTableToParquet(db, conn, table.name, normalizedSnapshotId, {
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

export function usePersistence() {
  const [isRestoring, setIsRestoring] = useState(true)
  const addTable = useTableStore((s) => s.addTable)

  // 1. HYDRATION: Run once on mount to restore data from Parquet files
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
        // This ensures Parquet files are the single source of truth
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

        // List all saved Parquet files
        const snapshots = await listParquetSnapshots()

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

        // Filter to only get unique table names (remove _part_N suffixes and duplicates)
        // Also filter out internal timeline tables (original_*, snapshot_*, _timeline_*)
        const uniqueTables = [...new Set(
          snapshots
            .map(name => name.replace(/_part_\d+$/, ''))
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
        // This handles case mismatch between Parquet filenames (lowercase) and app-state.json (original casing)
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
        // This allows matching Parquet filenames (lowercase) to app-state entries (original casing)
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
              // THAW: Import from Parquet into DuckDB (full hydration)
              // Use snapshotName (lowercase) for Parquet file, tableName (original casing) for DuckDB table
              await importTableFromParquet(db, conn, snapshotName, tableName)

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
                // Fallback: Read Parquet metadata directly (requires brief import)
                console.log(`[Persistence] No saved metadata for ${snapshotName}, reading from Parquet header...`)
                await importTableFromParquet(db, conn, snapshotName, tableName)
                const cols = await getTableColumns(tableName)
                const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
                const rowCount = Number(countResult.toArray()[0].toJSON().count)

                // Drop from DuckDB memory (it's frozen, not active)
                await conn.query(`DROP TABLE IF EXISTS "${tableName}"`)

                addTable(tableName, cols, rowCount, tableId)
                markTableFrozen(tableId)
                console.log(`[Persistence] Frozen ${tableName} (${rowCount.toLocaleString()} rows) - metadata from Parquet`)
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

  // 2. SAVING: Call this to save a specific table to Parquet
  // Uses queue with coalescing to prevent concurrent exports
  const saveTable = useCallback(async (tableName: string): Promise<void> => {
    // CRITICAL: Skip save if a timeline replay is in progress
    // During replay, tables are dropped and recreated. Attempting to export
    // during this transient state causes "table does not exist" errors.
    // The save will be triggered again after replay completes.
    const { useTimelineStore } = await import('@/stores/timelineStore')
    if (useTimelineStore.getState().isReplaying) {
      console.log(`[Persistence] Skipping save for ${tableName} - replay in progress`)
      return
    }

    // If already saving this table, mark for re-save after completion
    if (saveInProgress.has(tableName)) {
      console.log(`[Persistence] ${tableName} save in progress, queuing...`)
      pendingSave.set(tableName, true)
      // Track pending in UI store for indicator
      const { useUIStore } = await import('@/stores/uiStore')
      useUIStore.getState().addPendingTable(tableName)
      return saveInProgress.get(tableName)!
    }

    // CRITICAL: Create and register promise SYNCHRONOUSLY before any await
    // This prevents race conditions when multiple calls happen nearly simultaneously
    const savePromise = (async () => {
      // Dynamic import inside the IIFE - after promise is registered
      const { useUIStore } = await import('@/stores/uiStore')
      const uiStore = useUIStore.getState()

      // Track in UI store: add to saving, remove from pending
      uiStore.addSavingTable(tableName)
      uiStore.removePendingTable(tableName)

      try {
        // CRITICAL: Flush any pending batch edits for this table before exporting
        // This ensures all cell edits are captured in the Parquet file, even if
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
        // This prevents duplicate Parquet files in OPFS which is case-sensitive.
        const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

        // Export table to Parquet (overwrites existing snapshot)
        // Pass chunk progress callback for large table UI feedback
        await exportTableToParquet(db, conn, tableName, normalizedSnapshotId, {
          onChunkProgress: (current, total, table) => {
            useUIStore.getState().setChunkProgress({ tableName: table, currentChunk: current, totalChunks: total })
          },
        })

        // Mark table as clean after successful Parquet export
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

    // Handle cleanup and re-save after promise settles
    savePromise.finally(async () => {
      saveInProgress.delete(tableName)

      // Remove from saving tables in UI store
      const { useUIStore } = await import('@/stores/uiStore')
      useUIStore.getState().removeSavingTable(tableName)

      // If another save was requested while we were saving, re-save only if table is actually dirty
      // This prevents the "spinning persistence loop" where pendingSave blindly re-saves
      if (pendingSave.get(tableName)) {
        pendingSave.delete(tableName)

        // CRITICAL: Only re-save if table is actually dirty
        const table = useTableStore.getState().tables.find(t => t.name === tableName)
        const tableIdForCheck = table?.id

        if (tableIdForCheck && useUIStore.getState().dirtyTableIds.has(tableIdForCheck)) {
          console.log(`[Persistence] ${tableName} still dirty, re-saving...`)
          saveTable(tableName).catch(console.error)
        } else {
          console.log(`[Persistence] ${tableName} is clean, dropping pending save`)
        }
      }
    })

    return savePromise
  }, [])

  // 3. DELETE: Call this when a table is deleted to remove its Parquet file
  const deleteTableSnapshot = useCallback(async (tableName: string) => {
    try {
      // CRITICAL: Normalize table name to match how snapshots are saved (lowercase, underscores)
      // Without this, deletion of "My_Table" would look for "My_Table.parquet" but file is "my_table.parquet"
      const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      await deleteParquetSnapshot(normalizedSnapshotId)
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

  // 5. CLEAR: Remove all Parquet files from OPFS
  const clearStorage = useCallback(async () => {
    try {
      const snapshots = await listParquetSnapshots()
      const uniqueTables = [...new Set(
        snapshots.map(name => name.replace(/_part_\d+$/, ''))
      )]

      for (const tableName of uniqueTables) {
        await deleteParquetSnapshot(tableName)
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

    // Initialize with current tables (these were restored from Parquet, don't re-save)
    useTableStore.getState().tables.forEach(t => {
      knownTableIds.add(t.id)
      lastDataVersions.set(t.id, t.dataVersion ?? 0)
    })

    // Helper to execute save and clear firstDirtyAt tracking
    const executeSave = (tables: { id: string; name: string }[], reason: string, rowCount: number) => {
      console.log(`[Persistence] ${reason}: ${tables.map(t => t.name).join(', ')} (${rowCount.toLocaleString()} rows)`)
      tables.forEach(t => {
        saveTable(t.name)
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
        if (saveInProgress.has(table.name)) {
          knownTableIds.add(table.id)
          lastDataVersions.set(table.id, currentVersion)
          continue
        }

        if (isNewTable || hasDataChanged) {
          tablesToSave.push({ id: table.id, name: table.name, rowCount: table.rowCount })
          knownTableIds.add(table.id)
          lastDataVersions.set(table.id, currentVersion)

          if (isNewTable) {
            console.log(`[Persistence] New table detected: ${table.name}`)
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
          maxRowCount
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
  // The separate Effect 6a was causing concurrent Parquet exports (memory spike bug).
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
  // with full Parquet export.
  //
  // Cell edits are NOT saved to Parquet here - they go to changelog (fast path).
  // Compaction (Effect 9) merges changelog into Parquet periodically.
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
          // We DON'T trigger Parquet export here - that's wasteful for cell edits.
          // Compaction (Effect 9) will merge changelog into Parquet periodically.

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

  // 7. WATCH FOR DELETIONS: Subscribe to tableStore and delete Parquet when tables removed
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
          // not actually deleting tables. The Parquet files should remain.
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
