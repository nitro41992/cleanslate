import { useState, useCallback, useMemo } from 'react'
import { ChevronRight, History, FileText, Eye, Download, X, Crosshair } from 'lucide-react'
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
import { useTimelineStore } from '@/stores/timelineStore'
import { AuditDetailModal } from '@/components/common/AuditDetailModal'
import type { AuditLogEntry } from '@/types'
import { cn } from '@/lib/utils'

export function AuditSidebar() {
  const auditSidebarOpen = usePreviewStore((s) => s.auditSidebarOpen)
  const setAuditSidebarOpen = usePreviewStore((s) => s.setAuditSidebarOpen)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const entries = useAuditStore((s) => s.entries)
  const exportLog = useAuditStore((s) => s.exportLog)

  // Timeline integration for drill-down highlighting
  const getTimeline = useTimelineStore((s) => s.getTimeline)
  const setHighlightedCommand = useTimelineStore((s) => s.setHighlightedCommand)
  const highlightedCommandId = useTimelineStore((s) => s.highlight.commandId)
  const clearHighlight = useTimelineStore((s) => s.clearHighlight)

  // Timeline position for undo/redo visual feedback
  const timeline = activeTableId ? getTimeline(activeTableId) : null
  const currentPosition = timeline?.currentPosition ?? -1
  const commandCount = timeline?.commands.length ?? 0

  // Create lookup: auditEntryId -> command index
  const auditEntryToCommandIndex = useMemo(() => {
    const map = new Map<string, number>()
    timeline?.commands.forEach((cmd, idx) => {
      if (cmd.auditEntryId) map.set(cmd.auditEntryId, idx)
    })
    return map
  }, [timeline?.commands])

  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null)

  // Find timeline command linked to an audit entry
  const findTimelineCommand = useCallback(
    (auditEntryId: string | undefined) => {
      if (!auditEntryId || !activeTableId) return null
      const timeline = getTimeline(activeTableId)
      if (!timeline) return null
      return timeline.commands.find((cmd) => cmd.auditEntryId === auditEntryId) ?? null
    },
    [activeTableId, getTimeline]
  )

  // Toggle highlight for an entry
  const toggleHighlight = useCallback(
    (entry: AuditLogEntry, e: React.MouseEvent) => {
      e.stopPropagation() // Don't open modal when clicking highlight button
      const command = findTimelineCommand(entry.auditEntryId)
      if (command) {
        if (highlightedCommandId === command.id) {
          clearHighlight()
        } else {
          setHighlightedCommand(command.id)
        }
      }
    },
    [findTimelineCommand, highlightedCommandId, clearHighlight, setHighlightedCommand]
  )

  // Filter entries for active table
  const tableEntries = entries.filter((e) => e.tableId === activeTableId)

  // Find the first untracked entry index (for determining "current" at position -1)
  const firstUntrackedEntryIndex = useMemo(() => {
    for (let i = 0; i < tableEntries.length; i++) {
      const entry = tableEntries[i]
      const cmdIndex = auditEntryToCommandIndex.get(entry.auditEntryId ?? '')
      if (cmdIndex === undefined) {
        return i
      }
    }
    return -1
  }, [tableEntries, auditEntryToCommandIndex])

  // Helper to determine entry state relative to timeline position
  type EntryState = 'past' | 'current' | 'future'
  const getEntryState = useCallback(
    (entry: AuditLogEntry, entryIndex: number): EntryState => {
      const cmdIndex = auditEntryToCommandIndex.get(entry.auditEntryId ?? '')

      // Entry is linked to a timeline command
      if (cmdIndex !== undefined) {
        if (cmdIndex === currentPosition) return 'current'
        if (cmdIndex < currentPosition) return 'past'
        return 'future'
      }

      // Entry is NOT linked to timeline (e.g., "File loaded")
      // These are actions that can't be undone, so treat as follows:
      // - If at position -1 (original state/all undone) and this is the first untracked entry,
      //   it represents the current state we've returned to
      // - Otherwise, it's "past" (already happened, can't be undone)
      if (currentPosition === -1 && entryIndex === firstUntrackedEntryIndex) {
        return 'current'
      }
      return 'past'
    },
    [auditEntryToCommandIndex, currentPosition, firstUntrackedEntryIndex]
  )

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
      <aside className="w-96 border-l border-border/50 bg-card/30 flex flex-col shrink-0" data-testid="audit-sidebar">
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
            {/* Timeline position indicator */}
            {commandCount > 0 && (
              <Badge variant="outline" className="text-[10px] h-5 text-muted-foreground">
                {currentPosition + 1}/{commandCount}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {highlightedCommandId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-primary"
                    onClick={clearHighlight}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear highlights</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleExportLog}
                  disabled={tableEntries.length === 0}
                  data-testid="audit-export-btn"
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
              onClick={() => {
                clearHighlight() // Clear highlights when closing
                setAuditSidebarOpen(false)
              }}
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
              {tableEntries.map((entry, index) => {
                const entryState = getEntryState(entry, index)
                const isFuture = entryState === 'future'
                const isCurrent = entryState === 'current'

                // Check if we need to show separator before this entry
                // Show separator before current entry if previous entry is future (undone)
                // This creates a visual divider between undone actions and current state
                const prevEntry = index > 0 ? tableEntries[index - 1] : null
                const prevState = prevEntry ? getEntryState(prevEntry, index - 1) : null
                const showSeparatorBefore = isCurrent && prevState === 'future'

                return (
                  <div key={entry.id}>
                    {/* Current State separator */}
                    {showSeparatorBefore && (
                      <div className="flex items-center gap-2 py-2 my-1">
                        <div className="flex-1 border-t border-primary/30" />
                        <span className="text-[10px] text-primary/70 font-medium px-1">
                          Current State
                        </span>
                        <div className="flex-1 border-t border-primary/30" />
                      </div>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'w-full text-left p-2 rounded-lg transition-colors group cursor-pointer',
                        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                        isFuture && 'opacity-40',
                        isCurrent && 'border-l-2 border-primary bg-primary/5',
                        !isFuture && 'hover:bg-muted/50'
                      )}
                      onClick={() => setSelectedEntry(entry)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedEntry(entry)
                        }
                      }}
                      data-testid={entry.hasRowDetails ? 'audit-entry-with-details' : undefined}
                    >
                      <div className="flex items-start justify-between gap-2 overflow-hidden">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{entry.action}</p>
                            {/* Undone badge for future entries */}
                            {isFuture && (
                              <Badge variant="outline" className="text-[10px] h-4 px-1 opacity-80 shrink-0">
                                Undone
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-3 break-all overflow-hidden">
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
                      <div className="flex items-center gap-2 mt-1">
                        {entry.hasRowDetails && (
                          <div className="flex items-center gap-1 text-[10px] text-primary">
                            <Eye className="w-3 h-3" />
                            <span>View details</span>
                          </div>
                        )}
                        {/* Highlight in grid button */}
                        {findTimelineCommand(entry.auditEntryId) && (
                          <button
                            onClick={(e) => toggleHighlight(entry, e)}
                            className={cn(
                              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
                              highlightedCommandId === findTimelineCommand(entry.auditEntryId)?.id
                                ? 'bg-primary/20 text-primary'
                                : 'text-muted-foreground hover:text-primary hover:bg-primary/10'
                            )}
                            title="Highlight affected cells in grid"
                          >
                            <Crosshair className="w-3 h-3" />
                            <span>
                              {highlightedCommandId === findTimelineCommand(entry.auditEntryId)?.id
                                ? 'Clear'
                                : 'Highlight'}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
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
