import { create } from 'zustand'
import type { ObfuscationRule, ObfuscationMethod } from '@/types'

interface ScrubberState {
  tableId: string | null
  tableName: string | null
  secret: string
  rules: ObfuscationRule[]
  previewData: Record<string, unknown>[]
  keyMapEnabled: boolean
  keyMap: Map<string, string>
  isProcessing: boolean
}

interface ScrubberActions {
  setTable: (tableId: string | null, tableName: string | null) => void
  setSecret: (secret: string) => void
  addRule: (rule: ObfuscationRule) => void
  updateRule: (column: string, method: ObfuscationMethod, params?: Record<string, unknown>) => void
  removeRule: (column: string) => void
  setPreviewData: (data: Record<string, unknown>[]) => void
  setKeyMapEnabled: (enabled: boolean) => void
  addToKeyMap: (original: string, obfuscated: string) => void
  clearKeyMap: () => void
  setIsProcessing: (processing: boolean) => void
  reset: () => void
}

const initialState: ScrubberState = {
  tableId: null,
  tableName: null,
  secret: '',
  rules: [],
  previewData: [],
  keyMapEnabled: false,
  keyMap: new Map(),
  isProcessing: false,
}

export const useScrubberStore = create<ScrubberState & ScrubberActions>((set, get) => ({
  ...initialState,

  setTable: (tableId, tableName) => set({ tableId, tableName, rules: [], previewData: [] }),
  setSecret: (secret) => set({ secret }),

  addRule: (rule) => {
    set((state) => ({
      rules: [...state.rules.filter((r) => r.column !== rule.column), rule],
    }))
  },

  updateRule: (column, method, params) => {
    set((state) => ({
      rules: state.rules.map((r) =>
        r.column === column ? { ...r, method, params } : r
      ),
    }))
  },

  removeRule: (column) => {
    set((state) => ({
      rules: state.rules.filter((r) => r.column !== column),
    }))
  },

  setPreviewData: (data) => set({ previewData: data }),
  setKeyMapEnabled: (enabled) => set({ keyMapEnabled: enabled }),

  addToKeyMap: (original, obfuscated) => {
    const { keyMap } = get()
    keyMap.set(original, obfuscated)
    set({ keyMap: new Map(keyMap) })
  },

  clearKeyMap: () => set({ keyMap: new Map() }),
  setIsProcessing: (processing) => set({ isProcessing: processing }),
  reset: () => set(initialState),
}))
