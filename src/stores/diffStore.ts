import { create } from 'zustand'
import type { DiffSummary } from '@/lib/diff-engine'
import { clearDiffCaches } from '@/lib/diff-engine'

export type DiffMode = 'compare-preview' | 'compare-tables'

type DiffStatus = 'added' | 'removed' | 'modified'

interface DiffState {
  // View state
  isViewOpen: boolean
  // Comparison mode
  mode: DiffMode
  // Configuration for "compare-tables" mode
  tableA: string | null
  tableB: string | null
  // Configuration for "compare-preview" mode (uses active table)
  previewTableId: string | null
  // Key columns (shared between modes)
  keyColumns: string[]
  // Diff results - now stored in temp table for scalability
  diffTableName: string | null   // Temp table reference (narrow metadata table)
  sourceTableName: string        // Source table (A/original) for JOIN during pagination
  targetTableName: string        // Target table (B/current) for JOIN during pagination
  totalDiffRows: number          // Total non-unchanged rows
  allColumns: string[]           // For grid columns
  keyOrderBy: string             // For consistent ordering
  summary: DiffSummary | null    // Summary counts (small, keep in memory)
  newColumns: string[]           // Columns added (in A but not B)
  removedColumns: string[]       // Columns removed (in B but not A)
  storageType: 'memory' | 'snapshot' | null  // Storage type for diff results
  hasOriginIdB: boolean          // Whether target table had _cs_origin_id at diff creation (for consistent fetch)
  // UI state
  isComparing: boolean
  // Progress tracking for large diffs
  diffProgress: {
    phase: 'indexing' | 'joining' | 'comparing' | 'summarizing'
    current: number
    total: number
  } | null
  blindMode: boolean
  // Grid customization
  columnWidths: Record<string, number>  // columnName -> width
  wordWrapEnabled: boolean
  // Filters
  statusFilter: DiffStatus[] | null  // null = show all, array = show only those statuses
  columnFilter: string | null  // column name to filter on, null = all
}

interface DiffActions {
  openView: () => void
  closeView: () => void
  setMode: (mode: DiffMode) => void
  setTableA: (tableId: string | null) => void
  setTableB: (tableId: string | null) => void
  setPreviewTableId: (tableId: string | null) => void
  setKeyColumns: (columns: string[]) => void
  setDiffConfig: (config: {
    diffTableName: string
    sourceTableName: string
    targetTableName: string
    totalDiffRows: number
    allColumns: string[]
    keyOrderBy: string
    summary: DiffSummary
    newColumns: string[]
    removedColumns: string[]
    storageType: 'memory' | 'snapshot'
    hasOriginIdB: boolean
  }) => void
  setSummary: (summary: DiffState['summary']) => void
  setIsComparing: (comparing: boolean) => void
  setDiffProgress: (progress: DiffState['diffProgress']) => void
  setBlindMode: (enabled: boolean) => void
  reset: () => void
  clearResults: () => void
  // Grid customization actions
  setColumnWidth: (column: string, width: number) => void
  clearColumnWidths: () => void
  toggleWordWrap: () => void
  // Filter actions
  toggleStatusFilter: (status: DiffStatus) => void
  clearStatusFilter: () => void
  setColumnFilter: (column: string | null) => void
}

const initialState: DiffState = {
  isViewOpen: false,
  mode: 'compare-preview',
  tableA: null,
  tableB: null,
  previewTableId: null,
  keyColumns: [],
  diffTableName: null,
  sourceTableName: '',
  targetTableName: '',
  totalDiffRows: 0,
  allColumns: [],
  keyOrderBy: '',
  summary: null,
  newColumns: [],
  removedColumns: [],
  storageType: null,
  hasOriginIdB: true,  // Default to true for safety
  isComparing: false,
  diffProgress: null,
  blindMode: false,
  // Grid customization
  columnWidths: {},
  wordWrapEnabled: false,
  // Filters
  statusFilter: null,
  columnFilter: null,
}

export const useDiffStore = create<DiffState & DiffActions>((set) => ({
  ...initialState,

  openView: () => set({ isViewOpen: true }),
  closeView: () => {
    // Clear diff caches when view closes to free memory (fire-and-forget)
    clearDiffCaches().catch((err) => console.warn('[DiffStore] Cache cleanup error:', err))
    set({ isViewOpen: false })
  },
  setMode: (mode) => set({
    mode,
    // Clear results when switching modes
    diffTableName: null,
    sourceTableName: '',
    targetTableName: '',
    totalDiffRows: 0,
    allColumns: [],
    keyOrderBy: '',
    summary: null,
    newColumns: [],
    removedColumns: [],
    storageType: null,
    hasOriginIdB: true,
    keyColumns: [],
    diffProgress: null,
  }),
  setTableA: (tableId) => set({ tableA: tableId }),
  setTableB: (tableId) => set({ tableB: tableId }),
  setPreviewTableId: (tableId) => set({ previewTableId: tableId }),
  setKeyColumns: (columns) => set({ keyColumns: columns }),
  setDiffConfig: (config) => set({
    diffTableName: config.diffTableName,
    sourceTableName: config.sourceTableName,
    targetTableName: config.targetTableName,
    totalDiffRows: config.totalDiffRows,
    allColumns: config.allColumns,
    keyOrderBy: config.keyOrderBy,
    summary: config.summary,
    newColumns: config.newColumns,
    removedColumns: config.removedColumns,
    storageType: config.storageType,
    hasOriginIdB: config.hasOriginIdB,
  }),
  setSummary: (summary) => set({ summary }),
  setIsComparing: (comparing) => set({ isComparing: comparing }),
  setDiffProgress: (progress) => set({ diffProgress: progress }),
  setBlindMode: (enabled) => set({ blindMode: enabled }),
  clearResults: () => set({
    diffTableName: null,
    sourceTableName: '',
    targetTableName: '',
    totalDiffRows: 0,
    allColumns: [],
    keyOrderBy: '',
    summary: null,
    newColumns: [],
    removedColumns: [],
    storageType: null,
    hasOriginIdB: true,
    diffProgress: null,
    // Clear grid customization and filters on new comparison
    columnWidths: {},
    statusFilter: null,
    columnFilter: null,
  }),
  reset: () => set(initialState),
  // Grid customization actions
  setColumnWidth: (column, width) => set((state) => ({
    columnWidths: { ...state.columnWidths, [column]: width }
  })),
  clearColumnWidths: () => set({ columnWidths: {} }),
  toggleWordWrap: () => set((state) => ({ wordWrapEnabled: !state.wordWrapEnabled })),
  // Filter actions
  toggleStatusFilter: (status) => set((state) => {
    const current = state.statusFilter
    if (current === null) {
      // First click: filter to just this status
      return { statusFilter: [status] }
    }
    if (current.includes(status)) {
      // Status already selected: deselect it
      const newFilter = current.filter(s => s !== status)
      // If all deselected, reset to null (show all)
      return { statusFilter: newFilter.length === 0 ? null : newFilter }
    } else {
      // Add status to filter
      return { statusFilter: [...current, status] }
    }
  }),
  clearStatusFilter: () => set({ statusFilter: null }),
  setColumnFilter: (column) => set({ columnFilter: column }),
}))
