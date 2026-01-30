import { create } from 'zustand'
import type { ObfuscationRule, ObfuscationMethod } from '@/types'

/**
 * A single key map entry mapping original to obfuscated value
 */
export interface KeyMapEntry {
  original: string
  obfuscated: string
}

interface ScrubberState {
  tableId: string | null
  tableName: string | null
  secret: string
  rules: ObfuscationRule[]
  previewData: Record<string, unknown>[]
  keyMapEnabled: boolean
  /** Key = column name, Value = array of mappings for that column */
  keyMap: Map<string, KeyMapEntry[]>
  /** Whether the key map has been downloaded (gates Apply button) */
  keyMapDownloaded: boolean
  /** Whether key map generation is in progress */
  isGeneratingKeyMap: boolean
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
  /** Set the key map for a specific column */
  setColumnKeyMap: (column: string, entries: KeyMapEntry[]) => void
  clearKeyMap: () => void
  setKeyMapDownloaded: (downloaded: boolean) => void
  setIsGeneratingKeyMap: (generating: boolean) => void
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
  keyMapDownloaded: false,
  isGeneratingKeyMap: false,
  isProcessing: false,
}

export const useScrubberStore = create<ScrubberState & ScrubberActions>((set, get) => ({
  ...initialState,

  setTable: (tableId, tableName) => set({
    tableId,
    tableName,
    rules: [],
    previewData: [],
    keyMap: new Map(),
    keyMapDownloaded: false,
  }),
  setSecret: (secret) => set({ secret }),

  addRule: (rule) => {
    set((state) => ({
      rules: [...state.rules.filter((r) => r.column !== rule.column), rule],
      // Reset key map state when rules change
      keyMapDownloaded: false,
      keyMap: new Map(),
    }))
  },

  updateRule: (column, method, params) => {
    set((state) => ({
      rules: state.rules.map((r) =>
        r.column === column ? { ...r, method, params } : r
      ),
      // Reset key map state when rules change
      keyMapDownloaded: false,
      keyMap: new Map(),
    }))
  },

  removeRule: (column) => {
    set((state) => {
      const newKeyMap = new Map(state.keyMap)
      newKeyMap.delete(column)
      return {
        rules: state.rules.filter((r) => r.column !== column),
        keyMap: newKeyMap,
        keyMapDownloaded: false,
      }
    })
  },

  setPreviewData: (data) => set({ previewData: data }),
  setKeyMapEnabled: (enabled) => set({
    keyMapEnabled: enabled,
    // Reset downloaded state when toggling
    keyMapDownloaded: false,
  }),

  setColumnKeyMap: (column, entries) => {
    const { keyMap } = get()
    const newKeyMap = new Map(keyMap)
    newKeyMap.set(column, entries)
    set({ keyMap: newKeyMap })
  },

  clearKeyMap: () => set({ keyMap: new Map(), keyMapDownloaded: false }),
  setKeyMapDownloaded: (downloaded) => set({ keyMapDownloaded: downloaded }),
  setIsGeneratingKeyMap: (generating) => set({ isGeneratingKeyMap: generating }),
  setIsProcessing: (processing) => set({ isProcessing: processing }),
  reset: () => set(initialState),
}))
