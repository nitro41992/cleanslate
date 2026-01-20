import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useAuditStore } from '@/stores/auditStore'
import { formatDate } from '@/lib/utils'
import { Download, Trash2, Clock, FileText } from 'lucide-react'

interface AuditLogPanelProps {
  tableId?: string
}

export function AuditLogPanel({ tableId }: AuditLogPanelProps) {
  const entries = useAuditStore((s) =>
    tableId ? s.getEntriesForTable(tableId) : s.entries
  )
  const clearEntries = useAuditStore((s) => s.clearEntries)
  const exportLog = useAuditStore((s) => s.exportLog)

  const handleExport = () => {
    const content = exportLog()
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
    <div className="flex flex-col h-full">
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
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">
                      {entry.action}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {entry.details}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(entry.timestamp)}
                  </span>
                </div>
                {!tableId && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Table: {entry.tableName}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
