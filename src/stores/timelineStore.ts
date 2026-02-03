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
  SnapshotInfo,
} from '@/types'
import { generateId } from '@/lib/utils'
import { EXPENSIVE_TRANSFORMS } from '@/lib/transformations'
import { registerMemoryCleanup } from '@/lib/memory-manager'

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
  createSnapshot: (tableId: string, stepIndex: number, snapshotTableName: string, options?: { hotTableName?: string }) => void
  getSnapshotBefore: (tableId: string, targetIndex: number) => { tableName: string; index: number } | null

  // Hot snapshot management (LRU undo cache - Phase 3)
  setHotSnapshot: (tableId: string, stepIndex: number, hotTableName: string) => void
  clearHotSnapshot: (tableId: string, stepIndex: number) => void
  getSnapshotInfo: (tableId: string, stepIndex: number) => SnapshotInfo | null
  isSnapshotHot: (tableId: string, stepIndex: number) => boolean

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

  // Memory management
  /**
   * Prune timeline to reduce memory usage.
   * - Removes commands beyond keepCount from current position
   * - Clears large arrays (affectedRowIds, cellChanges) from old commands
   * @param tableId - Table to prune timeline for
   * @param keepCount - Number of commands to keep before current position
   */
  pruneTimeline: (tableId: string, keepCount: number) => void

  // Dirty cell tracking (derived from timeline)
  getDirtyCellsAtPosition: (tableId: string) => Set<string>

  // Inserted row tracking (derived from timeline)
  getInsertedRowCsIdsAtPosition: (tableId: string) => Set<string>

  // Adjust csId references when rows are inserted/deleted
  // This keeps timeline references in sync with database _cs_id values
  adjustCsIdsForRowInsertion: (tableId: string, insertedAtCsId: number) => void
  adjustCsIdsForRowDeletion: (tableId: string, deletedCsId: number) => void
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
      console.error('[TimelineStore] Timeline not found for table:', tableId)
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

  createSnapshot: (tableId, stepIndex, snapshotTableName, options = {}) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      const snapshots = new Map(timeline.snapshots)
      const snapshotInfo: SnapshotInfo = {
        parquetId: snapshotTableName,
        hotTableName: options.hotTableName,
      }
      snapshots.set(stepIndex, snapshotInfo)

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
        const snapshotInfo = timeline.snapshots.get(idx)!
        return {
          tableName: snapshotInfo.parquetId,
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

  // Hot snapshot management (LRU undo cache - Phase 3)
  setHotSnapshot: (tableId, stepIndex, hotTableName) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      const snapshotInfo = timeline.snapshots.get(stepIndex)
      if (!snapshotInfo) return state

      const snapshots = new Map(timeline.snapshots)
      snapshots.set(stepIndex, {
        ...snapshotInfo,
        hotTableName,
      })

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

  clearHotSnapshot: (tableId, stepIndex) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      const snapshotInfo = timeline.snapshots.get(stepIndex)
      if (!snapshotInfo || !snapshotInfo.hotTableName) return state

      const snapshots = new Map(timeline.snapshots)
      snapshots.set(stepIndex, {
        parquetId: snapshotInfo.parquetId,
        // hotTableName intentionally omitted to clear it
      })

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

  getSnapshotInfo: (tableId, stepIndex) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return null
    return timeline.snapshots.get(stepIndex) ?? null
  },

  isSnapshotHot: (tableId, stepIndex) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return false
    const snapshotInfo = timeline.snapshots.get(stepIndex)
    return !!snapshotInfo?.hotTableName
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

      // Serialize snapshots - only persist parquetId, not hotTableName (hot snapshots don't survive refresh)
      const serializedSnapshots: [number, { parquetId: string }][] = [...timeline.snapshots.entries()].map(
        ([idx, info]) => [idx, { parquetId: info.parquetId }]
      )

      serialized.push({
        id: timeline.id,
        tableId: timeline.tableId,
        tableName: timeline.tableName,
        commands: serializedCommands,
        currentPosition: timeline.currentPosition,
        snapshots: serializedSnapshots,
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

      // Deserialize snapshots - handle both old format (string) and new format (SnapshotInfo)
      // Old format: [number, string][] - from before LRU cache implementation
      // New format: [number, { parquetId: string }][] - LRU cache format
      const deserializedSnapshots = new Map<number, SnapshotInfo>()
      for (const [idx, snapshot] of st.snapshots) {
        if (typeof snapshot === 'string') {
          // Old format - convert to new SnapshotInfo
          deserializedSnapshots.set(idx, { parquetId: snapshot })
        } else {
          // New format - use as-is (hotTableName will be undefined after page refresh)
          deserializedSnapshots.set(idx, { parquetId: snapshot.parquetId })
        }
      }

      const timeline: TableTimeline = {
        id: st.id,
        tableId: st.tableId,
        tableName: st.tableName,
        commands,
        currentPosition: st.currentPosition,
        snapshots: deserializedSnapshots,
        originalSnapshotName: st.originalSnapshotName,
        createdAt: new Date(st.createdAt),
        updatedAt: new Date(st.updatedAt),
      }

      timelines.set(st.tableId, timeline)
    }

    set({ timelines })
  },

  pruneTimeline: (tableId, keepCount) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline || timeline.commands.length === 0) return state

      const currentPos = timeline.currentPosition
      const commands = [...timeline.commands]

      // Use the smaller of keepCount and CLEAR_THRESHOLD for array clearing
      // CLEAR_THRESHOLD ensures we keep arrays for recent commands for highlighting
      const CLEAR_THRESHOLD = Math.min(keepCount, 5)
      for (let i = 0; i < commands.length; i++) {
        const isRecent = i >= currentPos - CLEAR_THRESHOLD && i <= currentPos
        if (!isRecent) {
          // Store the count for display, then clear the array
          const cmd = commands[i]
          if (cmd.affectedRowIds && cmd.affectedRowIds.length > 0) {
            // Preserve rowsAffected count if not already set
            if (cmd.rowsAffected === undefined) {
              commands[i] = {
                ...cmd,
                rowsAffected: cmd.affectedRowIds.length,
                affectedRowIds: undefined, // Clear the array
              }
            } else {
              commands[i] = {
                ...cmd,
                affectedRowIds: undefined,
              }
            }
          }
          // Clear cellChanges for old commands
          if (cmd.cellChanges && cmd.cellChanges.length > 0 && !isRecent) {
            commands[i] = {
              ...commands[i],
              cellChanges: undefined,
            }
          }
        }
      }

      // Remove orphaned future commands (beyond currentPosition)
      // These become unreachable after any new action
      const prunedCommands = commands.slice(0, currentPos + 1)

      // Remove orphaned snapshots
      const snapshots = new Map(timeline.snapshots)
      for (const [idx] of snapshots) {
        if (idx > currentPos) {
          snapshots.delete(idx)
        }
      }

      const updatedTimeline: TableTimeline = {
        ...timeline,
        commands: prunedCommands,
        snapshots,
        updatedAt: new Date(),
      }

      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, updatedTimeline)

      console.log(`[TimelineStore] Pruned timeline for ${tableId}: ${commands.length} -> ${prunedCommands.length} commands`)

      return { timelines: newTimelines }
    })
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

  getInsertedRowCsIdsAtPosition: (tableId) => {
    const timeline = get().timelines.get(tableId)
    if (!timeline) return new Set()

    const insertedCsIds = new Set<string>()
    // Only consider commands up to currentPosition (inclusive)
    // Commands after currentPosition are "undone" and shouldn't show as inserted
    for (let i = 0; i <= timeline.currentPosition && i < timeline.commands.length; i++) {
      const cmd = timeline.commands[i]
      // Track rows inserted by data:insert_row commands
      if (cmd.params.type === 'data' && cmd.params.dataOperation === 'insert_row' && cmd.params.newCsId) {
        insertedCsIds.add(cmd.params.newCsId)
      }
    }
    return insertedCsIds
  },

  adjustCsIdsForRowInsertion: (tableId, insertedAtCsId) => {
    set((state) => {
      const timeline = state.timelines.get(tableId)
      if (!timeline) return state

      // Helper to adjust a csId string if it's >= the insertion point
      const adjustCsId = (csId: string): string => {
        const num = parseInt(csId, 10)
        if (isNaN(num)) return csId
        // All existing rows with csId >= insertedAtCsId have shifted down by 1
        return num >= insertedAtCsId ? String(num + 1) : csId
      }

      // Create updated commands with adjusted csId references
      const updatedCommands = timeline.commands.map((cmd) => {
        let updated = { ...cmd }
        let needsUpdate = false

        // Adjust cellChanges
        if (cmd.cellChanges && cmd.cellChanges.length > 0) {
          const newCellChanges = cmd.cellChanges.map((change) => {
            const newCsId = adjustCsId(change.csId)
            if (newCsId !== change.csId) needsUpdate = true
            return newCsId !== change.csId ? { ...change, csId: newCsId } : change
          })
          if (needsUpdate) updated = { ...updated, cellChanges: newCellChanges }
        }

        // Adjust affectedRowIds
        if (cmd.affectedRowIds && cmd.affectedRowIds.length > 0) {
          const newAffectedRowIds = cmd.affectedRowIds.map(adjustCsId)
          if (newAffectedRowIds.some((id, i) => id !== cmd.affectedRowIds![i])) {
            needsUpdate = true
            updated = { ...updated, affectedRowIds: newAffectedRowIds }
          }
        }

        // Adjust params based on type
        if (cmd.params.type === 'manual_edit') {
          const newCsId = adjustCsId(cmd.params.csId)
          if (newCsId !== cmd.params.csId) {
            needsUpdate = true
            updated = { ...updated, params: { ...cmd.params, csId: newCsId } }
          }
        } else if (cmd.params.type === 'batch_edit') {
          const batchParams = cmd.params as import('@/types').BatchEditParams
          if (batchParams.changes && batchParams.changes.length > 0) {
            const newChanges = batchParams.changes.map((change) => {
              const newCsId = adjustCsId(change.csId)
              return newCsId !== change.csId ? { ...change, csId: newCsId } : change
            })
            if (newChanges.some((c, i) => c !== batchParams.changes[i])) {
              needsUpdate = true
              updated = { ...updated, params: { ...batchParams, changes: newChanges } }
            }
          }
        } else if (cmd.params.type === 'data' && cmd.params.dataOperation === 'insert_row' && cmd.params.newCsId) {
          // Adjust previously inserted rows' csIds (they shifted too)
          const newCsId = adjustCsId(cmd.params.newCsId)
          if (newCsId !== cmd.params.newCsId) {
            needsUpdate = true
            updated = { ...updated, params: { ...cmd.params, newCsId } }
          }
        }

        return needsUpdate ? updated : cmd
      })

      const updatedTimeline: TableTimeline = {
        ...timeline,
        commands: updatedCommands,
        updatedAt: new Date(),
      }

      const newTimelines = new Map(state.timelines)
      newTimelines.set(tableId, updatedTimeline)

      return { timelines: newTimelines }
    })
  },

  adjustCsIdsForRowDeletion: (_tableId, _deletedCsId) => {
    // No-op: delete_row doesn't renumber remaining rows.
    // The _cs_id values stay the same, just with gaps.
    // Timeline references to the deleted row will simply not match any existing row,
    // which is correct behavior (dirty indicator disappears when row is deleted).
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
        const { useRecipeStore } = await import('@/stores/recipeStore')

        const tableState = useTableStore.getState()
        const uiState = useUIStore.getState()
        const recipeState = useRecipeStore.getState()

        await saveAppState(
          tableState.tables,
          tableState.activeTableId,
          state.getSerializedTimelines(),
          uiState.sidebarCollapsed,
          uiState.lastEdit,
          recipeState.recipes
        )
      })
    })
  })

  // Register timeline cleanup for memory pressure situations
  // Prunes all timelines to last 20 commands when memory is critical
  registerMemoryCleanup('timeline-store', () => {
    const state = useTimelineStore.getState()
    for (const [tableId] of state.timelines) {
      state.pruneTimeline(tableId, 20)
    }
    console.log('[TimelineStore] Pruned all timelines for memory cleanup')
  })
}
