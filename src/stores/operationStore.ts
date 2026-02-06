import { create } from 'zustand'
import { generateId } from '@/lib/utils'

export type OperationSource = 'clean' | 'recipe' | 'combine' | 'match' | 'standardize'

export interface ActiveOperation {
  id: string
  source: OperationSource
  label: string
  progress: number // 0-100, or -1 for indeterminate
  message: string
  startedAt: Date
}

interface OperationState {
  operations: Map<string, ActiveOperation>
}

interface OperationActions {
  registerOperation: (source: OperationSource, label: string) => string
  updateProgress: (id: string, progress: number, message?: string) => void
  deregisterOperation: (id: string) => void
  hasActiveOperations: () => boolean
  getActiveOperations: () => ActiveOperation[]
}

export const useOperationStore = create<OperationState & OperationActions>((set, get) => ({
  operations: new Map(),

  registerOperation: (source, label) => {
    const id = generateId()
    set((state) => {
      const next = new Map(state.operations)
      next.set(id, {
        id,
        source,
        label,
        progress: -1,
        message: '',
        startedAt: new Date(),
      })
      return { operations: next }
    })
    return id
  },

  updateProgress: (id, progress, message) => {
    set((state) => {
      const op = state.operations.get(id)
      if (!op) return state
      const next = new Map(state.operations)
      next.set(id, {
        ...op,
        progress,
        ...(message !== undefined && { message }),
      })
      return { operations: next }
    })
  },

  deregisterOperation: (id) => {
    set((state) => {
      if (!state.operations.has(id)) return state
      const next = new Map(state.operations)
      next.delete(id)
      return { operations: next }
    })
  },

  hasActiveOperations: () => {
    return get().operations.size > 0
  },

  getActiveOperations: () => {
    return Array.from(get().operations.values())
  },
}))
