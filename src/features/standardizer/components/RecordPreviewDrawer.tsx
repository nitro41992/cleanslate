import { useEffect, useState, useCallback, useMemo } from 'react'
import { X, ChevronUp, ChevronDown, Star, Loader2, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { getConnection } from '@/lib/duckdb'
import { useStandardizerStore } from '@/stores/standardizerStore'
import { useTableStore } from '@/stores/tableStore'

interface RecordPreviewDrawerProps {
  open: boolean
  onClose: () => void
}

export function RecordPreviewDrawer({ open, onClose }: RecordPreviewDrawerProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const {
    previewClusterId,
    previewRecords,
    previewLoading,
    clusters,
    tableName,
    columnName,
    setPreviewRecords,
    setPreviewLoading,
  } = useStandardizerStore()

  const tables = useTableStore((s) => s.tables)
  const tableId = useStandardizerStore((s) => s.tableId)

  // Get the cluster being previewed
  const cluster = useMemo(() => {
    if (!previewClusterId) return null
    return clusters.find((c) => c.id === previewClusterId)
  }, [clusters, previewClusterId])

  // Get all columns for the table
  const columns = useMemo(() => {
    if (!tableId) return []
    const table = tables.find((t) => t.id === tableId)
    return table?.columns ?? []
  }, [tableId, tables])

  // Fetch records when cluster changes
  const fetchRecords = useCallback(async () => {
    if (!cluster || !tableName || !columnName) return

    setPreviewLoading(true)

    try {
      const conn = await getConnection()

      // Get all values in this cluster
      const values = cluster.values.map((v) => v.value)
      const masterValue = cluster.masterValue

      // Build SQL query to fetch records grouped by value
      const quotedValues = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')
      const quotedMaster = masterValue.replace(/'/g, "''")

      const sql = `
        SELECT * FROM "${tableName}"
        WHERE "${columnName}" IN (${quotedValues})
        ORDER BY
          CASE "${columnName}" WHEN '${quotedMaster}' THEN 0 ELSE 1 END,
          "${columnName}",
          "_cs_id"
        LIMIT 100
      `

      const result = await conn.query(sql)
      const rows = result.toArray().map((row: Record<string, unknown>) => {
        const obj: Record<string, unknown> = {}
        for (const key of Object.keys(row)) {
          obj[key] = row[key]
        }
        return obj
      })

      setPreviewRecords(rows)
    } catch (error) {
      console.error('Failed to fetch preview records:', error)
      setPreviewRecords([])
    } finally {
      setPreviewLoading(false)
    }
  }, [cluster, tableName, columnName, setPreviewRecords, setPreviewLoading])

  // Fetch records when drawer opens or cluster changes
  useEffect(() => {
    if (open && cluster) {
      fetchRecords()
    }
  }, [open, cluster, fetchRecords])

  // Reset expanded state when drawer closes
  useEffect(() => {
    if (!open) {
      setIsExpanded(false)
    }
  }, [open])

  // Derived values - must be before early return to maintain hooks order
  const masterValue = cluster?.masterValue ?? ''
  const visibleColumns = columns.filter((col) => col.name !== '_cs_id')

  // Group records by value for visual separation - must be before early return
  const groupedRecords = useMemo(() => {
    if (!previewRecords || !columnName || !cluster) return []

    const groups: { value: string; isMaster: boolean; records: Record<string, unknown>[] }[] = []
    let currentGroup: typeof groups[0] | null = null

    for (const record of previewRecords) {
      const recordValue = String(record[columnName] ?? '')
      const isMaster = recordValue === masterValue

      if (!currentGroup || currentGroup.value !== recordValue) {
        currentGroup = { value: recordValue, isMaster, records: [] }
        groups.push(currentGroup)
      }
      currentGroup.records.push(record)
    }

    return groups
  }, [previewRecords, columnName, masterValue, cluster])

  // Early return AFTER all hooks
  if (!open || !cluster) return null

  const height = isExpanded ? 400 : 200

  return (
    <div
      className={cn(
        'border-t border-border bg-card transition-all duration-200 shrink-0',
        'animate-in slide-in-from-bottom-2 duration-150'
      )}
      style={{ height }}
      data-testid="record-preview-drawer"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-10 border-b border-border bg-muted/30">
        <div className="flex items-center gap-3">
          <div className="p-1 rounded bg-muted">
            <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <span className="text-sm font-medium text-foreground">
            {masterValue || '(empty)'}
          </span>
          {previewLoading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          {!previewLoading && previewRecords && (
            <Badge variant="secondary" className="text-xs tabular-nums bg-muted border-0">
              {previewRecords.length} rows
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid="toggle-preview-expand"
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            data-testid="close-preview-drawer"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="h-[calc(100%-40px)]">
        {previewLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading records...</span>
            </div>
          </div>
        ) : previewRecords && previewRecords.length > 0 ? (
          <Table>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow className="hover:bg-muted border-b border-border">
                {visibleColumns.map((col) => {
                  const isTargetColumn = col.name === columnName
                  return (
                    <TableHead
                      key={col.name}
                      className={cn(
                        'h-9 text-xs whitespace-nowrap',
                        isTargetColumn && 'bg-primary/10 text-primary'
                      )}
                    >
                      {col.name}
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedRecords.map((group, groupIndex) => (
                group.records.map((row, rowIndex) => {
                  const isFirstInGroup = rowIndex === 0 && groupIndex > 0

                  return (
                    <TableRow
                      key={`row-${groupIndex}-${rowIndex}`}
                      className={cn(
                        'border-b border-border/50',
                        group.isMaster
                          ? 'bg-amber-950/30 hover:bg-amber-950/40'
                          : 'hover:bg-muted/50',
                        isFirstInGroup && 'border-t-2 border-t-border'
                      )}
                    >
                      {visibleColumns.map((col) => {
                        const cellValue = row[col.name]
                        const displayValue = cellValue == null ? '' : String(cellValue)
                        const isTargetColumn = col.name === columnName

                        return (
                          <TableCell
                            key={col.name}
                            className={cn(
                              'py-2 text-sm whitespace-nowrap max-w-[200px] truncate',
                              isTargetColumn && 'font-medium',
                              isTargetColumn && group.isMaster && 'text-amber-500'
                            )}
                            title={displayValue}
                          >
                            <div className="flex items-center gap-1.5">
                              {isTargetColumn && group.isMaster && rowIndex === 0 && (
                                <Star className="h-3 w-3 text-amber-500 fill-amber-500/30 shrink-0" />
                              )}
                              <span className="truncate">{displayValue}</span>
                            </div>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Table2 className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm">No records found</p>
          </div>
        )}
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}
