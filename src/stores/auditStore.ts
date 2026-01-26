/**
 * Audit Store - Derived from Timeline
 *
 * IMPORTANT: Audit entries are now derived from timelineStore, not stored separately.
 * This ensures the audit log always matches the timeline position after undo/redo.
 *
 * The store still provides:
 * - getEntriesForTable(tableId) - now delegates to timeline
 * - addEntry() / addTransformationEntry() / addManualEditEntry() - kept for backward
 *   compatibility, but these entries are NOT the source of truth. The timeline is.
 * - exportLog() - exports from derived entries
 *
 * Migration note: Code should eventually move to using useAuditEntriesFromTimeline()
 * directly, but this store provides backward compatibility during the transition.
 */

import { create } from 'zustand'
import type { AuditLogEntry, AuditEntryType, SerializedAuditLogEntry } from '@/types'
import { generateId } from '@/lib/utils'
import { getAuditRowDetails } from '@/lib/transformations'
import {
  getAuditEntriesForTable,
  getAllAuditEntries,
} from '@/lib/audit-from-timeline'

interface ManualEditParams {
  tableId: string
  tableName: string
  rowIndex: number
  columnName: string
  previousValue: unknown
  newValue: unknown
}

interface TransformationEntryParams {
  tableId: string
  tableName: string
  action: string
  details: string
  rowsAffected?: number
  hasRowDetails?: boolean
  auditEntryId?: string
  isCapped?: boolean
}

interface AuditState {
  /**
   * @deprecated Legacy entries array. Use getEntriesForTable() which derives from timeline.
   * This is only kept for non-table audit entries (app-level events) if needed.
   */
  _legacyEntries: AuditLogEntry[]
}

interface AuditActions {
  /**
   * @deprecated Use CommandExecutor to record actions. Entries are derived from timeline.
   * This is kept for backward compatibility but does NOT update the timeline-derived view.
   */
  addEntry: (
    tableId: string,
    tableName: string,
    action: string,
    details: string,
    entryType?: AuditEntryType
  ) => void

  /**
   * @deprecated Use CommandExecutor. Entries are derived from timeline.
   */
  addTransformationEntry: (params: TransformationEntryParams) => void

  /**
   * @deprecated Use CommandExecutor. Returns auditEntryId for compatibility.
   */
  addManualEditEntry: (params: ManualEditParams) => string

  /**
   * Load legacy entries (for OPFS persistence backward compatibility)
   * @deprecated Timeline is the source of truth
   */
  loadEntries: (entries: AuditLogEntry[]) => void

  /**
   * Clear legacy entries
   */
  clearEntries: () => void

  /**
   * Get audit entries for a specific table.
   * DERIVED FROM TIMELINE - only shows entries up to current position.
   */
  getEntriesForTable: (tableId: string) => AuditLogEntry[]

  /**
   * Get all audit entries across all tables.
   * DERIVED FROM TIMELINE - only shows entries up to each table's current position.
   */
  getAllEntries: () => AuditLogEntry[]

  /**
   * Get serialized entries for persistence.
   * @deprecated Timeline handles its own persistence
   */
  getSerializedEntries: () => SerializedAuditLogEntry[]

  /**
   * Export audit log as text
   */
  exportLog: () => Promise<string>
}

export const useAuditStore = create<AuditState & AuditActions>((set) => ({
  _legacyEntries: [],

  // DEPRECATED: Legacy add methods - kept for backward compatibility
  // These don't affect the timeline-derived audit view

  addEntry: (tableId, tableName, action, details, entryType = 'A') => {
    // Note: This is a no-op for timeline-derived audit.
    // The real audit entry comes from CommandExecutor -> timelineStore.appendCommand()
    console.log('[AuditStore] addEntry called (legacy, no-op for timeline-derived audit)', {
      tableId,
      action,
    })
    // Keep legacy behavior for non-table events if needed
    const entry: AuditLogEntry = {
      id: generateId(),
      timestamp: new Date(),
      tableId,
      tableName,
      action,
      details,
      entryType,
    }
    set((state) => ({
      _legacyEntries: [entry, ...state._legacyEntries],
    }))
  },

  addTransformationEntry: (params) => {
    // No-op for timeline-derived audit
    console.log('[AuditStore] addTransformationEntry called (legacy, no-op)', {
      action: params.action,
    })
  },

  addManualEditEntry: (params) => {
    // Return a generated ID for compatibility, but don't store
    console.log('[AuditStore] addManualEditEntry called (legacy)', {
      columnName: params.columnName,
    })
    return generateId()
  },

  loadEntries: (entries) => {
    // Load into legacy array for backward compatibility
    set({ _legacyEntries: entries })
  },

  clearEntries: () => {
    set({ _legacyEntries: [] })
  },

  // DERIVED FROM TIMELINE - these are the primary methods to use

  getEntriesForTable: (tableId) => {
    // Derive from timeline (single source of truth)
    return getAuditEntriesForTable(tableId)
  },

  getAllEntries: () => {
    // Derive from timeline (single source of truth)
    return getAllAuditEntries()
  },

  getSerializedEntries: () => {
    // Serialize the timeline-derived entries
    const entries = getAllAuditEntries()
    return entries.map((entry) => ({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    }))
  },

  exportLog: async () => {
    // Export from timeline-derived entries
    const entries = getAllAuditEntries()
    const typeAEntries = entries.filter((e) => e.entryType !== 'B')
    const typeBEntries = entries.filter((e) => e.entryType === 'B')

    const lines = [
      '=== CleanSlate Transformation Audit Log ===',
      `Generated: ${new Date().toISOString()}`,
      `Total Actions: ${entries.length}`,
      `  - Transformations (Type A): ${typeAEntries.length}`,
      `  - Manual Edits (Type B): ${typeBEntries.length}`,
      '',
      '--- Log Entries ---',
      '',
    ]

    for (const entry of entries) {
      lines.push(`[${entry.timestamp.toISOString()}]`)
      lines.push(`Table: ${entry.tableName}`)
      lines.push(`Type: ${entry.entryType === 'B' ? 'Manual Edit (B)' : 'Transformation (A)'}`)
      lines.push(`Action: ${entry.action}`)
      lines.push(`Details: ${entry.details}`)

      // Include rowsAffected for Type A entries
      if (entry.entryType === 'A' && entry.rowsAffected !== undefined) {
        lines.push(`Rows Affected: ${entry.rowsAffected}`)
      }

      // Fetch and include row-level details if available
      if (entry.hasRowDetails && entry.auditEntryId) {
        try {
          const { rows, total } = await getAuditRowDetails(entry.auditEntryId, 10000, 0)
          lines.push(`Row Details (${total} changes):`)
          for (const row of rows) {
            lines.push(`  Row ${row.rowIndex}, ${row.columnName}: ${formatValue(row.previousValue)} → ${formatValue(row.newValue)}`)
          }
        } catch {
          lines.push(`Row Details: Failed to fetch (ID: ${entry.auditEntryId})`)
        }
      }

      // Include previous/new values for Type B entries
      if (entry.entryType === 'B') {
        if (entry.rowIndex !== undefined) {
          lines.push(`Row: ${entry.rowIndex}`)
        }
        lines.push(`Column: ${entry.columnName}`)
        lines.push(`Previous Value: ${formatValue(entry.previousValue)}`)
        lines.push(`New Value: ${formatValue(entry.newValue)}`)
      }

      lines.push('')
    }

    return lines.join('\n')
  },
}))

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}

/**
 * Backward compatibility: Re-export the entries getter as a selector
 * Components using `useAuditStore((s) => s.entries)` should migrate to
 * `useAuditStore((s) => s.getAllEntries())`
 */
Object.defineProperty(useAuditStore.getState(), 'entries', {
  get() {
    return getAllAuditEntries()
  },
})
