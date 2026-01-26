import { create } from 'zustand'
import type { TableInfo, ColumnInfo, LineageTransformation } from '@/types'
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
}

export const useTableStore = create<TableState & TableActions>((set) => ({
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
    }

    set((s) => ({
      tables: [...s.tables, newTable],
      activeTableId: id,
    }))

    return id
  },
}))
