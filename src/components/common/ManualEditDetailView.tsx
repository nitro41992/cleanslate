import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { AuditLogEntry } from '@/types'

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

export function ManualEditDetailView({ entry }: ManualEditDetailViewProps) {
  const cellId = formatCellId(entry.csId)

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
                {entry.columnName}
              </td>
              <td className="py-2 px-3">
                <span className="inline-block px-2 py-0.5 rounded bg-red-500/10 text-red-400 font-mono text-xs">
                  {formatValue(entry.previousValue)}
                </span>
              </td>
              <td className="py-2 px-3">
                <span className="inline-block px-2 py-0.5 rounded bg-green-500/10 text-green-400 font-mono text-xs">
                  {formatValue(entry.newValue)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </ScrollArea>
    </div>
  )
}
