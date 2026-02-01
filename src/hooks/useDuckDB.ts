import { useState, useEffect, useCallback } from 'react'
import {
  initDuckDB,
  loadCSV,
  loadJSON,
  loadParquet,
  loadXLSX,
  getTableData,
  getTableDataWithRowIds,
  getTableDataWithKeyset,
  getTableDataArrowWithKeyset,
  getTableColumns,
  getFilteredRowCount,
  exportToCSV,
  dropTable,
  query,
  execute,
  updateCell as updateCellDb,
  duplicateTable as duplicateTableDb,
  isDuckDBPersistent,
  isDuckDBReadOnly,
  terminateAndReinitialize,
  type KeysetCursor,
  type ArrowKeysetPageResult,
} from '@/lib/duckdb'
import { buildWhereClause, buildOrderByClause } from '@/lib/duckdb/filter-builder'
import type { ColumnFilter } from '@/types'
import { checkMemoryCapacity, getMemoryStatus, getFullMemoryStatus, WARNING_THRESHOLD } from '@/lib/duckdb/memory'
import { idleDetector } from '@/lib/idle-detector'
import { useTableStore } from '@/stores/tableStore'
import { useAuditStore } from '@/stores/auditStore'
import { useUIStore } from '@/stores/uiStore'
import { toast } from '@/hooks/use-toast'
import { generateId } from '@/lib/utils'
import type { CSVIngestionSettings } from '@/types'

// ===== SINGLETON INITIALIZATION =====
// This ensures DuckDB + state restoration only runs ONCE regardless of how many
// components call useDuckDB(). Without this, each component's useEffect would
// run restoreAppState() independently, causing 6x duplication on page load.

let fullInitPromise: Promise<void> | null = null
let isFullyInitialized = false

// Exposed promise that resolves when state restoration is complete
// usePersistence.hydrate() awaits this to ensure __CLEANSLATE_SAVED_TABLE_IDS__ is set
let stateRestorationResolve: (() => void) | null = null
export let stateRestorationPromise: Promise<void> | null = null

/**
 * Full initialization sequence (DuckDB + state restoration).
 * Runs exactly once - all useDuckDB() callers share this promise.
 */
async function runFullInitialization(): Promise<void> {
  // Create the state restoration promise that usePersistence will await
  // This ensures __CLEANSLATE_SAVED_TABLE_IDS__ is set before hydration reads it
  stateRestorationPromise = new Promise<void>((resolve) => {
    stateRestorationResolve = resolve
  })

  // Initialize DuckDB engine
  await initDuckDB()

  // Cleanup any corrupt snapshot files from failed exports
  try {
    const { cleanupCorruptSnapshots } = await import('@/lib/opfs/snapshot-storage')
    await cleanupCorruptSnapshots()
  } catch (e) {
    console.warn('[DuckDB] Failed to run snapshot cleanup:', e)
  }

  // Get persistence status
  const isPersistent = isDuckDBPersistent()
  const isReadOnly = isDuckDBReadOnly()

  // Restore timelines and UI preferences from app-state.json
  // This runs regardless of DuckDB persistence mode since app-state.json uses OPFS directly
  try {
    const { restoreAppState } = await import('@/lib/persistence/state-persistence')
    const savedState = await restoreAppState()

    if (savedState) {
      // Get valid table IDs from saved state
      const validTableIds = new Set(savedState.tables.map(t => t.id))

      // Filter out orphaned timelines (from previously deleted tables)
      const validTimelines = savedState.timelines.filter(t => validTableIds.has(t.tableId))
      const orphanedCount = savedState.timelines.length - validTimelines.length

      if (orphanedCount > 0) {
        console.log(`[Persistence] Cleaned up ${orphanedCount} orphaned timeline(s)`)
      }

      // Restore timelines (for undo/redo history)
      const { useTimelineStore } = await import('@/stores/timelineStore')
      useTimelineStore.getState().loadTimelines(validTimelines)

      // Restore UI preferences
      useUIStore.getState().setSidebarCollapsed(savedState.uiPreferences.sidebarCollapsed)

      // Expose saved table metadata for usePersistence to use
      // This ensures tableIds remain consistent across refreshes
      const tableIdMap: Record<string, string> = {}
      for (const table of savedState.tables) {
        tableIdMap[table.name] = table.id
      }
      ;(window as Window & { __CLEANSLATE_SAVED_TABLE_IDS__?: Record<string, string> }).__CLEANSLATE_SAVED_TABLE_IDS__ = tableIdMap

      // Expose saved activeTableId for usePersistence to restore after hydration
      ;(window as Window & { __CLEANSLATE_SAVED_ACTIVE_TABLE_ID__?: string | null }).__CLEANSLATE_SAVED_ACTIVE_TABLE_ID__ = savedState.activeTableId

      // Expose full table metadata for lazy hydration (Phase 4)
      // This allows frozen tables to be added to the store with metadata only (no DuckDB import)
      ;(window as Window & { __CLEANSLATE_SAVED_TABLES__?: Array<{ id: string; name: string; columns: Array<{ name: string; type: string; nullable: boolean }>; rowCount: number; columnOrder?: string[] }> }).__CLEANSLATE_SAVED_TABLES__ = savedState.tables.map(t => ({
        id: t.id,
        name: t.name,
        columns: t.columns.map(c => ({ name: c.name, type: c.type, nullable: c.nullable })),
        rowCount: t.rowCount,
        columnOrder: t.columnOrder,
      }))

      console.log('[Persistence] Timelines and UI restored from app-state.json', {
        tableIdMap,
      })
    }

    // Signal that state restoration is complete (saved table IDs are now available)
    if (stateRestorationResolve) {
      stateRestorationResolve()
    }
  } catch (error) {
    console.warn('[Persistence] Failed to restore timelines:', error)
    // Still resolve to unblock hydration even on error
    if (stateRestorationResolve) {
      stateRestorationResolve()
    }
  }

  // Log ready status (only once)
  if (isPersistent && !isReadOnly) {
    console.log('[DuckDB] Ready with persistent storage (auto-save enabled)')
  } else if (isPersistent && isReadOnly) {
    console.log('[DuckDB] Ready with persistent storage (read-only mode)')
  } else {
    console.log('[DuckDB] Ready (in-memory - data will not persist)')
    toast({
      title: 'In-Memory Mode',
      description: 'Your browser does not support persistent storage. Data will be lost on refresh.',
      variant: 'default',
    })
  }

  isFullyInitialized = true
}

/**
 * Get the singleton initialization promise.
 * Creates a new one if not already running.
 */
function getFullInitPromise(): Promise<void> {
  if (!fullInitPromise) {
    fullInitPromise = runFullInitialization()
  }
  return fullInitPromise
}

// ===== HOOK =====

export function useDuckDB() {
  // Start with true if already initialized (prevents flash of loading state)
  const [isReady, setIsReady] = useState(isFullyInitialized)
  const [isLoading, setIsLoading] = useState(false)
  const addTable = useTableStore((s) => s.addTable)
  const removeTable = useTableStore((s) => s.removeTable)
  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const refreshMemory = useUIStore((s) => s.refreshMemory)
  const setLoadingMessage = useUIStore((s) => s.setLoadingMessage)

  useEffect(() => {
    // Skip if already initialized (component re-mount or HMR)
    if (isFullyInitialized) {
      setIsReady(true)
      return
    }

    // Chain off the singleton promise - all components share this
    getFullInitPromise()
      .then(() => {
        setIsReady(true)
      })
      .catch((err) => {
        console.error('Failed to initialize DuckDB:', err)
        toast({
          title: 'Database Error',
          description: 'Failed to initialize the data engine',
          variant: 'destructive',
        })
      })
  }, [])

  const loadFile = useCallback(
    async (file: File, csvSettings?: CSVIngestionSettings) => {
      setIsLoading(true)
      setLoadingMessage('Reading file...')
      try {
        // Pre-load capacity check: estimate file size impact (files expand ~2x in memory)
        const estimatedImpact = file.size * 2
        const memCheck = await checkMemoryCapacity(estimatedImpact)

        if (!memCheck.canLoad) {
          // Block loading - would exceed safe limits
          toast({
            title: 'Insufficient Memory',
            description: memCheck.warningMessage || 'Loading this file would exceed available memory',
            variant: 'destructive',
          })
          throw new Error('Insufficient memory to load file safely')
        } else if (memCheck.warningMessage) {
          // Allow but warn
          toast({
            title: 'Memory Warning',
            description: memCheck.warningMessage,
          })
        }

        const tableName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
        let result: { columns: string[]; rowCount: number }

        const ext = file.name.split('.').pop()?.toLowerCase()

        setLoadingMessage('Creating table...')
        if (ext === 'csv') {
          result = await loadCSV(tableName, file, csvSettings)
        } else if (ext === 'json') {
          result = await loadJSON(tableName, file)
        } else if (ext === 'parquet') {
          result = await loadParquet(tableName, file)
        } else if (ext === 'xlsx' || ext === 'xls') {
          result = await loadXLSX(tableName, file)
        } else {
          throw new Error(`Unsupported file type: ${ext}`)
        }

        // Query actual column types from DuckDB schema instead of hardcoding VARCHAR
        // This ensures DATE, TIMESTAMP, INTEGER etc. are properly typed for grid formatting
        const columns = await getTableColumns(tableName)

        // Generate tableId BEFORE adding to store so we can create timeline/snapshot first
        const tableId = generateId()

        // Create timeline with original snapshot BEFORE grid rendering
        // This ensures first edit is instant (snapshot already exists)
        // Progress indicator shown via setLoadingMessage
        setLoadingMessage('Creating snapshot...')
        try {
          const { initializeTimeline } = await import('@/lib/timeline-engine')
          await initializeTimeline(tableId, tableName)
          console.log('[Import] Timeline initialized with snapshot')
        } catch (error) {
          console.warn('[Import] Failed to create timeline/snapshot:', error)
          // Non-fatal - timeline will be created on first edit (old behavior)
        }

        // Timeline snapshot now serves as persistence (via file copy in createTimelineOriginalSnapshot)
        // This eliminates the "double tax" where import used to export twice
        console.log('[Import] Timeline snapshot serves as persistence (via file copy)')

        // NOW add to store - this triggers grid rendering
        // Table is already persisted, so user can edit immediately
        setLoadingMessage('Rendering grid...')
        addTable(tableName, columns, result.rowCount, tableId)

        // Build details string with settings info for CSV
        let details = `Loaded ${file.name} (${result.rowCount} rows, ${result.columns.length} columns)`
        if (ext === 'csv' && csvSettings) {
          const settingsParts: string[] = []
          if (csvSettings.headerRow && csvSettings.headerRow > 1) {
            settingsParts.push(`header row: ${csvSettings.headerRow}`)
          }
          if (csvSettings.delimiter && csvSettings.delimiter !== ',') {
            const delimNames: Record<string, string> = {
              '\t': 'tab',
              '|': 'pipe',
              ';': 'semicolon',
            }
            settingsParts.push(`delimiter: ${delimNames[csvSettings.delimiter] || csvSettings.delimiter}`)
          }
          if (csvSettings.encoding && csvSettings.encoding !== 'utf-8') {
            settingsParts.push(`encoding: ${csvSettings.encoding}`)
          }
          if (settingsParts.length > 0) {
            details += ` [${settingsParts.join(', ')}]`
          }
        }

        addAuditEntry(
          tableId,
          tableName,
          'File Loaded',
          details
        )

        toast({
          title: 'File Loaded',
          description: `${tableName}: ${result.rowCount.toLocaleString()} rows`,
        })

        // Refresh memory indicator after file load
        refreshMemory()

        return { tableId, tableName, ...result }
      } catch (error) {
        console.error('Error loading file:', error)
        toast({
          title: 'Load Error',
          description: error instanceof Error ? error.message : 'Failed to load file',
          variant: 'destructive',
        })
        throw error
      } finally {
        setIsLoading(false)
        setLoadingMessage(null)
      }
    },
    [addTable, addAuditEntry, refreshMemory, setLoadingMessage]
  )

  const getData = useCallback(
    async (tableName: string, offset = 0, limit = 1000) => {
      return getTableData(tableName, offset, limit)
    },
    []
  )

  const getDataWithRowIds = useCallback(
    async (tableName: string, offset = 0, limit = 1000) => {
      return getTableDataWithRowIds(tableName, offset, limit)
    },
    []
  )

  const getDataWithKeyset = useCallback(
    async (tableName: string, cursor: KeysetCursor, limit = 500) => {
      return getTableDataWithKeyset(tableName, cursor, limit)
    },
    []
  )

  /**
   * Get table data using keyset pagination, returning Arrow Table for O(1) cell access.
   * This is the zero-copy path for grid rendering - eliminates JSON serialization overhead.
   *
   * @param tableName - Name of the table to query
   * @param cursor - Pagination cursor
   * @param limit - Number of rows to fetch
   * @param startRow - Starting row index for this page
   * @returns Arrow Table with metadata for grid integration
   */
  const getDataArrowWithKeyset = useCallback(
    async (tableName: string, cursor: KeysetCursor, limit = 500, startRow = 0): Promise<ArrowKeysetPageResult> => {
      return getTableDataArrowWithKeyset(tableName, cursor, limit, startRow)
    },
    []
  )

  /**
   * Get filtered and sorted data using keyset pagination.
   * Filters and sort are applied as SQL WHERE/ORDER BY clauses.
   *
   * @param tableName - Name of the table to query
   * @param cursor - Pagination cursor
   * @param limit - Number of rows to fetch
   * @param filters - Array of column filters to apply
   * @param sortColumn - Column to sort by (null for default _cs_id sort)
   * @param sortDirection - 'asc' or 'desc'
   */
  const getFilteredDataWithKeyset = useCallback(
    async (
      tableName: string,
      cursor: KeysetCursor,
      limit: number,
      filters: ColumnFilter[],
      sortColumn: string | null,
      sortDirection: 'asc' | 'desc'
    ) => {
      const whereClause = buildWhereClause(filters)
      const orderByClause = buildOrderByClause(sortColumn, sortDirection)

      const enhancedCursor: KeysetCursor = {
        ...cursor,
        whereClause: whereClause || undefined,
        orderByClause: orderByClause || undefined,
      }

      return getTableDataWithKeyset(tableName, enhancedCursor, limit)
    },
    []
  )

  /**
   * Get the count of rows matching a filter.
   * Useful for displaying "X of Y rows" in the UI.
   *
   * @param tableName - Name of the table to query
   * @param filters - Array of column filters to apply
   */
  const getFilteredCount = useCallback(
    async (tableName: string, filters: ColumnFilter[]) => {
      const whereClause = buildWhereClause(filters)
      return getFilteredRowCount(tableName, whereClause)
    },
    []
  )

  const runQuery = useCallback(async (sql: string) => {
    return query(sql)
  }, [])

  const runExecute = useCallback(async (sql: string) => {
    return execute(sql)
  }, [])

  const exportTable = useCallback(async (tableName: string, filename: string) => {
    const blob = await exportToCSV(tableName)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || `${tableName}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    toast({
      title: 'Export Complete',
      description: `Saved ${filename || tableName + '.csv'}`,
    })
  }, [])

  const deleteTable = useCallback(
    async (tableId: string, tableName: string) => {
      // 1. Drop DuckDB table (releases WASM heap memory)
      await dropTable(tableName)

      // 2. Delete OPFS Parquet file (releases disk storage)
      try {
        const { deleteParquetSnapshot } = await import('@/lib/opfs/snapshot-storage')
        await deleteParquetSnapshot(tableName)
        console.log(`[DuckDB] Deleted OPFS Parquet for: ${tableName}`)
      } catch {
        // Expected if table was never persisted to OPFS
        console.log(`[DuckDB] No OPFS Parquet to delete for: ${tableName}`)
      }

      // 3. Remove from store (triggers timeline cleanup + app-state.json save)
      removeTable(tableId)
      addAuditEntry(tableId, tableName, 'Table Deleted', `Removed table ${tableName}`)

      // Check memory after deletion - WASM heap doesn't shrink automatically
      // If memory is still high after dropping a table, we need to restart
      // the worker to truly release the memory
      try {
        const memStatus = await getMemoryStatus()
        const remainingTables = useTableStore.getState().tables.length

        // If memory > 60% (WARNING_THRESHOLD) AND we dropped a table,
        // the WASM heap is likely fragmented with unreclaimable memory
        if (memStatus.percentage > WARNING_THRESHOLD * 100 && remainingTables > 0) {
          console.log(
            `[DuckDB] Memory still at ${memStatus.percentage.toFixed(0)}% after table deletion - ` +
            `restarting worker to reclaim WASM heap (${remainingTables} tables will restore from Parquet)`
          )

          // Show toast to inform user
          toast({
            title: 'Reclaiming memory...',
            description: 'Restarting database engine. Your data will be restored automatically.',
          })

          // Set not ready - this prevents UI from making queries during restart
          setIsReady(false)

          // Terminate the worker to release WASM memory
          await terminateAndReinitialize()

          // Reinitialize DuckDB with fresh worker
          await initDuckDB()

          // Re-hydrate tables from Parquet snapshots
          const { performHydration } = await import('@/hooks/usePersistence')
          await performHydration(true)  // true = re-hydration mode

          // Set ready again
          setIsReady(true)

          toast({
            title: 'Memory reclaimed',
            description: `Database restarted. ${remainingTables} table(s) restored.`,
          })

          console.log('[DuckDB] Worker restart complete - tables reimported from Parquet')
        }
      } catch (memError) {
        // Don't fail the delete if memory check fails
        console.warn('[DuckDB] Memory check after delete failed:', memError)
        // Ensure we're in a ready state even if memory reclaim failed
        setIsReady(true)
      }
    },
    [removeTable, addAuditEntry]
  )

  const updateCell = useCallback(
    async (tableName: string, rowIndex: number, columnName: string, newValue: unknown) => {
      await updateCellDb(tableName, rowIndex, columnName, newValue)
    },
    []
  )

  const duplicateTable = useCallback(
    async (sourceName: string, targetName: string) => {
      const result = await duplicateTableDb(sourceName, targetName)
      return result
    },
    []
  )

  /**
   * Check if memory compaction should be suggested to the user.
   * Returns true if:
   * - Memory usage is >1.5GB (high but not critical)
   * - User has been idle for >2 minutes
   *
   * This is used for suggestion-based compaction (Phase B.1), not auto-compaction.
   */
  const shouldSuggestCompaction = useCallback(async (): Promise<boolean> => {
    const status = await getFullMemoryStatus()
    const idleTimeMs = idleDetector.getIdleTimeMs()

    // Threshold: 1.5GB memory usage AND 2+ minutes idle
    const MEMORY_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024 // 1.5GB
    const IDLE_THRESHOLD_MS = 2 * 60 * 1000 // 2 minutes

    const isHighMemory = status.usedBytes > MEMORY_THRESHOLD_BYTES
    const isIdle = idleTimeMs > IDLE_THRESHOLD_MS

    if (isHighMemory && isIdle) {
      console.log('[Memory] Compaction suggested:', {
        usedMB: Math.round(status.usedBytes / 1024 / 1024),
        idleSeconds: Math.round(idleTimeMs / 1000),
      })
      return true
    }

    return false
  }, [])

  /**
   * Compact memory by restarting the WASM worker.
   * WASM linear memory pages grow but never shrink (browser limitation).
   * This terminates the worker, releases all linear memory, reinitializes DuckDB,
   * and reloads tables from Parquet snapshots.
   */
  const compactMemory = useCallback(async () => {
    console.log('[DuckDB] Starting memory compaction...')

    // 1. Save current app state first (ensure nothing is lost)
    const { saveAppStateNow } = await import('@/lib/persistence/state-persistence')
    await saveAppStateNow()
    console.log('[DuckDB] App state saved before compaction')

    // 2. Set not ready to block UI queries during restart
    setIsReady(false)

    // 3. Terminate the worker (releases WASM linear memory)
    await terminateAndReinitialize()
    console.log('[DuckDB] Worker terminated')

    // 4. Reinitialize DuckDB with fresh worker
    await initDuckDB()
    console.log('[DuckDB] DuckDB reinitialized')

    // 5. Re-hydrate tables from Parquet snapshots
    const { performHydration } = await import('@/hooks/usePersistence')
    await performHydration(true) // true = re-hydration mode
    console.log('[DuckDB] Tables re-hydrated from Parquet')

    // 6. Clear memory history so trend analysis starts fresh
    const { clearMemoryHistory } = await import('@/lib/memory-manager')
    clearMemoryHistory()

    // 7. Ready again
    setIsReady(true)
    refreshMemory()

    console.log('[DuckDB] Memory compaction complete')
  }, [refreshMemory])

  return {
    isReady,
    isLoading,
    loadFile,
    getData,
    getDataWithRowIds,
    getDataWithKeyset,
    getDataArrowWithKeyset,
    getFilteredDataWithKeyset,
    getFilteredCount,
    runQuery,
    runExecute,
    exportTable,
    deleteTable,
    updateCell,
    duplicateTable,
    compactMemory,
    shouldSuggestCompaction,
  }
}
