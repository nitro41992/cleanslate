import { create } from 'zustand'

export type PanelType = 'clean' | 'match' | 'combine' | 'recipe' | 'diff' | null

export interface PendingOperation {
  id: string
  type: 'transform' | 'merge' | 'combine' | 'privacy'
  label: string  // Human readable: "Trim whitespace on Name"
  config: unknown
  timestamp: Date
}

interface ChangesSummary {
  transformsApplied: number
  rowsMerged: number
  rowsCombined: number
  columnsObfuscated: number
}

interface PreviewState {
  // Active table being worked on
  activeTableId: string | null
  activeTableName: string | null

  // Panel state
  activePanel: PanelType
  // Secondary panel (e.g., Recipe visible alongside Clean)
  secondaryPanel: PanelType

  // Pending operations queue (applied to preview but not yet persisted)
  pendingOperations: PendingOperation[]

  // Preview state
  isPreviewDirty: boolean
  previewRowCount: number

  // Change summary (vs original)
  changesSummary: ChangesSummary | null

  // Large file indicators
  isLargeFile: boolean
  estimatedSizeMB: number
  lazyPreviewEnabled: boolean

  // Audit sidebar visibility
  auditSidebarOpen: boolean
}

interface PreviewActions {
  // Panel management
  setActivePanel: (panel: PanelType) => void
  setSecondaryPanel: (panel: PanelType) => void
  closePanel: () => void
  closeSecondaryPanel: () => void

  // Table management
  setActiveTable: (tableId: string | null, tableName: string | null) => void

  // Pending operations management
  addPendingOperation: (operation: Omit<PendingOperation, 'id' | 'timestamp'>) => void
  removePendingOperation: (operationId: string) => void
  clearPendingOperations: () => void

  // Preview state
  setPreviewDirty: (dirty: boolean) => void
  setPreviewRowCount: (count: number) => void
  updateChangesSummary: (summary: Partial<ChangesSummary>) => void

  // Large file handling
  setLargeFileMode: (isLarge: boolean, sizeMB?: number) => void
  setLazyPreviewEnabled: (enabled: boolean) => void

  // Audit sidebar
  toggleAuditSidebar: () => void
  setAuditSidebarOpen: (open: boolean) => void

  // Reset
  reset: () => void
}

const generateId = () => Math.random().toString(36).substring(2, 11)

const initialState: PreviewState = {
  activeTableId: null,
  activeTableName: null,
  activePanel: null,
  secondaryPanel: null,
  pendingOperations: [],
  isPreviewDirty: false,
  previewRowCount: 0,
  changesSummary: null,
  isLargeFile: false,
  estimatedSizeMB: 0,
  lazyPreviewEnabled: false,
  auditSidebarOpen: false,
}

export const usePreviewStore = create<PreviewState & PreviewActions>((set) => ({
  ...initialState,

  // Panel management
  setActivePanel: (panel) => {
    set({ activePanel: panel })
  },

  setSecondaryPanel: (panel) => {
    set({ secondaryPanel: panel })
  },

  closePanel: () => {
    set({ activePanel: null })
  },

  closeSecondaryPanel: () => {
    set({ secondaryPanel: null })
  },

  // Table management
  setActiveTable: (tableId, tableName) => {
    set({
      activeTableId: tableId,
      activeTableName: tableName,
      // Clear pending state when switching tables
      pendingOperations: [],
      isPreviewDirty: false,
      changesSummary: null,
    })
  },

  // Pending operations management
  addPendingOperation: (operation) => {
    const newOp: PendingOperation = {
      ...operation,
      id: generateId(),
      timestamp: new Date(),
    }
    set((state) => ({
      pendingOperations: [...state.pendingOperations, newOp],
      isPreviewDirty: true,
    }))
  },

  removePendingOperation: (operationId) => {
    set((state) => {
      const newOps = state.pendingOperations.filter((op) => op.id !== operationId)
      return {
        pendingOperations: newOps,
        isPreviewDirty: newOps.length > 0,
      }
    })
  },

  clearPendingOperations: () => {
    set({
      pendingOperations: [],
      isPreviewDirty: false,
      changesSummary: null,
    })
  },

  // Preview state
  setPreviewDirty: (dirty) => {
    set({ isPreviewDirty: dirty })
  },

  setPreviewRowCount: (count) => {
    set({ previewRowCount: count })
  },

  updateChangesSummary: (summary) => {
    set((state) => ({
      changesSummary: state.changesSummary
        ? { ...state.changesSummary, ...summary }
        : {
            transformsApplied: 0,
            rowsMerged: 0,
            rowsCombined: 0,
            columnsObfuscated: 0,
            ...summary,
          },
    }))
  },

  // Large file handling
  setLargeFileMode: (isLarge, sizeMB = 0) => {
    set({
      isLargeFile: isLarge,
      estimatedSizeMB: sizeMB,
      lazyPreviewEnabled: isLarge,
    })
  },

  setLazyPreviewEnabled: (enabled) => {
    set({ lazyPreviewEnabled: enabled })
  },

  // Audit sidebar
  toggleAuditSidebar: () => {
    set((state) => ({ auditSidebarOpen: !state.auditSidebarOpen }))
  },

  setAuditSidebarOpen: (open) => {
    set({ auditSidebarOpen: open })
  },

  // Reset
  reset: () => {
    set(initialState)
  },
}))
