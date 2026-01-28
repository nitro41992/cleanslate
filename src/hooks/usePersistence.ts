/**
 * Persistence Hook - Parquet-based OPFS persistence
 *
 * Workaround for DuckDB-WASM OPFS bug #2096.
 * Instead of using DuckDB's native OPFS persistence (which has the bug),
 * this stores each table as a Parquet file in OPFS and hydrates on startup.
 *
 * Lifecycle:
 * 1. App opens → hydrate() reads Parquet files from OPFS into DuckDB memory
 * 2. User edits → DuckDB memory updated immediately
 * 3. Auto-save → exportTableToParquet writes current state to OPFS
 * 4. App closes/refreshes → Go to step 1
 *
 * @see https://github.com/duckdb/duckdb-wasm/issues/2096
 */

import { useState, useEffect, useCallback } from 'react'
import { useTableStore } from '@/stores/tableStore'
import { initDuckDB, getConnection, getTableColumns } from '@/lib/duckdb'
import {
  listParquetSnapshots,
  importTableFromParquet,
  exportTableToParquet,
  deleteParquetSnapshot,
  cleanupCorruptSnapshots,
} from '@/lib/opfs/snapshot-storage'
import { toast } from 'sonner'

// Module-level flag to prevent double-hydration from React StrictMode
let hydrationPromise: Promise<void> | null = null

// Save queue to prevent concurrent exports and coalesce rapid changes
const saveInProgress = new Map<string, Promise<void>>()
const pendingSave = new Map<string, boolean>()

// Track tables that were just saved (e.g., during import) to skip redundant auto-saves
const recentlySavedTables = new Set<string>()

/**
 * Mark a table as recently saved to prevent redundant auto-save.
 * Called by useDuckDB after direct Parquet export during import.
 */
export function markTableAsRecentlySaved(tableId: string): void {
  recentlySavedTables.add(tableId)
  console.log(`[Persistence] Marked ${tableId} as recently saved (will skip auto-save)`)
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

export function usePersistence() {
  const [isRestoring, setIsRestoring] = useState(true)
  const addTable = useTableStore((s) => s.addTable)

  // 1. HYDRATION: Run once on mount to restore data from Parquet files
  useEffect(() => {
    // Prevent double-hydration from React StrictMode
    if (hydrationPromise) {
      console.log('[Persistence] Hydration already in progress, waiting...')
      hydrationPromise.then(() => setIsRestoring(false))
      return
    }

    const hydrate = async () => {
      console.log('[Persistence] Starting hydration...')

      try {
        // Clear any existing tables to prevent duplicates
        // This ensures Parquet files are the single source of truth
        const existingTables = useTableStore.getState().tables
        if (existingTables.length > 0) {
          console.log(`[Persistence] Clearing ${existingTables.length} existing table(s) before hydration`)
          useTableStore.getState().clearTables()
        }

        const db = await initDuckDB()
        const conn = await getConnection()

        // Clean up any corrupt 0-byte files from failed writes
        await cleanupCorruptSnapshots()

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
              return true
            })
        )]

        console.log(`[Persistence] Found ${uniqueTables.length} tables to restore:`, uniqueTables)

        let restoredCount = 0

        for (const tableName of uniqueTables) {
          try {
            // Skip if table already exists in store (prevents duplicates on hot reload)
            const existingTables = useTableStore.getState().tables
            if (existingTables.some(t => t.name === tableName || t.id === tableName)) {
              console.log(`[Persistence] Skipping ${tableName} - already in store`)
              continue
            }

            // 1. Load Parquet into DuckDB memory
            await importTableFromParquet(db, conn, tableName, tableName)

            // 2. Fetch metadata for UI
            const cols = await getTableColumns(tableName)

            const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
            const rowCount = Number(countResult.toArray()[0].toJSON().count)

            // 3. Sync with UI store
            // Use saved tableId if available (from app-state.json), otherwise use tableName
            // This ensures tableIds remain consistent across refreshes so timelines match
            const savedTableIds = (window as Window & { __CLEANSLATE_SAVED_TABLE_IDS__?: Record<string, string> }).__CLEANSLATE_SAVED_TABLE_IDS__
            const tableId = savedTableIds?.[tableName] ?? tableName
            console.log(`[Persistence] Using tableId '${tableId}' for '${tableName}'`, {
              fromSavedState: !!savedTableIds?.[tableName],
            })
            addTable(tableName, cols, rowCount, tableId)

            restoredCount++
            console.log(`[Persistence] Restored ${tableName} (${rowCount.toLocaleString()} rows)`)
          } catch (err) {
            console.error(`[Persistence] Failed to restore ${tableName}:`, err)
          }
        }

        if (restoredCount > 0) {
          toast.success(`Restored ${restoredCount} table(s) from storage`)

          // Restore the active table selection from saved state
          // This must happen AFTER all tables are added, since addTable() overwrites activeTableId
          const savedActiveTableId = (window as Window & { __CLEANSLATE_SAVED_ACTIVE_TABLE_ID__?: string | null }).__CLEANSLATE_SAVED_ACTIVE_TABLE_ID__
          if (savedActiveTableId) {
            const restoredTables = useTableStore.getState().tables
            const activeTableExists = restoredTables.some(t => t.id === savedActiveTableId)
            if (activeTableExists) {
              useTableStore.getState().setActiveTable(savedActiveTableId)
              console.log(`[Persistence] Restored active table: ${savedActiveTableId}`)
            } else {
              console.log(`[Persistence] Saved active table ${savedActiveTableId} not found in restored tables`)
            }
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
    // If already saving this table, mark for re-save after completion
    if (saveInProgress.has(tableName)) {
      console.log(`[Persistence] ${tableName} save in progress, queuing...`)
      pendingSave.set(tableName, true)
      return saveInProgress.get(tableName)!
    }

    // CRITICAL: Create and register promise SYNCHRONOUSLY before any await
    // This prevents race conditions when multiple calls happen nearly simultaneously
    const savePromise = (async () => {
      // Dynamic import inside the IIFE - after promise is registered
      const { useUIStore } = await import('@/stores/uiStore')
      const uiStore = useUIStore.getState()

      try {
        const db = await initDuckDB()
        const conn = await getConnection()

        // Set saving status when export starts
        if (uiStore.persistenceStatus === 'dirty') {
          uiStore.setPersistenceStatus('saving')
        }

        console.log(`[Persistence] Saving ${tableName}...`)

        // Export table to Parquet (overwrites existing snapshot)
        await exportTableToParquet(db, conn, tableName, tableName)

        // Mark table as clean after successful Parquet export
        const table = useTableStore.getState().tables.find(t => t.name === tableName)
        if (table) {
          useUIStore.getState().markTableClean(table.id)
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
    savePromise.finally(() => {
      saveInProgress.delete(tableName)

      // If another save was requested while we were saving, save again with latest data
      if (pendingSave.get(tableName)) {
        console.log(`[Persistence] ${tableName} has pending changes, re-saving...`)
        pendingSave.delete(tableName)
        saveTable(tableName).catch(console.error)
      }
    })

    return savePromise
  }, [])

  // 3. DELETE: Call this when a table is deleted to remove its Parquet file
  const deleteTableSnapshot = useCallback(async (tableName: string) => {
    try {
      await deleteParquetSnapshot(tableName)
      console.log(`[Persistence] Deleted snapshot for ${tableName}`)
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
  useEffect(() => {
    if (isRestoring) return

    let saveTimeout: NodeJS.Timeout | null = null
    const knownTableIds = new Set<string>()
    const lastDataVersions = new Map<string, number>()

    // Initialize with current tables (these were restored from Parquet, don't re-save)
    useTableStore.getState().tables.forEach(t => {
      knownTableIds.add(t.id)
      lastDataVersions.set(t.id, t.dataVersion ?? 0)
    })

    const unsubscribe = useTableStore.subscribe(async (state) => {
      const tablesToSave: { id: string; name: string }[] = []

      for (const table of state.tables) {
        const isNewTable = !knownTableIds.has(table.id)
        const currentVersion = table.dataVersion ?? 0
        const lastVersion = lastDataVersions.get(table.id) ?? 0
        const hasDataChanged = currentVersion > lastVersion

        // Skip tables that were just saved (e.g., during import)
        // This prevents redundant saves - the table is already persisted
        if (recentlySavedTables.has(table.id)) {
          console.log(`[Persistence] Skipping ${table.name} - was just saved during import`)
          recentlySavedTables.delete(table.id)  // Consume the flag
          knownTableIds.add(table.id)           // Track it as known
          lastDataVersions.set(table.id, currentVersion)
          continue
        }

        if (isNewTable || hasDataChanged) {
          tablesToSave.push({ id: table.id, name: table.name })
          knownTableIds.add(table.id)
          lastDataVersions.set(table.id, currentVersion)

          if (isNewTable) {
            console.log(`[Persistence] New table detected: ${table.name}`)
          }
        }
      }

      if (tablesToSave.length === 0) return

      // Filter out internal timeline tables from saving
      const filteredTables = tablesToSave.filter(t => {
        if (t.name.startsWith('original_')) return false  // timeline original snapshots
        if (t.name.startsWith('snapshot_')) return false  // timeline snapshots
        if (t.name.startsWith('_timeline_')) return false  // timeline internal
        return true
      })

      if (filteredTables.length === 0) return

      // Mark tables dirty IMMEDIATELY (before debounce)
      // This shows the "Unsaved changes" indicator right away
      const { useUIStore } = await import('@/stores/uiStore')
      for (const table of filteredTables) {
        useUIStore.getState().markTableDirty(table.id)
      }

      // Compute adaptive debounce based on largest table being saved
      // Larger tables get longer debounce to batch more edits per export
      const maxRowCount = Math.max(
        ...filteredTables.map(t => {
          const tableData = state.tables.find(st => st.id === t.id)
          return tableData?.rowCount ?? 0
        })
      )
      const debounceTime = getDebounceTime(maxRowCount)

      // Debounce: save after adaptive delay based on table size
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(() => {
        console.log(`[Persistence] Saving tables: ${filteredTables.map(t => t.name).join(', ')} (debounce: ${debounceTime}ms for ${maxRowCount.toLocaleString()} rows)`)
        filteredTables.forEach(t => {
          saveTable(t.name).catch(console.error)
        })
      }, debounceTime)
    })

    return () => {
      unsubscribe()
      if (saveTimeout) clearTimeout(saveTimeout)
    }
  }, [isRestoring, saveTable])

  // 7. WATCH FOR DELETIONS: Subscribe to tableStore and delete Parquet when tables removed
  useEffect(() => {
    if (isRestoring) return

    let previousTableNames = new Set(useTableStore.getState().tables.map(t => t.name))

    const unsubscribe = useTableStore.subscribe((state) => {
      const currentTableNames = new Set(state.tables.map(t => t.name))

      // Find tables that were removed
      for (const name of previousTableNames) {
        if (!currentTableNames.has(name)) {
          console.log(`[Persistence] Table removed, deleting snapshot: ${name}`)
          deleteTableSnapshot(name).catch(console.error)
        }
      }

      previousTableNames = currentTableNames
    })

    return () => unsubscribe()
  }, [isRestoring, deleteTableSnapshot])

  return {
    isRestoring,
    saveTable,
    deleteTableSnapshot,
    saveAllTables,
    clearStorage,
  }
}
