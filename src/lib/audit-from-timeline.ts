/**
 * Audit Log Derived from Timeline
 *
 * This module provides functions to derive audit log entries from the timeline.
 * Instead of maintaining a separate audit log that can drift from the timeline,
 * audit entries are computed as a projection of the timeline state.
 *
 * Benefits:
 * - Undo/redo automatically updates the audit view (no drift)
 * - Branching history (undo + new action) automatically truncates old future
 * - Single source of truth for data history
 */

import type { AuditLogEntry, TimelineCommand, TableTimeline, ManualEditParams } from '@/types'
import { useTimelineStore } from '@/stores/timelineStore'

/**
 * Convert a TimelineCommand to an AuditLogEntry
 */
export function convertCommandToAuditEntry(
  timeline: TableTimeline,
  command: TimelineCommand,
  _index: number
): AuditLogEntry {
  const isManualEdit = command.params.type === 'manual_edit'

  // For manual edits, extract the previous/new values from params
  let previousValue: unknown
  let newValue: unknown
  let rowIndex: number | undefined
  let columnName: string | undefined

  if (isManualEdit) {
    const params = command.params as ManualEditParams
    previousValue = params.previousValue
    newValue = params.newValue
    columnName = params.columnName
    // Note: ManualEditParams uses csId, not rowIndex
    // We don't have rowIndex in the new system, but we can indicate the cell
  }

  // Also check cellChanges for batch edits or legacy format
  if (command.cellChanges && command.cellChanges.length > 0) {
    const firstChange = command.cellChanges[0]
    previousValue = previousValue ?? firstChange.previousValue
    newValue = newValue ?? firstChange.newValue
    columnName = columnName ?? firstChange.columnName
  }

  return {
    id: command.id,
    timestamp: command.timestamp,
    tableId: timeline.tableId,
    tableName: timeline.tableName,
    action: command.label,
    details: buildDetails(command),
    entryType: isManualEdit ? 'B' : 'A',
    rowsAffected: command.rowsAffected,
    hasRowDetails: command.hasRowDetails,
    auditEntryId: command.auditEntryId || command.id,
    // Manual edit specific fields
    previousValue,
    newValue,
    rowIndex,
    columnName,
  }
}

/**
 * Build a details string from a TimelineCommand
 */
function buildDetails(command: TimelineCommand): string {
  const params = command.params

  switch (params.type) {
    case 'manual_edit':
      return `Cell [${params.columnName}] changed`

    case 'transform':
      if (params.column) {
        return `Applied ${params.transformationType} to column "${params.column}"`
      }
      return `Applied ${params.transformationType}`

    case 'merge':
      return `Merged ${params.mergedPairs?.length || 0} duplicate pairs`

    case 'standardize':
      return `Standardized ${params.mappings?.length || 0} values in "${params.columnName}"`

    case 'stack':
      return `Stacked tables: ${params.sourceTableNames?.join(', ') || 'unknown'}`

    case 'join':
      return `Joined with "${params.rightTableName}" on "${params.keyColumn}" (${params.joinType})`

    case 'scrub':
      return `Applied ${params.rules?.length || 0} obfuscation rules`

    case 'batch_edit':
      return `Batch edited ${params.changes?.length || 0} cells`

    default:
      return command.label
  }
}

/**
 * Get audit entries for a specific table from its timeline.
 * Only returns entries up to (and including) the current position.
 *
 * @param tableId - The table ID to get audit entries for
 * @returns Array of AuditLogEntry, sorted newest first
 */
export function getAuditEntriesForTable(tableId: string): AuditLogEntry[] {
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline) {
    return []
  }

  // Only include commands up to current position (undone commands are hidden)
  const activeCommands = timeline.commands.slice(0, timeline.currentPosition + 1)

  // Convert commands to audit entries (newest first)
  return activeCommands
    .map((cmd, index) => convertCommandToAuditEntry(timeline, cmd, index))
    .reverse()
}

/**
 * Get all audit entries across all tables.
 * Only returns entries up to each table's current position.
 *
 * @returns Array of AuditLogEntry from all tables, sorted newest first
 */
export function getAllAuditEntries(): AuditLogEntry[] {
  const store = useTimelineStore.getState()
  const allEntries: AuditLogEntry[] = []

  // Iterate over all timelines
  for (const timeline of store.timelines.values()) {
    // Only include commands up to current position
    const activeCommands = timeline.commands.slice(0, timeline.currentPosition + 1)

    for (let i = 0; i < activeCommands.length; i++) {
      allEntries.push(convertCommandToAuditEntry(timeline, activeCommands[i], i))
    }
  }

  // Sort by timestamp, newest first
  allEntries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

  return allEntries
}

/**
 * React hook to get audit entries derived from timeline.
 * This can be used to replace direct auditStore consumption.
 *
 * @param tableId - Optional table ID to filter entries
 * @returns Array of AuditLogEntry
 */
export function useAuditEntriesFromTimeline(tableId?: string): AuditLogEntry[] {
  // Subscribe to timeline changes - this triggers re-render when timeline updates
  // The variable is used implicitly to create the subscription
  useTimelineStore((s) => s.timelines)

  // Recompute when timelines change
  if (tableId) {
    return getAuditEntriesForTable(tableId)
  }
  return getAllAuditEntries()
}
