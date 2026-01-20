import { create } from 'zustand'

export interface CellEdit {
  tableId: string
  tableName: string
  rowIndex: number
  columnName: string
  previousValue: unknown
  newValue: unknown
  timestamp: Date
}

interface EditState {
  // Track dirty cells: key format is "tableId:rowIndex:columnName"
  dirtyCells: Map<string, boolean>
  // Undo stack (limited to 10 entries)
  undoStack: CellEdit[]
  // Redo stack (limited to 10 entries)
  redoStack: CellEdit[]
}

interface EditActions {
  recordEdit: (edit: CellEdit) => void
  undo: () => CellEdit | undefined
  redo: () => CellEdit | undefined
  isDirty: (tableId: string, rowIndex: number, columnName: string) => boolean
  clearEdits: (tableId?: string) => void
  canUndo: () => boolean
  canRedo: () => boolean
}

const MAX_UNDO_STACK_SIZE = 10

function getCellKey(tableId: string, rowIndex: number, columnName: string): string {
  return `${tableId}:${rowIndex}:${columnName}`
}

export const useEditStore = create<EditState & EditActions>((set, get) => ({
  dirtyCells: new Map(),
  undoStack: [],
  redoStack: [],

  recordEdit: (edit) => {
    const key = getCellKey(edit.tableId, edit.rowIndex, edit.columnName)

    set((state) => {
      const newDirtyCells = new Map(state.dirtyCells)
      newDirtyCells.set(key, true)

      // Add to undo stack, limit to MAX_UNDO_STACK_SIZE
      const newUndoStack = [edit, ...state.undoStack].slice(0, MAX_UNDO_STACK_SIZE)

      return {
        dirtyCells: newDirtyCells,
        undoStack: newUndoStack,
        // Clear redo stack when new edit is made
        redoStack: [],
      }
    })
  },

  undo: () => {
    const state = get()
    if (state.undoStack.length === 0) return undefined

    const [edit, ...remainingUndo] = state.undoStack
    const key = getCellKey(edit.tableId, edit.rowIndex, edit.columnName)

    set((state) => {
      const newDirtyCells = new Map(state.dirtyCells)
      // Remove from dirty cells when undoing
      newDirtyCells.delete(key)

      return {
        dirtyCells: newDirtyCells,
        undoStack: remainingUndo,
        // Add to redo stack
        redoStack: [edit, ...state.redoStack].slice(0, MAX_UNDO_STACK_SIZE),
      }
    })

    return edit
  },

  redo: () => {
    const state = get()
    if (state.redoStack.length === 0) return undefined

    const [edit, ...remainingRedo] = state.redoStack
    const key = getCellKey(edit.tableId, edit.rowIndex, edit.columnName)

    set((state) => {
      const newDirtyCells = new Map(state.dirtyCells)
      // Add back to dirty cells when redoing
      newDirtyCells.set(key, true)

      return {
        dirtyCells: newDirtyCells,
        redoStack: remainingRedo,
        // Add back to undo stack
        undoStack: [edit, ...state.undoStack].slice(0, MAX_UNDO_STACK_SIZE),
      }
    })

    return edit
  },

  isDirty: (tableId, rowIndex, columnName) => {
    const key = getCellKey(tableId, rowIndex, columnName)
    return get().dirtyCells.has(key)
  },

  clearEdits: (tableId) => {
    set((state) => {
      if (tableId) {
        // Clear only edits for specific table
        const newDirtyCells = new Map(state.dirtyCells)
        const newUndoStack = state.undoStack.filter((e) => e.tableId !== tableId)
        const newRedoStack = state.redoStack.filter((e) => e.tableId !== tableId)

        for (const key of newDirtyCells.keys()) {
          if (key.startsWith(`${tableId}:`)) {
            newDirtyCells.delete(key)
          }
        }

        return {
          dirtyCells: newDirtyCells,
          undoStack: newUndoStack,
          redoStack: newRedoStack,
        }
      }

      // Clear all
      return {
        dirtyCells: new Map(),
        undoStack: [],
        redoStack: [],
      }
    })
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
}))
