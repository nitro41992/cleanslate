import { create } from 'zustand'
import type { PersistenceStatus } from '@/types'
import { getMemoryStatus, MEMORY_LIMIT_BYTES } from '@/lib/duckdb/memory'

export type MemoryLevel = 'normal' | 'warning' | 'critical'

interface UIState {
  sidebarCollapsed: boolean
  persistenceStatus: PersistenceStatus
  lastSavedAt: Date | null
  memoryUsage: number
  memoryLimit: number
  memoryLevel: MemoryLevel
  busyCount: number  // Reference counter for nested DuckDB locks
}

interface UIActions {
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPersistenceStatus: (status: PersistenceStatus) => void
  setLastSavedAt: (date: Date | null) => void
  setMemoryUsage: (used: number, limit: number) => void
  setMemoryLevel: (level: MemoryLevel) => void
  /** Refresh memory status from DuckDB - call after operations that change data */
  refreshMemory: () => Promise<void>
  /** Increment busy counter (pauses memory polling) */
  incrementBusy: () => void
  /** Decrement busy counter (resumes memory polling when 0) */
  decrementBusy: () => void
}

export const useUIStore = create<UIState & UIActions>((set, get) => ({
  sidebarCollapsed: false,
  persistenceStatus: 'idle',
  lastSavedAt: null,
  memoryUsage: 0,
  memoryLimit: MEMORY_LIMIT_BYTES, // 3GB (75% of 4GB WASM ceiling)
  memoryLevel: 'normal',
  busyCount: 0,

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
}))
