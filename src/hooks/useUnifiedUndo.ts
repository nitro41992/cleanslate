/**
 * useUnifiedUndo - Unified undo/redo hook
 *
 * This hook provides a single entry point for undo/redo operations,
 * delegating to the Timeline Engine for the actual work.
 *
 * Benefits:
 * - Single source of truth for undo/redo state
 * - Automatically handles both CommandExecutor and legacy timeline systems
 * - Provides human-readable labels for UI
 * - Simplifies component code
 */

import { useCallback, useMemo } from 'react'
import { useTimelineStore } from '@/stores/timelineStore'
import { useTableStore } from '@/stores/tableStore'
import { useAuditStore } from '@/stores/auditStore'
import { useUIStore } from '@/stores/uiStore'
import { undoTimeline, redoTimeline } from '@/lib/timeline-engine'
import { usePersistence } from '@/hooks/usePersistence'

export interface UnifiedUndoResult {
  /** Whether undo is available */
  canUndo: boolean
  /** Whether redo is available */
  canRedo: boolean
  /** Execute undo operation */
  undo: () => Promise<void>
  /** Execute redo operation */
  redo: () => Promise<void>
  /** Human-readable label for undo action, e.g., "Undo: Trim Whitespace" */
  undoLabel: string | null
  /** Human-readable label for redo action */
  redoLabel: string | null
  /** Whether a replay operation is in progress */
  isReplaying: boolean
  /** Current position in timeline */
  position: number
  /** Total number of commands in timeline */
  total: number
}

/**
 * Unified undo/redo hook that provides a single entry point for all undo/redo operations.
 *
 * @param tableId - The table ID to operate on, or null if no table is active
 * @returns UnifiedUndoResult with canUndo, canRedo, undo(), redo(), and labels
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { canUndo, canRedo, undo, redo, undoLabel } = useUnifiedUndo(tableId)
 *
 *   return (
 *     <>
 *       <Button onClick={undo} disabled={!canUndo}>
 *         {undoLabel || 'Undo'}
 *       </Button>
 *       <Button onClick={redo} disabled={!canRedo}>Redo</Button>
 *     </>
 *   )
 * }
 * ```
 */
export function useUnifiedUndo(tableId: string | null): UnifiedUndoResult {
  // Get timeline state
  const timeline = useTimelineStore((s) => (tableId ? s.getTimeline(tableId) : null))
  const isReplaying = useTimelineStore((s) => s.isReplaying)

  // Get table info for audit logging
  const tables = useTableStore((s) => s.tables)
  const activeTable = useMemo(
    () => tables.find((t) => t.id === tableId),
    [tables, tableId]
  )

  // Store actions
  const updateTable = useTableStore((s) => s.updateTable)
  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const refreshMemory = useUIStore((s) => s.refreshMemory)
  const markTableDirty = useUIStore((s) => s.markTableDirty)

  // Persistence - for immediate save after undo/redo
  const { saveTable } = usePersistence()

  // Compute canUndo/canRedo from timeline
  const canUndo = useMemo(() => {
    if (!timeline || isReplaying) return false
    return timeline.currentPosition >= 0
  }, [timeline, isReplaying])

  const canRedo = useMemo(() => {
    if (!timeline || isReplaying) return false
    return timeline.currentPosition < timeline.commands.length - 1
  }, [timeline, isReplaying])

  // Get human-readable labels
  const undoLabel = useMemo(() => {
    if (!timeline || timeline.currentPosition < 0) return null
    const command = timeline.commands[timeline.currentPosition]
    return command ? `Undo: ${command.label}` : null
  }, [timeline])

  const redoLabel = useMemo(() => {
    if (!timeline || timeline.currentPosition >= timeline.commands.length - 1) return null
    const command = timeline.commands[timeline.currentPosition + 1]
    return command ? `Redo: ${command.label}` : null
  }, [timeline])

  // Position and total for UI display
  const position = timeline?.currentPosition ?? -1
  const total = timeline?.commands.length ?? 0

  // Undo handler - delegates to Timeline Engine
  const undo = useCallback(async () => {
    if (!tableId || !canUndo || isReplaying) return

    console.log('[useUnifiedUndo] Executing undo', { tableId, position })

    // Mark table dirty immediately (undo changes data)
    markTableDirty(tableId)

    try {
      const result = await undoTimeline(tableId)

      if (result) {
        // Update table store with new state
        updateTable(tableId, {
          rowCount: result.rowCount,
          columns: result.columns,
          columnOrder: result.columnOrder,
        })

        // Record audit entry
        if (activeTable) {
          addAuditEntry(
            tableId,
            activeTable.name,
            'Undo',
            'Reverted to previous state',
            'A'
          )
        }

        console.log('[useUnifiedUndo] Undo completed', {
          rowCount: result.rowCount,
          columnCount: result.columns.length,
        })

        // Immediately save snapshot (bypass debounce)
        if (activeTable) {
          saveTable(activeTable.name).catch((err) =>
            console.error('[useUnifiedUndo] Failed to save after undo:', err)
          )
        }
      }

      // Refresh memory display
      refreshMemory()
    } catch (error) {
      console.error('[useUnifiedUndo] Undo failed:', error)
    }
  }, [tableId, canUndo, isReplaying, updateTable, addAuditEntry, activeTable, refreshMemory, saveTable, markTableDirty])

  // Redo handler - delegates to Timeline Engine
  const redo = useCallback(async () => {
    if (!tableId || !canRedo || isReplaying) return

    console.log('[useUnifiedUndo] Executing redo', { tableId, position })

    // Mark table dirty immediately (redo changes data)
    markTableDirty(tableId)

    try {
      const result = await redoTimeline(tableId)

      if (result) {
        // Update table store with new state
        updateTable(tableId, {
          rowCount: result.rowCount,
          columns: result.columns,
          columnOrder: result.columnOrder,
        })

        // Record audit entry
        if (activeTable) {
          addAuditEntry(
            tableId,
            activeTable.name,
            'Redo',
            'Reapplied next state',
            'A'
          )
        }

        console.log('[useUnifiedUndo] Redo completed', {
          rowCount: result.rowCount,
          columnCount: result.columns.length,
        })

        // Immediately save snapshot (bypass debounce)
        if (activeTable) {
          saveTable(activeTable.name).catch((err) =>
            console.error('[useUnifiedUndo] Failed to save after redo:', err)
          )
        }
      }

      // Refresh memory display
      refreshMemory()
    } catch (error) {
      console.error('[useUnifiedUndo] Redo failed:', error)
    }
  }, [tableId, canRedo, isReplaying, updateTable, addAuditEntry, activeTable, refreshMemory, saveTable, markTableDirty])

  return {
    canUndo,
    canRedo,
    undo,
    redo,
    undoLabel,
    redoLabel,
    isReplaying,
    position,
    total,
  }
}
