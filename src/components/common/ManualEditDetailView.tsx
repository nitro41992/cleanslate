import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { AuditLogEntry, CellChange } from '@/types'
import { useTimelineStore } from '@/stores/timelineStore'
import { useTableStore } from '@/stores/tableStore'
import { useMemo, useState, useEffect } from 'react'
import { query } from '@/lib/duckdb'

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
 * Fetch current row numbers for a list of rows identified by _cs_origin_id.
 * Row numbers are computed dynamically using ROW_NUMBER() to reflect
 * the current state of the table after any insertions/deletions.
 *
 * Uses _cs_origin_id (stable UUID) rather than _cs_id (positional, changes on insert/delete)
 * to correctly identify rows even after the table has been modified.
 */
async function getCurrentRowNumbers(
  tableName: string,
  csOriginIds: string[]
): Promise<Map<string, number>> {
  if (csOriginIds.length === 0) return new Map()

  // Build IN clause with properly escaped values
  const originIdList = csOriginIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')

  try {
    const result = await query<{ _cs_origin_id: string; row_num: number }>(`
      WITH numbered_rows AS (
        SELECT
          "_cs_origin_id",
          ROW_NUMBER() OVER (ORDER BY CAST("_cs_id" AS INTEGER)) as row_num
        FROM "${tableName}"
      )
      SELECT "_cs_origin_id", row_num
      FROM numbered_rows
      WHERE "_cs_origin_id" IN (${originIdList})
    `)

    return new Map(result.map(r => [String(r._cs_origin_id), Number(r.row_num)]))
  } catch (error) {
    console.error('Failed to fetch current row numbers:', error)
    return new Map()
  }
}

/**
 * Row component for a single cell change with dynamic row number display
 */
function CellChangeRow({
  change,
  rowNumber,
  hasStableId,
}: {
  change: CellChange
  rowNumber: number | null
  hasStableId: boolean
}) {
  // Display row number if available, otherwise show "(deleted)" or "(unknown)" for legacy edits
  const isDeleted = rowNumber === null && hasStableId
  const isLegacy = rowNumber === null && !hasStableId
  const rowDisplay = rowNumber !== null
    ? `Row ${rowNumber}`
    : isLegacy
      ? '(unknown)'
      : '(deleted)'

  return (
    <tr
      className="border-b border-border/50 hover:bg-muted/30 transition-colors"
      data-testid="manual-edit-detail-row"
    >
      <td className={`py-2 px-3 font-mono ${isDeleted || isLegacy ? 'text-muted-foreground/50 italic' : 'text-foreground'}`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help">{rowDisplay}</span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono text-xs">
              {isDeleted
                ? 'Row has been deleted'
                : isLegacy
                  ? 'Legacy edit - row tracking not available'
                  : `Origin ID: ${change.csOriginId}`}
            </span>
          </TooltipContent>
        </Tooltip>
      </td>
      <td className={`py-2 px-3 font-medium ${isDeleted || isLegacy ? 'text-muted-foreground/50' : ''}`}>
        {change.columnName}
      </td>
      <td className="py-2 px-3">
        <span className={`inline-block px-2 py-0.5 rounded bg-red-500/10 text-red-400 font-mono text-xs max-w-[200px] truncate ${isDeleted || isLegacy ? 'opacity-50' : ''}`}>
          {formatValue(change.previousValue)}
        </span>
      </td>
      <td className="py-2 px-3">
        <span className={`inline-block px-2 py-0.5 rounded bg-green-500/10 text-green-400 font-mono text-xs max-w-[200px] truncate ${isDeleted || isLegacy ? 'opacity-50' : ''}`}>
          {formatValue(change.newValue)}
        </span>
      </td>
    </tr>
  )
}

export function ManualEditDetailView({ entry }: ManualEditDetailViewProps) {
  const [rowNumberMap, setRowNumberMap] = useState<Map<string, number>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [tableExists, setTableExists] = useState(true)

  // Get table name from store
  const tableName = useTableStore(
    state => state.tables.find(t => t.id === entry.tableId)?.name
  )

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

  // Build the changes array (either from timeline or legacy format)
  const changes = useMemo(() => {
    if (cellChanges && cellChanges.length > 0) {
      return cellChanges
    }
    // Fallback to single cell (legacy format)
    return [{
      csId: entry.csId || '',
      columnName: entry.columnName || '',
      previousValue: entry.previousValue,
      newValue: entry.newValue,
    }]
  }, [cellChanges, entry.csId, entry.columnName, entry.previousValue, entry.newValue])

  // Fetch current row numbers when component mounts or changes update
  useEffect(() => {
    async function fetchRowNumbers() {
      if (!tableName) {
        setTableExists(false)
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      // Use csOriginId for lookup (stable identity that survives inserts/deletes)
      const csOriginIds = changes
        .map(c => c.csOriginId)
        .filter((id): id is string => Boolean(id))
      const rowNumbers = await getCurrentRowNumbers(tableName, csOriginIds)
      setRowNumberMap(rowNumbers)
      setTableExists(true)
      setIsLoading(false)
    }

    fetchRowNumbers()
  }, [tableName, changes])

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[400px] text-muted-foreground">
        Loading row details...
      </div>
    )
  }

  // Show message if table was deleted
  if (!tableExists) {
    return (
      <div className="flex flex-col h-full" data-testid="manual-edit-detail-view">
        <div className="text-sm text-amber-400 mb-2">
          Table no longer exists. Showing stored edit details.
        </div>
        <ScrollArea className="h-[400px] border rounded-lg">
          <table className="w-full text-sm" data-testid="manual-edit-detail-table">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
              <tr className="border-b">
                <th className="text-left py-2 px-3 font-medium w-24">Row</th>
                <th className="text-left py-2 px-3 font-medium w-32">Column</th>
                <th className="text-left py-2 px-3 font-medium">Previous Value</th>
                <th className="text-left py-2 px-3 font-medium">New Value</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change, index) => (
                <CellChangeRow
                  key={`${change.csOriginId || change.csId}-${change.columnName}-${index}`}
                  change={change}
                  rowNumber={null}
                  hasStableId={Boolean(change.csOriginId)}
                />
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="manual-edit-detail-view">
      {changes.length > 1 && (
        <div className="text-sm text-muted-foreground mb-2">
          {changes.length} cells edited
        </div>
      )}
      <ScrollArea className="h-[400px] border rounded-lg">
        <table className="w-full text-sm" data-testid="manual-edit-detail-table">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr className="border-b">
              <th className="text-left py-2 px-3 font-medium w-24">Row</th>
              <th className="text-left py-2 px-3 font-medium w-32">Column</th>
              <th className="text-left py-2 px-3 font-medium">Previous Value</th>
              <th className="text-left py-2 px-3 font-medium">New Value</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change, index) => (
              <CellChangeRow
                key={`${change.csOriginId || change.csId}-${change.columnName}-${index}`}
                change={change}
                rowNumber={change.csOriginId ? (rowNumberMap.get(change.csOriginId) ?? null) : null}
                hasStableId={Boolean(change.csOriginId)}
              />
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  )
}
