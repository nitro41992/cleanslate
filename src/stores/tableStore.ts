import { create } from 'zustand'
import type { TableInfo, ColumnInfo } from '@/types'
import { generateId } from '@/lib/utils'

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
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearTables: () => void
}

export const useTableStore = create<TableState & TableActions>((set) => ({
  tables: [],
  activeTableId: null,
  isLoading: false,
  error: null,

  addTable: (name, columns, rowCount, existingId) => {
    const id = existingId || generateId()
    const now = new Date()
    const newTable: TableInfo = {
      id,
      name,
      columns,
      rowCount,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      tables: [...state.tables, newTable],
      activeTableId: id,
    }))
    return id
  },

  removeTable: (id) => {
    set((state) => ({
      tables: state.tables.filter((t) => t.id !== id),
      activeTableId: state.activeTableId === id ? null : state.activeTableId,
    }))
  },

  setActiveTable: (id) => {
    set({ activeTableId: id })
  },

  updateTable: (id, updates) => {
    set((state) => ({
      tables: state.tables.map((t) =>
        t.id === id ? { ...t, ...updates, updatedAt: new Date() } : t
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
}))
