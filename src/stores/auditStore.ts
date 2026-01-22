import { create } from 'zustand'
import type { AuditLogEntry, AuditEntryType, SerializedAuditLogEntry } from '@/types'
import { generateId } from '@/lib/utils'
import { getAuditRowDetails } from '@/lib/transformations'

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
  entries: AuditLogEntry[]
}

interface AuditActions {
  addEntry: (
    tableId: string,
    tableName: string,
    action: string,
    details: string,
    entryType?: AuditEntryType
  ) => void
  addTransformationEntry: (params: TransformationEntryParams) => void
  addManualEditEntry: (params: ManualEditParams) => string // Returns auditEntryId
  loadEntries: (entries: AuditLogEntry[]) => void
  clearEntries: () => void
  getEntriesForTable: (tableId: string) => AuditLogEntry[]
  getSerializedEntries: () => SerializedAuditLogEntry[]
  exportLog: () => Promise<string>
}

export const useAuditStore = create<AuditState & AuditActions>((set, get) => ({
  entries: [],

  addEntry: (tableId, tableName, action, details, entryType = 'A') => {
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
      entries: [entry, ...state.entries],
    }))
  },

  addTransformationEntry: (params) => {
    const entry: AuditLogEntry = {
      id: generateId(),
      timestamp: new Date(),
      tableId: params.tableId,
      tableName: params.tableName,
      action: params.action,
      details: params.details,
      entryType: 'A',
      rowsAffected: params.rowsAffected,
      hasRowDetails: params.hasRowDetails,
      auditEntryId: params.auditEntryId,
      isCapped: params.isCapped,
    }
    set((state) => ({
      entries: [entry, ...state.entries],
    }))
  },

  addManualEditEntry: (params) => {
    const entryId = generateId()
    const entry: AuditLogEntry = {
      id: entryId,
      timestamp: new Date(),
      tableId: params.tableId,
      tableName: params.tableName,
      action: 'Manual Edit',
      details: `Cell [${params.rowIndex}, ${params.columnName}] changed`,
      entryType: 'B',
      previousValue: params.previousValue,
      newValue: params.newValue,
      rowIndex: params.rowIndex,
      columnName: params.columnName,
      rowsAffected: 1,
      hasRowDetails: true,
      auditEntryId: entryId,
    }
    set((state) => ({
      entries: [entry, ...state.entries],
    }))
    return entryId // Return the auditEntryId for timeline linkage
  },

  loadEntries: (entries) => {
    set({ entries })
  },

  clearEntries: () => {
    set({ entries: [] })
  },

  getEntriesForTable: (tableId) => {
    return get().entries.filter((e) => e.tableId === tableId)
  },

  getSerializedEntries: () => {
    return get().entries.map((entry) => ({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    }))
  },

  exportLog: async () => {
    const entries = get().entries
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
        lines.push(`Row: ${entry.rowIndex}`)
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
