/**
 * @deprecated This store is being phased out.
 *
 * Dirty cell tracking is now derived from timelineStore via getDirtyCellsAtPosition()
 * and CommandExecutor via executor.getDirtyCells().
 *
 * This store is kept only for backward compatibility during migration.
 * All undo/redo functionality has been moved to the Timeline Engine via useUnifiedUndo hook.
 *
 * New cell edits should use CommandExecutor:
 * ```typescript
 * import { createCommand, getCommandExecutor } from '@/lib/commands'
 *
 * const command = createCommand('edit:cell', {
 *   tableId, tableName, csId, columnName, previousValue, newValue
 * })
 * await getCommandExecutor().execute(command)
 * ```
 */
import { create } from 'zustand'

/**
 * @deprecated Use CommandExecutor for cell edits instead
 */
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
  /**
   * Track dirty cells: key format is "tableId:rowIndex:columnName"
   * @deprecated Use timelineStore.getDirtyCellsAtPosition() or executor.getDirtyCells() instead
   */
  dirtyCells: Map<string, boolean>
}

interface EditActions {
  /**
   * @deprecated Use CommandExecutor.execute() with edit:cell command instead
   */
  recordEdit: (edit: CellEdit) => void
  /**
   * @deprecated Use timelineStore.getDirtyCellsAtPosition() instead
   */
  isDirty: (tableId: string, rowIndex: number, columnName: string) => boolean
  /**
   * Clear edits for a specific table or all tables
   */
  clearEdits: (tableId?: string) => void
}

function getCellKey(tableId: string, rowIndex: number, columnName: string): string {
  return `${tableId}:${rowIndex}:${columnName}`
}

export const useEditStore = create<EditState & EditActions>((set, get) => ({
  dirtyCells: new Map(),

  recordEdit: (edit) => {
    const key = getCellKey(edit.tableId, edit.rowIndex, edit.columnName)

    set((state) => {
      const newDirtyCells = new Map(state.dirtyCells)
      newDirtyCells.set(key, true)
      return { dirtyCells: newDirtyCells }
    })
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

        for (const key of newDirtyCells.keys()) {
          if (key.startsWith(`${tableId}:`)) {
            newDirtyCells.delete(key)
          }
        }

        return { dirtyCells: newDirtyCells }
      }

      // Clear all
      return { dirtyCells: new Map() }
    })
  },
}))
