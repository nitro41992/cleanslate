import { useState, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAuditStore } from '@/stores/auditStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { getAuditEntriesForTable, getAllAuditEntries } from '@/lib/audit-from-timeline'
import { formatDate } from '@/lib/utils'
import { Download, Trash2, Clock, FileText, Rows3, Zap, HardDrive } from 'lucide-react'
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

  // Subscribe to timeline changes to trigger re-render when undo/redo happens
  // This ensures the audit log always reflects the current timeline position
  const timelines = useTimelineStore((s) => s.timelines)
  const getSnapshotInfo = useTimelineStore((s) => s.getSnapshotInfo)

  // Derive audit entries from timeline with snapshot status (computed, not stored)
  const entriesWithSnapshotStatus = useMemo(() => {
    // timelines dependency ensures re-computation on timeline changes
    const rawEntries = tableId ? getAuditEntriesForTable(tableId) : getAllAuditEntries()

    // Enhance entries with hot/cold snapshot status
    // Entries are newest-first, so we need to look up by original index
    return rawEntries.map((entry) => {
      // For single-table view, get the timeline and find original command index
      const timeline = timelines.get(entry.tableId)
      if (!timeline) {
        return { ...entry, snapshotStatus: null as 'hot' | 'cold' | null }
      }

      // Find command index (entries are reversed, and there's an import entry at the end)
      // Command entries: reverseIndex 0 = newest command (index = commands.length - 1)
      // Import entry is always last (oldest), has id starting with 'import_'
      if (entry.id.startsWith('import_')) {
        return { ...entry, snapshotStatus: null as 'hot' | 'cold' | null }
      }

      // Find the original index of this command
      const commandIndex = timeline.commands.findIndex(cmd => cmd.id === entry.id)
      if (commandIndex === -1) {
        return { ...entry, snapshotStatus: null as 'hot' | 'cold' | null }
      }

      // Snapshot at index N = state BEFORE command at N+1 was executed
      // So command at index C has a snapshot at index C-1 that can undo it
      // But actually we create snapshot at position = currentPosition BEFORE the expensive command
      // So snapshot at index N is created when position was N, before command N+1
      // Therefore, to undo command C, we need snapshot at C-1

      // For simplicity, check if there's a snapshot at this command's index
      // (snapshot created AFTER this command was executed, for undoing the NEXT expensive command)
      const snapshotInfo = getSnapshotInfo(entry.tableId, commandIndex)

      let snapshotStatus: 'hot' | 'cold' | null = null
      if (snapshotInfo) {
        snapshotStatus = snapshotInfo.hotTableName ? 'hot' : 'cold'
      }

      return { ...entry, snapshotStatus }
    })
  }, [tableId, timelines, getSnapshotInfo])

  const entries = entriesWithSnapshotStatus

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
                        {/* Hot/Cold snapshot indicator (LRU undo cache - Phase 3) */}
                        {entry.snapshotStatus === 'hot' && (
                          <Badge
                            variant="outline"
                            className="text-xs bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30"
                            data-testid="snapshot-hot-badge"
                          >
                            <Zap className="w-3 h-3 mr-1" />
                            Instant
                          </Badge>
                        )}
                        {entry.snapshotStatus === 'cold' && (
                          <Badge
                            variant="outline"
                            className="text-xs text-muted-foreground"
                            data-testid="snapshot-cold-badge"
                          >
                            <HardDrive className="w-3 h-3 mr-1" />
                            ~2s
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
                      <span className="text-red-600 dark:text-red-400">{formatValue(entry.previousValue)}</span>
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span className="text-green-600 dark:text-green-400">{formatValue(entry.newValue)}</span>
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
