import { create } from 'zustand'
import type { DiffSummary } from '@/lib/diff-engine'

export type DiffMode = 'compare-preview' | 'compare-tables'

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
  // UI state
  isComparing: boolean
  blindMode: boolean
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
  }) => void
  setSummary: (summary: DiffState['summary']) => void
  setIsComparing: (comparing: boolean) => void
  setBlindMode: (enabled: boolean) => void
  reset: () => void
  clearResults: () => void
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
  isComparing: false,
  blindMode: false,
}

export const useDiffStore = create<DiffState & DiffActions>((set) => ({
  ...initialState,

  openView: () => set({ isViewOpen: true }),
  closeView: () => set({ isViewOpen: false }),
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
    keyColumns: [],
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
  }),
  setSummary: (summary) => set({ summary }),
  setIsComparing: (comparing) => set({ isComparing: comparing }),
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
  }),
  reset: () => set(initialState),
}))
