import { create } from 'zustand'
import type { TableInfo, ColumnInfo, LineageTransformation, ColumnPreferences } from '@/types'
import { generateId } from '@/lib/utils'
import { cleanupTimelineSnapshots } from '@/lib/timeline-engine'
import { isInternalColumn } from '@/lib/commands/utils/column-ordering'

interface TableState {
  tables: TableInfo[]
  activeTableId: string | null
  isLoading: boolean
  error: string | null
}

interface TableActions {
  addTable: (name: string, columns: ColumnInfo[], rowCount: number, existingId?: string) => string
  removeTable: (id: string) => void
  setActiveTable: (id: string | null) => void
  updateTable: (id: string, updates: Partial<TableInfo>) => void
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
}

export const useTableStore = create<TableState & TableActions>((set, get) => ({
  tables: [],
  activeTableId: null,
  isLoading: false,
  error: null,

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
    // Clean up timeline snapshots (fire-and-forget)
    // This removes _timeline_original_* and _timeline_snapshot_* tables from DuckDB
    cleanupTimelineSnapshots(id).catch((err) => {
      console.warn(`Failed to cleanup timeline snapshots for table ${id}:`, err)
    })

    set((state) => ({
      tables: state.tables.filter((t) => t.id !== id),
      activeTableId: state.activeTableId === id ? null : state.activeTableId,
    }))
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
        console.log('[TableStore] Skipping save - restoring state')
        return
      }

      console.log('[TableStore] State changed, triggering debounced save:', {
        tables: state.tables.length,
        activeTableId: state.activeTableId,
      })

      // Trigger debounced save
      debouncedSaveInstance.trigger(async () => {
        try {
          const { saveAppState } = await import('@/lib/persistence/state-persistence')
          const { useTimelineStore } = await import('@/stores/timelineStore')
          const { useUIStore } = await import('@/stores/uiStore')

          const timelineState = useTimelineStore.getState()
          const uiState = useUIStore.getState()

          await saveAppState(
            state.tables,
            state.activeTableId,
            timelineState.getSerializedTimelines(),
            uiState.sidebarCollapsed
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
