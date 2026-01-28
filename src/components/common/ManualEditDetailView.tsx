import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { AuditLogEntry, CellChange } from '@/types'
import { useTimelineStore } from '@/stores/timelineStore'
import { useMemo } from 'react'

interface ManualEditDetailViewProps {
  entry: AuditLogEntry
}

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}

/**
 * Format cell ID for display.
 * Shows truncated UUID with tooltip for full value.
 */
function formatCellId(csId: string | undefined): { display: string; full: string } {
  if (!csId) return { display: 'N/A', full: 'No cell ID' }
  // Show first 8 characters of UUID
  const display = csId.length > 8 ? `${csId.slice(0, 8)}...` : csId
  return { display, full: csId }
}

/**
 * Row component for a single cell change
 */
function CellChangeRow({ change }: { change: CellChange }) {
  const cellId = formatCellId(change.csId)

  return (
    <tr
      className="border-b border-border/50 hover:bg-muted/30 transition-colors"
      data-testid="manual-edit-detail-row"
    >
      <td className="py-2 px-3 font-mono text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help">{cellId.display}</span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono text-xs">{cellId.full}</span>
          </TooltipContent>
        </Tooltip>
      </td>
      <td className="py-2 px-3 font-medium">
        {change.columnName}
      </td>
      <td className="py-2 px-3">
        <span className="inline-block px-2 py-0.5 rounded bg-red-500/10 text-red-400 font-mono text-xs max-w-[200px] truncate">
          {formatValue(change.previousValue)}
        </span>
      </td>
      <td className="py-2 px-3">
        <span className="inline-block px-2 py-0.5 rounded bg-green-500/10 text-green-400 font-mono text-xs max-w-[200px] truncate">
          {formatValue(change.newValue)}
        </span>
      </td>
    </tr>
  )
}

export function ManualEditDetailView({ entry }: ManualEditDetailViewProps) {
  // Get cell changes from timeline if available (for batch edits)
  const cellChanges = useMemo(() => {
    const timeline = useTimelineStore.getState().getTimeline(entry.tableId)
    if (!timeline) return null

    // Find the command that matches this audit entry
    const command = timeline.commands.find(
      (cmd) => cmd.id === entry.id || cmd.auditEntryId === entry.auditEntryId
    )

    return command?.cellChanges
  }, [entry.tableId, entry.id, entry.auditEntryId])

  // If we have multiple cell changes from the timeline, show them all
  if (cellChanges && cellChanges.length > 0) {
    return (
      <div className="flex flex-col h-full" data-testid="manual-edit-detail-view">
        {cellChanges.length > 1 && (
          <div className="text-sm text-muted-foreground mb-2">
            {cellChanges.length} cells edited
          </div>
        )}
        <ScrollArea className="h-[400px] border rounded-lg">
          <table className="w-full text-sm" data-testid="manual-edit-detail-table">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
              <tr className="border-b">
                <th className="text-left py-2 px-3 font-medium w-24">Cell ID</th>
                <th className="text-left py-2 px-3 font-medium w-32">Column</th>
                <th className="text-left py-2 px-3 font-medium">Previous Value</th>
                <th className="text-left py-2 px-3 font-medium">New Value</th>
              </tr>
            </thead>
            <tbody>
              {cellChanges.map((change, index) => (
                <CellChangeRow key={`${change.csId}-${change.columnName}-${index}`} change={change} />
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </div>
    )
  }

  // Fallback to single cell view (legacy format)
  const singleChange: CellChange = {
    csId: entry.csId || '',
    columnName: entry.columnName || '',
    previousValue: entry.previousValue,
    newValue: entry.newValue,
  }

  return (
    <div className="flex flex-col h-full" data-testid="manual-edit-detail-view">
      <ScrollArea className="h-[400px] border rounded-lg">
        <table className="w-full text-sm" data-testid="manual-edit-detail-table">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr className="border-b">
              <th className="text-left py-2 px-3 font-medium w-24">Cell ID</th>
              <th className="text-left py-2 px-3 font-medium w-32">Column</th>
              <th className="text-left py-2 px-3 font-medium">Previous Value</th>
              <th className="text-left py-2 px-3 font-medium">New Value</th>
            </tr>
          </thead>
          <tbody>
            <CellChangeRow change={singleChange} />
          </tbody>
        </table>
      </ScrollArea>
    </div>
  )
}
