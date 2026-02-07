import { create } from 'zustand'
import type { TableInfo, ColumnInfo, LineageTransformation, ColumnPreferences, ColumnFilter, TableViewState } from '@/types'
import { generateId } from '@/lib/utils'
import { cleanupTimelineSnapshots } from '@/lib/timeline-engine'
import { isInternalColumn } from '@/lib/commands/utils/column-ordering'

interface TableState {
  tables: TableInfo[]
  activeTableId: string | null
  isLoading: boolean
  error: string | null
  /**
   * Tables that are "frozen" (exported to OPFS, dropped from DuckDB memory).
   * Part of Single Active Table Policy: Only ONE table lives in DuckDB at a time.
   */
  frozenTables: Set<string>
  /**
   * Tables currently being background-materialized (importing shards into DuckDB).
   * While materializing, grid uses shard-backed rendering; editing is gated.
   */
  materializingTables: Set<string>
  /**
   * Whether a table context switch is in progress (freeze/thaw operation).
   * Used to show loading overlay and prevent concurrent switches.
   */
  isContextSwitching: boolean
}

interface TableActions {
  addTable: (name: string, columns: ColumnInfo[], rowCount: number, existingId?: string) => string
  removeTable: (id: string) => void
  setActiveTable: (id: string | null) => void
  updateTable: (id: string, updates: Partial<TableInfo>) => void
  /** Update table metadata without triggering grid reload (no dataVersion bump) */
  updateTableSilent: (id: string, updates: Partial<TableInfo>) => void
  incrementDataVersion: (id: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearTables: () => void
  checkpointTable: (
    sourceId: string,
    newName: string,
    columns: ColumnInfo[],
    rowCount: number,
    transformations: LineageTransformation[]
  ) => string
  loadTables: (tables: TableInfo[]) => void
  /** Update column width preference for a table */
  updateColumnWidth: (tableId: string, columnName: string, width: number) => void
  /** Get column preferences for a table */
  getColumnPreferences: (tableId: string) => ColumnPreferences | undefined
  /** Toggle word wrap for a table */
  toggleWordWrap: (tableId: string) => void
  /** Check if word wrap is enabled for a table */
  isWordWrapEnabled: (tableId: string) => boolean
  /** Set a filter on a table column (replaces existing filter for that column) */
  setFilter: (tableId: string, filter: ColumnFilter) => void
  /** Remove filter from a specific column */
  removeFilter: (tableId: string, column: string) => void
  /** Clear all filters from a table */
  clearFilters: (tableId: string) => void
  /** Set sort configuration for a table */
  setSort: (tableId: string, column: string | null, direction: 'asc' | 'desc') => void
  /** Clear all view state (filters and sort) */
  clearViewState: (tableId: string) => void
  /** Get current view state for a table */
  getViewState: (tableId: string) => TableViewState | undefined
  /**
   * Switch to a table with freeze/thaw logic.
   * Freezes the current active table to OPFS and thaws the target table.
   * Part of Single Active Table Policy.
   */
  switchToTable: (targetTableId: string) => Promise<boolean>
  /** Mark a table as frozen (in OPFS, not in DuckDB) */
  markTableFrozen: (tableId: string) => void
  /** Mark a table as thawed (loaded in DuckDB) */
  markTableThawed: (tableId: string) => void
  /** Check if a table is frozen */
  isTableFrozen: (tableId: string) => boolean
  /** Set context switching state */
  setContextSwitching: (isSwitching: boolean) => void
  /** Set column order for a table (for drag-drop reordering) */
  setColumnOrder: (tableId: string, columnOrder: string[]) => void
  /** Mark a table as currently being background-materialized */
  markTableMaterializing: (tableId: string) => void
  /** Mark a table as fully materialized (background import complete) */
  markTableMaterialized: (tableId: string) => void
  /** Check if a table is currently being materialized */
  isTableMaterializing: (tableId: string) => boolean
  /** Wait for a table to finish materializing (with timeout) */
  waitForMaterialization: (tableId: string, timeoutMs?: number) => Promise<boolean>
}

export const useTableStore = create<TableState & TableActions>((set, get) => ({
  tables: [],
  activeTableId: null,
  isLoading: false,
  error: null,
  frozenTables: new Set<string>(),
  materializingTables: new Set<string>(),
  isContextSwitching: false,

  addTable: (name, columns, rowCount, existingId) => {
    const id = existingId || generateId()
    const now = new Date()

    // Initialize columnOrder with user-visible columns (exclude _cs_id, __base)
    const columnOrder = columns
      .filter(c => !isInternalColumn(c.name))
      .map(c => c.name)

    const newTable: TableInfo = {
      id,
      name,
      columns,
      rowCount,
      createdAt: now,
      updatedAt: now,
      dataVersion: 0,
      columnOrder,
    }
    set((state) => ({
      tables: [...state.tables, newTable],
      activeTableId: id,
    }))

    // Immediately trigger save for table additions (critical operation)
    if (typeof window !== 'undefined' && !isRestoringState) {
      import('@/lib/persistence/state-persistence').then(({ saveAppStateNow }) => {
        saveAppStateNow().catch(err => {
          console.error('[TableStore] Failed to save after addTable:', err)
        })
      })
    }

    return id
  },

  removeTable: (id) => {
    // Get table name BEFORE removal for snapshot cleanup
    const table = get().tables.find((t) => t.id === id)
    const tableName = table?.name

    // Clean up timeline snapshots (fire-and-forget)
    // This removes _timeline_original_* and _timeline_snapshot_* tables from DuckDB
    // Pass tableName so cleanup works even if timeline doesn't exist
    cleanupTimelineSnapshots(id, tableName).catch((err) => {
      console.warn(`Failed to cleanup timeline snapshots for table ${id}:`, err)
    })

    // Clear lastEdit if it references this table
    import('@/stores/uiStore').then(({ useUIStore }) => {
      useUIStore.getState().clearLastEditForTable(id)
    })

    set((state) => ({
      tables: state.tables.filter((t) => t.id !== id),
      activeTableId: state.activeTableId === id ? null : state.activeTableId,
    }))

    // Immediately trigger save for table deletions (critical operation)
    // Matches addTable pattern - ensures app-state.json is updated before potential refresh
    // Without this, debounced save (500ms) may not complete if user refreshes quickly
    if (typeof window !== 'undefined' && !isRestoringState) {
      import('@/lib/persistence/state-persistence').then(({ saveAppStateNow }) => {
        saveAppStateNow().catch(err => {
          console.error('[TableStore] Failed to save after removeTable:', err)
        })
      })
    }
  },

  setActiveTable: (id) => {
    set({ activeTableId: id })
  },

  updateTable: (id, updates) => {
    set((state) => {
      const table = state.tables.find((t) => t.id === id)
      const newDataVersion = (table?.dataVersion || 0) + 1
      console.log('[TABLESTORE] updateTable called', { id, updates, oldDataVersion: table?.dataVersion, newDataVersion })
      return {
        tables: state.tables.map((t) =>
          t.id === id
            ? {
                ...t,
                ...updates,
                updatedAt: new Date(),
                // Auto-increment: any update triggers grid refresh
                dataVersion: newDataVersion,
              }
            : t
        ),
      }
    })
  },

  updateTableSilent: (id, updates) => {
    set((state) => {
      console.log('[TABLESTORE] updateTableSilent called (no dataVersion bump)', { id, updates })
      return {
        tables: state.tables.map((t) =>
          t.id === id
            ? {
                ...t,
                ...updates,
                updatedAt: new Date(),
                // NO dataVersion increment - grid won't reload
              }
            : t
        ),
      }
    })
  },

  incrementDataVersion: (id) => {
    set((state) => ({
      tables: state.tables.map((t) =>
        t.id === id ? { ...t, dataVersion: (t.dataVersion || 0) + 1 } : t
      ),
    }))
  },

  setLoading: (loading) => {
    set({ isLoading: loading })
  },

  setError: (error) => {
    set({ error })
  },

  clearTables: () => {
    set({ tables: [], activeTableId: null })
  },

  checkpointTable: (sourceId, newName, columns, rowCount, transformations) => {
    const id = generateId()
    const now = new Date()
    const state = useTableStore.getState()
    const sourceTable = state.tables.find((t) => t.id === sourceId)

    if (!sourceTable) return id

    // Preserve columnOrder from source table
    const columnOrder = sourceTable.columnOrder

    const newTable: TableInfo = {
      id,
      name: newName,
      columns,
      rowCount,
      createdAt: now,
      updatedAt: now,
      parentTableId: sourceId,
      isCheckpoint: true,
      lineage: {
        sourceTableId: sourceId,
        sourceTableName: sourceTable.name,
        transformations,
        checkpointedAt: now,
      },
      dataVersion: 0,
      columnOrder,
    }

    set((s) => ({
      tables: [...s.tables, newTable],
      activeTableId: id,
    }))

    return id
  },

  loadTables: (tables) => {
    // Bulk load tables during restoration (doesn't trigger subscriptions)
    set({ tables })
  },

  updateColumnWidth: (tableId, columnName, width) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        // Merge new width into existing preferences
        const currentWidths = t.columnPreferences?.widths || {}
        const updatedPreferences: ColumnPreferences = {
          ...t.columnPreferences,
          widths: {
            ...currentWidths,
            [columnName]: width,
          },
        }

        return {
          ...t,
          columnPreferences: updatedPreferences,
          updatedAt: new Date(),
          // Note: Do NOT increment dataVersion here - column widths are UI-only
          // and shouldn't trigger data reload
        }
      }),
    }))
  },

  getColumnPreferences: (tableId) => {
    const state = get()
    const table = state.tables.find((t) => t.id === tableId)
    return table?.columnPreferences
  },

  toggleWordWrap: (tableId) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        const currentEnabled = t.columnPreferences?.wordWrapEnabled ?? false
        const updatedPreferences: ColumnPreferences = {
          ...t.columnPreferences,
          widths: t.columnPreferences?.widths || {},
          wordWrapEnabled: !currentEnabled,
        }

        return {
          ...t,
          columnPreferences: updatedPreferences,
          updatedAt: new Date(),
          // Note: Do NOT increment dataVersion here - word wrap is UI-only
        }
      }),
    }))
  },

  isWordWrapEnabled: (tableId) => {
    const state = get()
    const table = state.tables.find((t) => t.id === tableId)
    return table?.columnPreferences?.wordWrapEnabled ?? false
  },

  setFilter: (tableId, filter) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        const currentViewState = t.viewState || {
          filters: [],
          sortColumn: null,
          sortDirection: 'asc' as const,
        }

        // Replace existing filter for this column, or add new one
        const existingIndex = currentViewState.filters.findIndex(
          (f) => f.column === filter.column
        )
        const newFilters =
          existingIndex >= 0
            ? currentViewState.filters.map((f, i) =>
                i === existingIndex ? filter : f
              )
            : [...currentViewState.filters, filter]

        return {
          ...t,
          viewState: {
            ...currentViewState,
            filters: newFilters,
          },
          updatedAt: new Date(),
          // Note: Do NOT increment dataVersion - view state is UI-only
        }
      }),
    }))
  },

  removeFilter: (tableId, column) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        const currentViewState = t.viewState
        if (!currentViewState) return t

        return {
          ...t,
          viewState: {
            ...currentViewState,
            filters: currentViewState.filters.filter((f) => f.column !== column),
          },
          updatedAt: new Date(),
        }
      }),
    }))
  },

  clearFilters: (tableId) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        const currentViewState = t.viewState
        if (!currentViewState) return t

        return {
          ...t,
          viewState: {
            ...currentViewState,
            filters: [],
          },
          updatedAt: new Date(),
        }
      }),
    }))
  },

  setSort: (tableId, column, direction) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        const currentViewState = t.viewState || {
          filters: [],
          sortColumn: null,
          sortDirection: 'asc' as const,
        }

        return {
          ...t,
          viewState: {
            ...currentViewState,
            sortColumn: column,
            sortDirection: direction,
          },
          updatedAt: new Date(),
        }
      }),
    }))
  },

  clearViewState: (tableId) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t

        return {
          ...t,
          viewState: undefined,
          updatedAt: new Date(),
        }
      }),
    }))
  },

  getViewState: (tableId) => {
    const state = get()
    const table = state.tables.find((t) => t.id === tableId)
    return table?.viewState
  },

  switchToTable: async (targetTableId) => {
    const state = get()

    // If already switching, don't allow concurrent switches
    if (state.isContextSwitching) {
      console.warn('[TableStore] Context switch already in progress')
      return false
    }

    // If target is already active, nothing to do
    if (state.activeTableId === targetTableId) {
      return true
    }

    const targetTable = state.tables.find((t) => t.id === targetTableId)
    if (!targetTable) {
      console.error(`[TableStore] Target table ${targetTableId} not found`)
      return false
    }

    const currentTable = state.tables.find((t) => t.id === state.activeTableId)

    set({ isContextSwitching: true })

    try {
      // Dynamically import DuckDB and snapshot functions to avoid circular dependencies
      const { initDuckDB, getConnection } = await import('@/lib/duckdb')
      const { freezeTable, cancelMaterialization, backgroundMaterialize } = await import('@/lib/opfs/snapshot-storage')

      const db = await initDuckDB()
      const conn = await getConnection()

      // Step 1: Cancel any in-flight materialization for the current table
      if (state.activeTableId && state.materializingTables.has(state.activeTableId)) {
        cancelMaterialization(state.activeTableId)
        // Remove from materializing set
        const updatedMat = new Set(state.materializingTables)
        updatedMat.delete(state.activeTableId)
        set({ materializingTables: updatedMat })
      }

      // Step 2: Freeze current table (if any and if materialized in DuckDB)
      if (currentTable && state.activeTableId) {
        // Only freeze if the table is actually in DuckDB (not still frozen from lazy thaw)
        if (!state.frozenTables.has(state.activeTableId)) {
          console.log(`[TableStore] Freezing current table: ${currentTable.name}`)
          const freezeSuccess = await freezeTable(db, conn, currentTable.name, state.activeTableId)
          if (!freezeSuccess) {
            console.error(`[TableStore] Failed to freeze ${currentTable.name}`)
            set({ isContextSwitching: false })
            return false
          }
        }
        // Mark as frozen
        const updatedFrozen = new Set(get().frozenTables)
        updatedFrozen.add(state.activeTableId)
        set({ frozenTables: updatedFrozen })
      }

      // Step 3: Lazy thaw — set target as active immediately (grid uses shard-backed rendering)
      // The table stays frozen; the grid reads from shards via ChunkManager.
      // Keep target in frozenTables for now — grid will use shard-backed rendering
      set({
        activeTableId: targetTableId,
        isContextSwitching: false,
      })

      console.log(`[TableStore] Lazy switch complete: ${currentTable?.name || 'none'} → ${targetTable.name} (shard-backed)`)

      // Step 4: Start background materialization (imports shards into DuckDB)
      // This runs asynchronously — the grid is already usable via shard-backed rendering
      const updatedMat = new Set(get().materializingTables)
      updatedMat.add(targetTableId)
      set({ materializingTables: updatedMat })

      // Fire-and-forget: background materialization
      backgroundMaterialize(targetTable.name, targetTableId).then((success) => {
        if (success) {
          console.log(`[TableStore] Background materialization succeeded for ${targetTable.name}`)
        } else {
          console.warn(`[TableStore] Background materialization failed for ${targetTable.name}`)
        }
      }).catch((err) => {
        console.error(`[TableStore] Background materialization error for ${targetTable.name}:`, err)
      })

      return true
    } catch (error) {
      console.error('[TableStore] Context switch failed:', error)
      set({ isContextSwitching: false })
      return false
    }
  },

  markTableFrozen: (tableId) => {
    set((state) => {
      const updated = new Set(state.frozenTables)
      updated.add(tableId)
      return { frozenTables: updated }
    })
  },

  markTableThawed: (tableId) => {
    set((state) => {
      const updated = new Set(state.frozenTables)
      updated.delete(tableId)
      return { frozenTables: updated }
    })
  },

  isTableFrozen: (tableId) => {
    return get().frozenTables.has(tableId)
  },

  setContextSwitching: (isSwitching) => {
    set({ isContextSwitching: isSwitching })
  },

  setColumnOrder: (tableId, columnOrder) => {
    set((state) => ({
      tables: state.tables.map((t) => {
        if (t.id !== tableId) return t
        return {
          ...t,
          columnOrder,
          updatedAt: new Date(),
        }
      }),
    }))
    console.log(`[TableStore] Column order updated for ${tableId}:`, columnOrder)

    // Immediately trigger save for column reorder (critical user operation)
    if (typeof window !== 'undefined' && !isRestoringState) {
      import('@/lib/persistence/state-persistence').then(({ saveAppStateNow }) => {
        saveAppStateNow().catch(err => {
          console.error('[TableStore] Failed to save after setColumnOrder:', err)
        })
      })
    }
  },

  markTableMaterializing: (tableId) => {
    set((state) => {
      const updated = new Set(state.materializingTables)
      updated.add(tableId)
      return { materializingTables: updated }
    })
  },

  markTableMaterialized: (tableId) => {
    set((state) => {
      const updated = new Set(state.materializingTables)
      updated.delete(tableId)
      // Also remove from frozen since it's now fully in DuckDB
      const updatedFrozen = new Set(state.frozenTables)
      updatedFrozen.delete(tableId)
      return { materializingTables: updated, frozenTables: updatedFrozen }
    })
    console.log(`[TableStore] Table ${tableId} materialized (background import complete)`)
  },

  isTableMaterializing: (tableId) => {
    return get().materializingTables.has(tableId)
  },

  waitForMaterialization: async (tableId, timeoutMs = 10000) => {
    const startTime = Date.now()
    while (get().materializingTables.has(tableId)) {
      if (Date.now() - startTime > timeoutMs) {
        console.warn(`[TableStore] Materialization timeout for ${tableId} after ${timeoutMs}ms`)
        return false
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return true
  },
}))

// Persistence: Auto-save state on table changes
// Import dynamically to avoid circular dependencies
let isRestoringState = false
let debouncedSaveInstance: any = null

export function setRestoringState(restoring: boolean) {
  isRestoringState = restoring
}

if (typeof window !== 'undefined') {
  import('@/lib/persistence/debounce').then(({ DebouncedSave }) => {
    debouncedSaveInstance = new DebouncedSave(500)
    console.log('[TableStore] Persistence subscription initialized')

    useTableStore.subscribe((state) => {
      // Skip save during state restoration to avoid write cycles
      if (isRestoringState) {
        return
      }

      // Trigger debounced save
      debouncedSaveInstance.trigger(async () => {
        try {
          const { saveAppState } = await import('@/lib/persistence/state-persistence')
          const { useTimelineStore } = await import('@/stores/timelineStore')
          const { useUIStore } = await import('@/stores/uiStore')
          const { useRecipeStore } = await import('@/stores/recipeStore')
          const { useMatcherStore } = await import('@/stores/matcherStore')

          const timelineState = useTimelineStore.getState()
          const uiState = useUIStore.getState()
          const recipeState = useRecipeStore.getState()
          const matcherSerialized = useMatcherStore.getState().getSerializedState()
          // Fill in tableRowCount from current table data
          if (matcherSerialized) {
            const matchTable = state.tables.find(t => t.id === matcherSerialized.tableId)
            matcherSerialized.tableRowCount = matchTable?.rowCount ?? 0
          }

          await saveAppState(
            state.tables,
            state.activeTableId,
            timelineState.getSerializedTimelines(),
            uiState.sidebarCollapsed,
            uiState.lastEdit,
            recipeState.recipes,
            matcherSerialized
          )
        } catch (error) {
          console.error('[TableStore] Failed to save state:', error)
        }
      })
    })

    // Note: beforeunload can't wait for async operations in modern browsers
    // Critical saves (like addTable) are now immediate, so debounce is only for frequent updates
  }).catch(err => {
    console.error('[TableStore] Failed to initialize persistence:', err)
  })
}
