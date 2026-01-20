import { create } from 'zustand'
import type { JoinType, StackValidation, JoinValidation } from '@/types'

type CombinerMode = 'stack' | 'join'

interface CombinerState {
  mode: CombinerMode
  // Stack mode state
  stackTableIds: string[]
  stackValidation: StackValidation | null
  // Join mode state
  leftTableId: string | null
  rightTableId: string | null
  keyColumn: string | null
  joinType: JoinType
  joinValidation: JoinValidation | null
  // Common state
  resultTableName: string
  isProcessing: boolean
  error: string | null
}

interface CombinerActions {
  setMode: (mode: CombinerMode) => void
  // Stack mode actions
  setStackTableIds: (ids: string[]) => void
  addStackTable: (id: string) => void
  removeStackTable: (id: string) => void
  setStackValidation: (validation: StackValidation | null) => void
  // Join mode actions
  setLeftTableId: (id: string | null) => void
  setRightTableId: (id: string | null) => void
  setKeyColumn: (column: string | null) => void
  setJoinType: (type: JoinType) => void
  setJoinValidation: (validation: JoinValidation | null) => void
  // Common actions
  setResultTableName: (name: string) => void
  setIsProcessing: (processing: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
}

const initialState: CombinerState = {
  mode: 'stack',
  stackTableIds: [],
  stackValidation: null,
  leftTableId: null,
  rightTableId: null,
  keyColumn: null,
  joinType: 'inner',
  joinValidation: null,
  resultTableName: '',
  isProcessing: false,
  error: null,
}

export const useCombinerStore = create<CombinerState & CombinerActions>((set) => ({
  ...initialState,

  setMode: (mode) => set({ mode }),

  // Stack mode actions
  setStackTableIds: (ids) => set({ stackTableIds: ids }),
  addStackTable: (id) =>
    set((state) => ({
      stackTableIds: state.stackTableIds.includes(id)
        ? state.stackTableIds
        : [...state.stackTableIds, id],
    })),
  removeStackTable: (id) =>
    set((state) => ({
      stackTableIds: state.stackTableIds.filter((tid) => tid !== id),
    })),
  setStackValidation: (validation) => set({ stackValidation: validation }),

  // Join mode actions
  setLeftTableId: (id) => set({ leftTableId: id }),
  setRightTableId: (id) => set({ rightTableId: id }),
  setKeyColumn: (column) => set({ keyColumn: column }),
  setJoinType: (type) => set({ joinType: type }),
  setJoinValidation: (validation) => set({ joinValidation: validation }),

  // Common actions
  setResultTableName: (name) => set({ resultTableName: name }),
  setIsProcessing: (processing) => set({ isProcessing: processing }),
  setError: (error) => set({ error }),
  reset: () => set(initialState),
}))
