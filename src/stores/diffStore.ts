import { create } from 'zustand'
import type { DiffResult } from '@/types'

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
  // Results
  results: DiffResult[]
  isComparing: boolean
  blindMode: boolean
  summary: {
    added: number
    removed: number
    modified: number
    unchanged: number
  } | null
}

interface DiffActions {
  openView: () => void
  closeView: () => void
  setMode: (mode: DiffMode) => void
  setTableA: (tableId: string | null) => void
  setTableB: (tableId: string | null) => void
  setPreviewTableId: (tableId: string | null) => void
  setKeyColumns: (columns: string[]) => void
  setResults: (results: DiffResult[]) => void
  setSummary: (summary: DiffState['summary']) => void
  setIsComparing: (comparing: boolean) => void
  setBlindMode: (enabled: boolean) => void
  reset: () => void
}

const initialState: DiffState = {
  isViewOpen: false,
  mode: 'compare-preview',
  tableA: null,
  tableB: null,
  previewTableId: null,
  keyColumns: [],
  results: [],
  isComparing: false,
  blindMode: false,
  summary: null,
}

export const useDiffStore = create<DiffState & DiffActions>((set) => ({
  ...initialState,

  openView: () => set({ isViewOpen: true }),
  closeView: () => set({ isViewOpen: false }),
  setMode: (mode) => set({
    mode,
    // Clear results when switching modes
    results: [],
    summary: null,
    keyColumns: [],
  }),
  setTableA: (tableId) => set({ tableA: tableId }),
  setTableB: (tableId) => set({ tableB: tableId }),
  setPreviewTableId: (tableId) => set({ previewTableId: tableId }),
  setKeyColumns: (columns) => set({ keyColumns: columns }),
  setResults: (results) => set({ results }),
  setSummary: (summary) => set({ summary }),
  setIsComparing: (comparing) => set({ isComparing: comparing }),
  setBlindMode: (enabled) => set({ blindMode: enabled }),
  reset: () => set(initialState),
}))
