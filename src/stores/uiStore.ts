import { create } from 'zustand'
import type { PersistenceStatus } from '@/types'

interface UIState {
  sidebarCollapsed: boolean
  persistenceStatus: PersistenceStatus
  lastSavedAt: Date | null
  memoryUsage: number
  memoryLimit: number
}

interface UIActions {
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPersistenceStatus: (status: PersistenceStatus) => void
  setLastSavedAt: (date: Date | null) => void
  setMemoryUsage: (used: number, limit: number) => void
}

export const useUIStore = create<UIState & UIActions>((set) => ({
  sidebarCollapsed: false,
  persistenceStatus: 'idle',
  lastSavedAt: null,
  memoryUsage: 0,
  memoryLimit: 4 * 1024 * 1024 * 1024, // 4GB

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
}))
