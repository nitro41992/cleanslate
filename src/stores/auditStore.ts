import { create } from 'zustand'
import type { AuditLogEntry } from '@/types'
import { generateId } from '@/lib/utils'

interface AuditState {
  entries: AuditLogEntry[]
}

interface AuditActions {
  addEntry: (
    tableId: string,
    tableName: string,
    action: string,
    details: string
  ) => void
  clearEntries: () => void
  getEntriesForTable: (tableId: string) => AuditLogEntry[]
  exportLog: () => string
}

export const useAuditStore = create<AuditState & AuditActions>((set, get) => ({
  entries: [],

  addEntry: (tableId, tableName, action, details) => {
    const entry: AuditLogEntry = {
      id: generateId(),
      timestamp: new Date(),
      tableId,
      tableName,
      action,
      details,
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
    const lines = [
      '=== CleanSlate Transformation Audit Log ===',
      `Generated: ${new Date().toISOString()}`,
      `Total Actions: ${entries.length}`,
      '',
      '--- Log Entries ---',
      '',
    ]

    entries.forEach((entry) => {
      lines.push(`[${entry.timestamp.toISOString()}]`)
      lines.push(`Table: ${entry.tableName}`)
      lines.push(`Action: ${entry.action}`)
      lines.push(`Details: ${entry.details}`)
      lines.push('')
    })

    return lines.join('\n')
  },
}))
