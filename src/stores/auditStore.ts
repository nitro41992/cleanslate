import { create } from 'zustand'
import type { AuditLogEntry, AuditEntryType } from '@/types'
import { generateId } from '@/lib/utils'

interface ManualEditParams {
  tableId: string
  tableName: string
  rowIndex: number
  columnName: string
  previousValue: unknown
  newValue: unknown
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
  addManualEditEntry: (params: ManualEditParams) => void
  clearEntries: () => void
  getEntriesForTable: (tableId: string) => AuditLogEntry[]
  exportLog: () => string
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

  addManualEditEntry: (params) => {
    const entry: AuditLogEntry = {
      id: generateId(),
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
    }
    set((state) => ({
      entries: [entry, ...state.entries],
    }))
  },

  clearEntries: () => {
    set({ entries: [] })
  },

  getEntriesForTable: (tableId) => {
    return get().entries.filter((e) => e.tableId === tableId)
  },

  exportLog: () => {
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

    entries.forEach((entry) => {
      lines.push(`[${entry.timestamp.toISOString()}]`)
      lines.push(`Table: ${entry.tableName}`)
      lines.push(`Type: ${entry.entryType === 'B' ? 'Manual Edit (B)' : 'Transformation (A)'}`)
      lines.push(`Action: ${entry.action}`)
      lines.push(`Details: ${entry.details}`)

      // Include previous/new values for Type B entries
      if (entry.entryType === 'B') {
        lines.push(`Row: ${entry.rowIndex}`)
        lines.push(`Column: ${entry.columnName}`)
        lines.push(`Previous Value: ${formatValue(entry.previousValue)}`)
        lines.push(`New Value: ${formatValue(entry.newValue)}`)
      }

      lines.push('')
    })

    return lines.join('\n')
  },
}))

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}
