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
  // Check for both single manual edits AND batch edits
  // - params.type is set by syncExecuteToTimelineStore in timelineStore.ts
  // - commandType is set by the command executor
  const isManualEdit =
    command.params.type === 'manual_edit' ||
    command.params.type === 'batch_edit' ||
    command.commandType === 'manual_edit' ||
    command.commandType === 'batch_edit'

  // For manual edits, extract the previous/new values from params
  let previousValue: unknown
  let newValue: unknown
  let columnName: string | undefined
  let csId: string | undefined

  if (isManualEdit) {
    const params = command.params as ManualEditParams
    previousValue = params.previousValue
    newValue = params.newValue
    columnName = params.columnName
    csId = params.csId // Stable cell identifier (replaces rowIndex)
  }

  // Also check cellChanges for batch edits or legacy format
  if (command.cellChanges && command.cellChanges.length > 0) {
    const firstChange = command.cellChanges[0]
    previousValue = previousValue ?? firstChange.previousValue
    newValue = newValue ?? firstChange.newValue
    columnName = columnName ?? firstChange.columnName
    csId = csId ?? firstChange.csId
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
    columnName,
    csId,
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

    case 'scrub': {
      // Rules may be at top level (ScrubParams type) or nested under params
      // due to timeline param structure from executor.ts
      const paramsAny = params as unknown as Record<string, unknown>
      const nestedParams = paramsAny.params as Record<string, unknown> | undefined
      const rules = (nestedParams?.rules || paramsAny.rules || []) as Array<{ column: string; method: string }>
      if (rules.length === 0) {
        return 'Applied 0 obfuscation rules'
      }
      // Format: "3 rules: SSN → mask, Phone → last4"
      const rulesDescription = rules.map((r) => `${r.column} → ${r.method}`).join(', ')
      return `Applied ${rules.length} rule${rules.length !== 1 ? 's' : ''}: ${rulesDescription}`
    }

    case 'batch_edit':
      return `Batch edited ${params.changes?.length || 0} cells`

    default:
      return command.label
  }
}

/**
 * Get audit entries for a specific table from its timeline.
 * Returns ALL entries (both active and undone) - the UI handles visual distinction.
 * Entries beyond currentPosition are shown greyed out with "Undone" badge.
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

  // Create synthetic "File Imported" entry from timeline creation
  const importEntry: AuditLogEntry = {
    id: `import_${timeline.id}`,
    timestamp: timeline.createdAt,
    tableId: timeline.tableId,
    tableName: timeline.tableName,
    action: 'File Imported',
    details: `Imported table "${timeline.tableName}"`,
    entryType: 'A',
    rowsAffected: 0, // Unknown at this point
    hasRowDetails: false,
    auditEntryId: `import_${timeline.id}`,
  }

  // Return ALL commands plus the import entry - UI handles greyed styling for undone entries
  // (entries beyond currentPosition shown with opacity-40 and "Undone" badge)
  const commandEntries = timeline.commands
    .map((cmd, index) => convertCommandToAuditEntry(timeline, cmd, index))

  // Return with newest first: commands reversed, then import at the end (oldest)
  return [...commandEntries.reverse(), importEntry]
}

/**
 * Get all audit entries across all tables.
 * Returns ALL entries (both active and undone) - the UI handles visual distinction.
 *
 * @returns Array of AuditLogEntry from all tables, sorted newest first
 */
export function getAllAuditEntries(): AuditLogEntry[] {
  const store = useTimelineStore.getState()
  const allEntries: AuditLogEntry[] = []

  // Iterate over all timelines - include ALL commands plus import entry
  for (const timeline of store.timelines.values()) {
    // Add synthetic "File Imported" entry
    allEntries.push({
      id: `import_${timeline.id}`,
      timestamp: timeline.createdAt,
      tableId: timeline.tableId,
      tableName: timeline.tableName,
      action: 'File Imported',
      details: `Imported table "${timeline.tableName}"`,
      entryType: 'A',
      rowsAffected: 0,
      hasRowDetails: false,
      auditEntryId: `import_${timeline.id}`,
    })

    // Add all command entries
    for (let i = 0; i < timeline.commands.length; i++) {
      allEntries.push(convertCommandToAuditEntry(timeline, timeline.commands[i], i))
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
