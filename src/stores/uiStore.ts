import { create } from 'zustand'
import type { PersistenceStatus } from '@/types'
import { getMemoryStatus, MEMORY_LIMIT_BYTES } from '@/lib/duckdb/memory'

export type MemoryLevel = 'normal' | 'warning' | 'critical'

interface UIState {
  sidebarCollapsed: boolean
  persistenceStatus: PersistenceStatus
  lastSavedAt: Date | null
  dirtyTableIds: Set<string>  // Tables with unsaved changes
  memoryUsage: number
  memoryLimit: number
  memoryLevel: MemoryLevel
  busyCount: number  // Reference counter for nested DuckDB locks
  loadingMessage: string | null  // Dynamic loading message for file imports
  skipNextGridReload: boolean  // Flag to skip next DataGrid reload (e.g., after diff close)
  transformingTables: Set<string>  // Tables currently undergoing transforms (prevents edit flushes)
}

interface UIActions {
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPersistenceStatus: (status: PersistenceStatus) => void
  setLastSavedAt: (date: Date | null) => void
  /** Mark a table as having unsaved changes (called immediately when command executes) */
  markTableDirty: (tableId: string) => void
  /** Mark a table as saved (called after Parquet export completes) */
  markTableClean: (tableId: string) => void
  setMemoryUsage: (used: number, limit: number) => void
  setMemoryLevel: (level: MemoryLevel) => void
  /** Refresh memory status from DuckDB - call after operations that change data */
  refreshMemory: () => Promise<void>
  /** Increment busy counter (pauses memory polling) */
  incrementBusy: () => void
  /** Decrement busy counter (resumes memory polling when 0) */
  decrementBusy: () => void
  /** Set dynamic loading message for file imports */
  setLoadingMessage: (message: string | null) => void
  /** Set flag to skip next DataGrid reload (e.g., after diff close) */
  setSkipNextGridReload: (skip: boolean) => void
  /** Mark a table as undergoing transformation (defers edit flushes) */
  setTableTransforming: (tableId: string, isTransforming: boolean) => void
  /** Check if a table is currently undergoing transformation */
  isTableTransforming: (tableId: string) => boolean
}

export const useUIStore = create<UIState & UIActions>((set, get) => ({
  sidebarCollapsed: false,
  persistenceStatus: 'idle',
  lastSavedAt: null,
  dirtyTableIds: new Set<string>(),
  memoryUsage: 0,
  memoryLimit: MEMORY_LIMIT_BYTES, // 3GB (75% of 4GB WASM ceiling)
  memoryLevel: 'normal',
  busyCount: 0,
  loadingMessage: null,
  skipNextGridReload: false,
  transformingTables: new Set<string>(),

  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed })
  },

  setPersistenceStatus: (status) => {
    set({ persistenceStatus: status })
    if (status === 'saved') {
      set({ lastSavedAt: new Date() })
    }
  },

  setLastSavedAt: (date) => {
    set({ lastSavedAt: date })
  },

  markTableDirty: (tableId) => {
    const current = get().dirtyTableIds
    if (!current.has(tableId)) {
      const updated = new Set(current)
      updated.add(tableId)
      set({ dirtyTableIds: updated, persistenceStatus: 'dirty' })
    } else if (get().persistenceStatus !== 'dirty' && get().persistenceStatus !== 'saving') {
      // Ensure status is dirty if we have dirty tables
      set({ persistenceStatus: 'dirty' })
    }
  },

  markTableClean: (tableId) => {
    const current = get().dirtyTableIds
    if (current.has(tableId)) {
      const updated = new Set(current)
      updated.delete(tableId)
      set({ dirtyTableIds: updated })

      // Transition to 'saved' when all tables are clean
      if (updated.size === 0) {
        set({ persistenceStatus: 'saved', lastSavedAt: new Date() })

        // Auto-reset to 'idle' after 3 seconds
        setTimeout(() => {
          // Only reset if still 'saved' (avoid race with new operations)
          if (get().persistenceStatus === 'saved') {
            set({ persistenceStatus: 'idle' })
          }
        }, 3000)
      }
    }
  },

  setMemoryUsage: (used, limit) => {
    set({ memoryUsage: used, memoryLimit: limit })
  },

  setMemoryLevel: (level) => {
    set({ memoryLevel: level })
  },

  refreshMemory: async () => {
    // Skip if any DuckDB operation is in progress (prevents race condition)
    if (get().busyCount > 0) return
    try {
      const status = await getMemoryStatus()
      set({
        memoryUsage: status.usedBytes,
        memoryLimit: status.limitBytes,
        memoryLevel: status.level,
      })
    } catch (error) {
      console.warn('Failed to refresh memory status:', error)
    }
  },

  incrementBusy: () => set((state) => ({ busyCount: state.busyCount + 1 })),
  decrementBusy: () => set((state) => ({ busyCount: Math.max(0, state.busyCount - 1) })),
  setLoadingMessage: (message) => set({ loadingMessage: message }),
  setSkipNextGridReload: (skip) => set({ skipNextGridReload: skip }),

  setTableTransforming: (tableId, isTransforming) => {
    set((state) => {
      const newSet = new Set(state.transformingTables)
      if (isTransforming) {
        newSet.add(tableId)
      } else {
        newSet.delete(tableId)
      }
      return { transformingTables: newSet }
    })
  },

  isTableTransforming: (tableId) => {
    return get().transformingTables.has(tableId)
  },
}))

// Persistence: Auto-save state on UI preference changes
// Import dynamically to avoid circular dependencies
let isRestoringState = false

export function setRestoringState(restoring: boolean) {
  isRestoringState = restoring
}

if (typeof window !== 'undefined') {
  import('@/lib/persistence/debounce').then(({ DebouncedSave }) => {
    const debouncedSave = new DebouncedSave(500)

    useUIStore.subscribe((state, prevState) => {
      // Skip save during state restoration to avoid write cycles
      if (isRestoringState) return

      // Only save if sidebarCollapsed changed
      if (state.sidebarCollapsed !== prevState.sidebarCollapsed) {
        // Trigger debounced save
        debouncedSave.trigger(async () => {
          const { saveAppState } = await import('@/lib/persistence/state-persistence')
          const { useTableStore } = await import('@/stores/tableStore')
          const { useTimelineStore } = await import('@/stores/timelineStore')

          const tableState = useTableStore.getState()
          const timelineState = useTimelineStore.getState()

          await saveAppState(
            tableState.tables,
            tableState.activeTableId,
            timelineState.getSerializedTimelines(),
            state.sidebarCollapsed
          )
        })
      }
    })
  })
}
