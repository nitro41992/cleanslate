import { create } from 'zustand'
import type { DiffResult } from '@/types'

interface DiffState {
  tableA: string | null
  tableB: string | null
  keyColumns: string[]
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
  setTableA: (tableId: string | null) => void
  setTableB: (tableId: string | null) => void
  setKeyColumns: (columns: string[]) => void
  setResults: (results: DiffResult[]) => void
  setSummary: (summary: DiffState['summary']) => void
  setIsComparing: (comparing: boolean) => void
  setBlindMode: (enabled: boolean) => void
  reset: () => void
}

const initialState: DiffState = {
  tableA: null,
  tableB: null,
  keyColumns: [],
  results: [],
  isComparing: false,
  blindMode: false,
  summary: null,
}

export const useDiffStore = create<DiffState & DiffActions>((set) => ({
  ...initialState,

  setTableA: (tableId) => set({ tableA: tableId }),
  setTableB: (tableId) => set({ tableB: tableId }),
  setKeyColumns: (columns) => set({ keyColumns: columns }),
  setResults: (results) => set({ results }),
  setSummary: (summary) => set({ summary }),
  setIsComparing: (comparing) => set({ isComparing: comparing }),
  setBlindMode: (enabled) => set({ blindMode: enabled }),
  reset: () => set(initialState),
}))
