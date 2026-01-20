import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAuditStore } from '@/stores/auditStore'
import { formatDate } from '@/lib/utils'
import { Download, Trash2, Clock, FileText, Rows3 } from 'lucide-react'
import { AuditDetailModal } from './AuditDetailModal'
import type { AuditLogEntry } from '@/types'

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}

interface AuditLogPanelProps {
  tableId?: string
}

export function AuditLogPanel({ tableId }: AuditLogPanelProps) {
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)

  const entries = useAuditStore((s) =>
    tableId ? s.getEntriesForTable(tableId) : s.entries
  )
  const clearEntries = useAuditStore((s) => s.clearEntries)
  const exportLog = useAuditStore((s) => s.exportLog)

  const handleEntryClick = (entry: AuditLogEntry) => {
    if (entry.hasRowDetails && entry.auditEntryId) {
      setSelectedEntry(entry)
      setIsModalOpen(true)
    }
  }

  const handleExport = async () => {
    const content = await exportLog()
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit_log_${new Date().toISOString().split('T')[0]}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full" data-testid="audit-log-panel">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm">Audit Log</span>
          <span className="text-xs text-muted-foreground">
            ({entries.length} entries)
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleExport}
            disabled={entries.length === 0}
            data-testid="audit-export-btn"
          >
            <Download className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={clearEntries}
            disabled={entries.length === 0}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <Clock className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">No actions recorded yet</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {entries.map((entry) => {
              const isClickable = entry.hasRowDetails && entry.auditEntryId
              return (
                <div
                  key={entry.id}
                  className={`p-3 rounded-lg bg-muted/30 transition-colors ${
                    isClickable
                      ? 'hover:bg-muted/50 cursor-pointer border border-transparent hover:border-primary/30'
                      : 'hover:bg-muted/40'
                  }`}
                  onClick={() => handleEntryClick(entry)}
                  role={isClickable ? 'button' : undefined}
                  tabIndex={isClickable ? 0 : undefined}
                  onKeyDown={isClickable ? (e) => e.key === 'Enter' && handleEntryClick(entry) : undefined}
                  data-testid={isClickable ? 'audit-entry-with-details' : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{entry.action}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {entry.rowsAffected !== undefined && (
                          <Badge variant="secondary" className="text-xs">
                            <Rows3 className="w-3 h-3 mr-1" />
                            {entry.rowsAffected.toLocaleString()} {entry.rowsAffected === 1 ? 'row' : 'rows'}
                          </Badge>
                        )}
                        {entry.entryType === 'A' && entry.rowsAffected === undefined && (
                          <Badge variant="secondary" className="text-xs">
                            <Rows3 className="w-3 h-3 mr-1" />
                            -
                          </Badge>
                        )}
                        {isClickable && (
                          <span className="text-xs text-primary">View details →</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {entry.details}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(entry.timestamp)}
                    </span>
                  </div>
                  {/* Inline details for Type B (manual edit) entries */}
                  {entry.entryType === 'B' && entry.previousValue !== undefined && (
                    <div className="mt-2 text-xs font-mono bg-muted/50 rounded p-2">
                      <span className="text-red-400">{formatValue(entry.previousValue)}</span>
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span className="text-green-400">{formatValue(entry.newValue)}</span>
                    </div>
                  )}
                  {!tableId && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Table: {entry.tableName}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Detail Modal */}
      <AuditDetailModal
        entry={selectedEntry}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
      />
    </div>
  )
}
