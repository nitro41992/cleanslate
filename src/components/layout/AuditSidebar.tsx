import { useState } from 'react'
import { ChevronRight, History, FileText, Eye, Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { useTableStore } from '@/stores/tableStore'
import { AuditDetailModal } from '@/components/common/AuditDetailModal'
import type { AuditLogEntry } from '@/types'
import { cn } from '@/lib/utils'

export function AuditSidebar() {
  const auditSidebarOpen = usePreviewStore((s) => s.auditSidebarOpen)
  const setAuditSidebarOpen = usePreviewStore((s) => s.setAuditSidebarOpen)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const entries = useAuditStore((s) => s.entries)
  const exportLog = useAuditStore((s) => s.exportLog)

  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null)

  // Filter entries for active table
  const tableEntries = entries.filter((e) => e.tableId === activeTableId)

  const handleExportLog = async () => {
    const content = await exportLog()
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'audit_log.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const formatTime = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return date.toLocaleDateString()
  }

  if (!auditSidebarOpen) {
    return null
  }

  return (
    <>
      <aside className="w-80 border-l border-border/50 bg-card/30 flex flex-col shrink-0">
        {/* Header */}
        <div className="h-12 flex items-center justify-between px-3 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">Audit Log</span>
            {tableEntries.length > 0 && (
              <Badge variant="secondary" className="text-[10px] h-5">
                {tableEntries.length}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleExportLog}
                  disabled={tableEntries.length === 0}
                >
                  <Download className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export audit log</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setAuditSidebarOpen(false)}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Entries */}
        <ScrollArea className="flex-1">
          {tableEntries.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No changes yet.</p>
              <p className="text-xs mt-1">
                Apply transforms, matches, or other operations to see history here.
              </p>
            </div>
          ) : (
            <div className="p-2 px-3 space-y-1">
              {tableEntries.map((entry) => (
                <button
                  key={entry.id}
                  className={cn(
                    'w-full text-left p-2 rounded-lg hover:bg-muted/50 transition-colors group',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1'
                  )}
                  onClick={() => setSelectedEntry(entry)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{entry.action}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {entry.details}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge
                      variant={entry.entryType === 'A' ? 'default' : 'secondary'}
                      className="text-[10px] h-4 px-1.5"
                    >
                      {entry.entryType === 'A' ? 'Transform' : 'Edit'}
                    </Badge>
                    {entry.rowsAffected !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        {entry.rowsAffected.toLocaleString()} rows
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {formatTime(entry.timestamp)}
                    </span>
                  </div>
                  {entry.hasRowDetails && (
                    <div className="flex items-center gap-1 mt-1 text-[10px] text-primary">
                      <Eye className="w-3 h-3" />
                      <span>View details</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>

      {/* Detail Modal */}
      <AuditDetailModal
        entry={selectedEntry}
        open={selectedEntry !== null}
        onOpenChange={(open) => !open && setSelectedEntry(null)}
      />
    </>
  )
}
