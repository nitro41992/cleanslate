import { create } from 'zustand'
import type {
  TableTimeline,
  TimelineCommand,
  TimelineCommandType,
  TimelineParams,
  TimelineHighlight,
  CellChange,
  SerializedTableTimeline,
  SerializedTimelineCommand,
} from '@/types'
import { generateId } from '@/lib/utils'
import { EXPENSIVE_TRANSFORMS } from '@/lib/transformations'

/**
 * Check if a command type/params combination is expensive.
 * Uses EXPENSIVE_TRANSFORMS from transformations.ts as single source of truth.
 */
function isExpensiveCommand(commandType: TimelineCommandType, params: TimelineParams): boolean {
  // These operations are always expensive
  if (commandType === 'merge' || commandType === 'join' || commandType === 'stack') {
    return true
  }
  // Check for expensive transformations using the shared constant
  if (commandType === 'transform' && params.type === 'transform') {
    return EXPENSIVE_TRANSFORMS.has(params.transformationType)
  }
  return false
}

interface TimelineState {
  // Per-table timelines: tableId -> TableTimeline
  timelines: Map<string, TableTimeline>
  // Currently active timeline (follows active table)
  activeTimelineId: string | null
  // Highlight state for drill-down view
  highlight: TimelineHighlight
  // Processing state
  isReplaying: boolean
  replayProgress: number
}

interface TimelineActions {
  // Timeline lifecycle
  createTimeline: (tableId: string, tableName: string, originalSnapshotName: string) => string
  getTimeline: (tableId: string) => TableTimeline | undefined
  deleteTimeline: (tableId: string) => void
  setActiveTimeline: (tableId: string | null) => void
  updateTimelineOriginalSnapshot: (tableId: string, originalSnapshotName: string) => void

  // Command recording
  appendCommand: (
    tableId: string,
    commandType: TimelineCommandType,
    label: string,
    params: TimelineParams,
    options?: {
      auditEntryId?: string
      affectedRowIds?: string[]
      affectedColumns?: string[]
      cellChanges?: CellChange[]
      rowsAffected?: number
      hasRowDetails?: boolean
      columnOrderBefore?: string[]
      columnOrderAfter?: string[]
    }
  ) => TimelineCommand

  // Snapshot management
  createSnapshot: (tableId: string, stepIndex: number, snapshotTableName: string) => void
  getSnapshotBefore: (tableId: string, targetIndex: number) => { tableName: string; index: number } | null

  // Undo/Redo (position management - actual replay is in timeline-engine)
  canUndo: (tableId: string) => boolean
  canRedo: (tableId: string) => boolean
  setPosition: (tableId: string, position: number) => void
  getCurrentPosition: (tableId: string) => number
  getCommandCount: (tableId: string) => number

  // Highlight for drill-down
  setHighlightedCommand: (commandId: string | null) => void
  clearHighlight: () => void
  getHighlightForCommand: (tableId: string, commandId: string) => TimelineHighlight | null

  // Replay state
  setIsReplaying: (isReplaying: boolean) => void
  setReplayProgress: (progress: number) => void

  // Persistence
  getSerializedTimelines: () => SerializedTableTimeline[]
  loadTimelines: (timelines: SerializedTableTimeline[]) => void

  // Dirty cell tracking (derived from timeline)
  getDirtyCellsAtPosition: (tableId: string) => Set<string>
}

const initialHighlight: TimelineHighlight = {
  commandId: null,
  rowIds: new Set(),
  cellKeys: new Set(),
  highlightedColumns: new Set(),
  ghostRows: [],
  diffMode: 'cell',
}

export const useTimelineStore = create<TimelineState & TimelineActions>((set, get) => ({
  timelines: new Map(),
  activeTimelineId: null,
  highlight: initialHighlight,
  isReplaying: false,
  replayProgress: 0,

  createTimeline: (tableId, tableName, originalSnapshotName) => {
    const id = generateId()
    const timeline: TableTimeline = {
      id,
      tableId,
      tableName,
      commands: [],
      currentPosition: -1, // -1 means at original state
      snapshots: new Map(),
      originalSnapshotName,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    set((state) => {
      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, timeline)
      return { timelines: newTimelines }
    })

    return id
  },

  getTimeline: (tableId) => {
    return get().timelines.get(tableId)
  },

  deleteTimeline: (tableId) => {
    set((state) => {
      const newTimelines = new Map(state.timelines)
      newTimelines.delete(tableId)
      return {
        timelines: newTimelines,
        activeTimelineId: state.activeTimelineId === tableId ? null : state.activeTimelineId,
      }
    })
  },

  setActiveTimeline: (tableId) => {
    set({ activeTimelineId: tableId })
  },

  updateTimelineOriginalSnapshot: (tableId, originalSnapshotName) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      const updatedTimeline: TableTimeline = {
        ...timeline,
        originalSnapshotName,
        updatedAt: new Date(),
      }

      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, updatedTimeline)

      return { timelines: newTimelines }
    })
  },

  appendCommand: (tableId, commandType, label, params, options = {}) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) {
      throw new Error(`Timeline not found for table ${tableId}`)
    }

    const isExpensive = isExpensiveCommand(commandType, params)

    const command: TimelineCommand = {
      id: generateId(),
      commandType,
      label,
      params,
      timestamp: new Date(),
      isExpensive,
      auditEntryId: options.auditEntryId,
      affectedRowIds: options.affectedRowIds,
      affectedColumns: options.affectedColumns,
      cellChanges: options.cellChanges,
      rowsAffected: options.rowsAffected,
      hasRowDetails: options.hasRowDetails,
      columnOrderBefore: options.columnOrderBefore,
      columnOrderAfter: options.columnOrderAfter,
    }

    set((state) => {
      const existingTimeline = state.timelines.get(tableId)
      if (!existingTimeline) return state

      // If we're not at the end, truncate future commands (branching not supported)
      const currentPos = existingTimeline.currentPosition
      const commands = existingTimeline.commands.slice(0, currentPos + 1)

      // Also remove snapshots that are after the truncation point
      const snapshots = new Map(existingTimeline.snapshots)
      for (const [idx] of snapshots) {
        if (idx > currentPos) {
          snapshots.delete(idx)
        }
      }

      // Add new command
      commands.push(command)

      const updatedTimeline: TableTimeline = {
        ...existingTimeline,
        commands,
        currentPosition: commands.length - 1,
        snapshots,
        updatedAt: new Date(),
      }

      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, updatedTimeline)

      return { timelines: newTimelines }
    })

    return command
  },

  createSnapshot: (tableId, stepIndex, snapshotTableName) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      const snapshots = new Map(timeline.snapshots)
      snapshots.set(stepIndex, snapshotTableName)

      const updatedTimeline: TableTimeline = {
        ...timeline,
        snapshots,
        updatedAt: new Date(),
      }

      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, updatedTimeline)

      return { timelines: newTimelines }
    })
  },

  getSnapshotBefore: (tableId, targetIndex) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return null

    // Find the largest snapshot index that is <= targetIndex
    const snapshotIndices = [...timeline.snapshots.keys()].sort((a, b) => b - a)
    for (const idx of snapshotIndices) {
      if (idx <= targetIndex) {
        return {
          tableName: timeline.snapshots.get(idx)!,
          index: idx,
        }
      }
    }

    // No snapshot found, use original
    return {
      tableName: timeline.originalSnapshotName,
      index: -1,
    }
  },

  canUndo: (tableId) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return false
    return timeline.currentPosition >= 0
  },

  canRedo: (tableId) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return false
    return timeline.currentPosition < timeline.commands.length - 1
  },

  setPosition: (tableId, position) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      // Clamp position to valid range
      const clampedPosition = Math.max(-1, Math.min(position, timeline.commands.length - 1))

      const updatedTimeline: TableTimeline = {
        ...timeline,
        currentPosition: clampedPosition,
        updatedAt: new Date(),
      }

      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, updatedTimeline)

      return { timelines: newTimelines }
    })
  },

  getCurrentPosition: (tableId) => {
    const timeline = get().timelines.get(tableId)
    return timeline?.currentPosition ?? -1
  },

  getCommandCount: (tableId) => {
    const timeline = get().timelines.get(tableId)
    return timeline?.commands.length ?? 0
  },

  setHighlightedCommand: (commandId) => {
    if (!commandId) {
      set({ highlight: initialHighlight })
      return
    }

    // Find the command and build highlight state
    const state = get()
    for (const timeline of state.timelines.values()) {
      const command = timeline.commands.find((c) => c.id === commandId)
      if (command) {
        // Determine diff mode based on command type
        let diffMode: TimelineHighlight['diffMode'] = 'row'
        if (command.commandType === 'manual_edit' || command.commandType === 'batch_edit') {
          diffMode = 'cell'
        } else if (command.commandType === 'transform' || command.commandType === 'standardize') {
          // Transform and standardize operations highlight the affected column
          // This check comes before isExpensive so that transforms with affectedColumns
          // (like combine_columns, split_column) highlight specific columns, not the full grid
          if (command.affectedColumns?.length) {
            diffMode = 'column'
          } else if (command.isExpensive) {
            diffMode = 'full'
          } else {
            diffMode = 'column'
          }
        } else if (command.isExpensive) {
          diffMode = 'full'
        } else if (command.affectedColumns?.length && !command.affectedRowIds?.length) {
          // Fallback: if we have columns but no specific rows, highlight the column
          diffMode = 'column'
        }

        const highlight: TimelineHighlight = {
          commandId,
          rowIds: new Set(command.affectedRowIds || []),
          cellKeys: new Set(),
          highlightedColumns: new Set(command.affectedColumns || []),
          ghostRows: [],
          diffMode,
        }

        // Build cell keys from cell changes
        if (command.cellChanges) {
          for (const change of command.cellChanges) {
            highlight.cellKeys.add(`${change.csId}:${change.columnName}`)
          }
        }

        // If single manual edit, add cell key
        if (command.commandType === 'manual_edit' && command.params.type === 'manual_edit') {
          highlight.cellKeys.add(`${command.params.csId}:${command.params.columnName}`)
          highlight.rowIds.add(command.params.csId)
        }

        set({ highlight })
        return
      }
    }

    // Command not found
    set({ highlight: initialHighlight })
  },

  clearHighlight: () => {
    set({ highlight: initialHighlight })
  },

  getHighlightForCommand: (tableId, commandId) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return null

    const command = timeline.commands.find((c) => c.id === commandId)
    if (!command) return null

    // Determine diff mode based on command type
    let diffMode: TimelineHighlight['diffMode'] = 'cell'
    if (command.commandType === 'manual_edit' || command.commandType === 'batch_edit') {
      diffMode = 'cell'
    } else if (command.commandType === 'transform' || command.commandType === 'standardize') {
      // Transform and standardize operations highlight the affected column
      // This check comes before isExpensive so that transforms with affectedColumns
      // (like combine_columns, split_column) highlight specific columns, not the full grid
      if (command.affectedColumns?.length) {
        diffMode = 'column'
      } else if (command.isExpensive) {
        diffMode = 'full'
      } else {
        diffMode = 'column'
      }
    } else if (command.isExpensive) {
      diffMode = 'full'
    } else if (command.affectedColumns?.length && !command.affectedRowIds?.length) {
      // Fallback: if we have columns but no specific rows, highlight the column
      diffMode = 'column'
    }

    return {
      commandId,
      rowIds: new Set(command.affectedRowIds || []),
      cellKeys: new Set(
        command.cellChanges?.map((c) => `${c.csId}:${c.columnName}`) || []
      ),
      highlightedColumns: new Set(command.affectedColumns || []),
      ghostRows: [],
      diffMode,
    }
  },

  setIsReplaying: (isReplaying) => {
    set({ isReplaying })
  },

  setReplayProgress: (progress) => {
    set({ replayProgress: progress })
  },

  getSerializedTimelines: () => {
    const timelines = get().timelines
    const serialized: SerializedTableTimeline[] = []

    for (const timeline of timelines.values()) {
      const serializedCommands: SerializedTimelineCommand[] = timeline.commands.map((cmd) => ({
        id: cmd.id,
        commandType: cmd.commandType,
        label: cmd.label,
        params: cmd.params,
        timestamp: cmd.timestamp.toISOString(),
        isExpensive: cmd.isExpensive,
        auditEntryId: cmd.auditEntryId,
        affectedRowIds: cmd.affectedRowIds,
        affectedColumns: cmd.affectedColumns,
        cellChanges: cmd.cellChanges,
        rowsAffected: cmd.rowsAffected,
        hasRowDetails: cmd.hasRowDetails,
        columnOrderBefore: cmd.columnOrderBefore,
        columnOrderAfter: cmd.columnOrderAfter,
      }))

      serialized.push({
        id: timeline.id,
        tableId: timeline.tableId,
        tableName: timeline.tableName,
        commands: serializedCommands,
        currentPosition: timeline.currentPosition,
        snapshots: [...timeline.snapshots.entries()],
        originalSnapshotName: timeline.originalSnapshotName,
        createdAt: timeline.createdAt.toISOString(),
        updatedAt: timeline.updatedAt.toISOString(),
      })
    }

    return serialized
  },

  loadTimelines: (serializedTimelines) => {
    const timelines = new Map<string, TableTimeline>()

    for (const st of serializedTimelines) {
      const commands: TimelineCommand[] = st.commands.map((cmd) => ({
        id: cmd.id,
        commandType: cmd.commandType,
        label: cmd.label,
        params: cmd.params,
        timestamp: new Date(cmd.timestamp),
        isExpensive: cmd.isExpensive,
        auditEntryId: cmd.auditEntryId,
        affectedRowIds: cmd.affectedRowIds,
        affectedColumns: cmd.affectedColumns,
        cellChanges: cmd.cellChanges,
        rowsAffected: cmd.rowsAffected,
        hasRowDetails: cmd.hasRowDetails,
        columnOrderBefore: cmd.columnOrderBefore,
        columnOrderAfter: cmd.columnOrderAfter,
      }))

      const timeline: TableTimeline = {
        id: st.id,
        tableId: st.tableId,
        tableName: st.tableName,
        commands,
        currentPosition: st.currentPosition,
        snapshots: new Map(st.snapshots),
        originalSnapshotName: st.originalSnapshotName,
        createdAt: new Date(st.createdAt),
        updatedAt: new Date(st.updatedAt),
      }

      timelines.set(st.tableId, timeline)
    }

    set({ timelines })
  },

  getDirtyCellsAtPosition: (tableId) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return new Set()

    const dirtyCells = new Set<string>()
    // Only consider commands up to currentPosition (inclusive)
    // Commands after currentPosition are "undone" and shouldn't show as dirty
    for (let i = 0; i <= timeline.currentPosition && i < timeline.commands.length; i++) {
      const cmd = timeline.commands[i]
      // Track cells modified by manual_edit or batch_edit commands
      if (cmd.cellChanges) {
        for (const change of cmd.cellChanges) {
          dirtyCells.add(`${change.csId}:${change.columnName}`)
        }
      }
      // Also handle single manual_edit without cellChanges array
      if (cmd.commandType === 'manual_edit' && cmd.params.type === 'manual_edit') {
        dirtyCells.add(`${cmd.params.csId}:${cmd.params.columnName}`)
      }
    }
    return dirtyCells
  },
}))

/**
 * Helper hook for accessing the active timeline
 */
export function useActiveTimeline() {
  return useTimelineStore((state) => {
    const { activeTimelineId, timelines } = state
    if (!activeTimelineId) return null
    return timelines.get(activeTimelineId) ?? null
  })
}

/**
 * Helper hook for checking undo/redo availability
 */
export function useTimelineNavigation(tableId: string | null) {
  return useTimelineStore((state) => {
    if (!tableId) {
      return { canUndo: false, canRedo: false, position: -1, total: 0 }
    }
    const timeline = state.timelines.get(tableId)
    if (!timeline) {
      return { canUndo: false, canRedo: false, position: -1, total: 0 }
    }
    return {
      canUndo: timeline.currentPosition >= 0,
      canRedo: timeline.currentPosition < timeline.commands.length - 1,
      position: timeline.currentPosition,
      total: timeline.commands.length,
    }
  })
}

// Persistence: Auto-save state on timeline changes
// Import dynamically to avoid circular dependencies
let isRestoringState = false

export function setRestoringState(restoring: boolean) {
  isRestoringState = restoring
}

if (typeof window !== 'undefined') {
  import('@/lib/persistence/debounce').then(({ DebouncedSave }) => {
    const debouncedSave = new DebouncedSave(500)

    useTimelineStore.subscribe((state) => {
      // Skip save during state restoration to avoid write cycles
      if (isRestoringState) return

      // Trigger debounced save
      debouncedSave.trigger(async () => {
        const { saveAppState } = await import('@/lib/persistence/state-persistence')
        const { useTableStore } = await import('@/stores/tableStore')
        const { useUIStore } = await import('@/stores/uiStore')

        const tableState = useTableStore.getState()
        const uiState = useUIStore.getState()

        await saveAppState(
          tableState.tables,
          tableState.activeTableId,
          state.getSerializedTimelines(),
          uiState.sidebarCollapsed
        )
      })
    })
  })
}
