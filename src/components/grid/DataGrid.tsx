import { useCallback, useMemo, useEffect, useState, useRef } from 'react'
import DataGridLib, {
  GridColumn,
  GridCellKind,
  Item,
  GetRowThemeCallback,
  EditableGridCell,
  DrawCellCallback,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useDuckDB } from '@/hooks/useDuckDB'
import { Skeleton } from '@/components/ui/skeleton'
import { useEditStore } from '@/stores/editStore'
import { useAuditStore } from '@/stores/auditStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { updateCell, createOriginalSnapshot } from '@/lib/duckdb'
import { recordCommand, initializeTimeline } from '@/lib/timeline-engine'
import type { TimelineHighlight, ManualEditParams } from '@/types'

function useContainerSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height })
      }
    }

    // Use ResizeObserver for updates
    const observer = new ResizeObserver(() => {
      updateSize()
    })

    observer.observe(element)

    // Initial measurement with slight delay to ensure layout is complete
    updateSize()
    const timeoutId = setTimeout(updateSize, 100)

    return () => {
      observer.disconnect()
      clearTimeout(timeoutId)
    }
  }, [ref])

  return size
}

interface DataGridProps {
  tableName: string
  rowCount: number
  columns: string[]
  highlightedRows?: Map<number, 'added' | 'removed' | 'modified'>
  highlightedCells?: Map<string, boolean>
  onCellClick?: (col: number, row: number) => void
  editable?: boolean
  tableId?: string
  // Timeline-based highlighting (uses _cs_id for row identification)
  timelineHighlight?: TimelineHighlight | null
  // Ghost rows for showing deleted items
  ghostRows?: Array<{ csId: string; data: Record<string, unknown> }>
  // Triggers grid refresh when incremented (for undo/redo)
  dataVersion?: number
}

const PAGE_SIZE = 500

export function DataGrid({
  tableName,
  rowCount,
  columns,
  highlightedRows,
  highlightedCells: _highlightedCells,
  onCellClick,
  editable = false,
  tableId,
  timelineHighlight,
  ghostRows: _ghostRows = [],
  dataVersion,
}: DataGridProps) {
  const { getData, getDataWithRowIds } = useDuckDB()
  const [data, setData] = useState<Record<string, unknown>[]>([])
  // Map of _cs_id -> row index in current loaded data (for timeline highlighting)
  const [csIdToRowIndex, setCsIdToRowIndex] = useState<Map<string, number>>(new Map())
  const [loadedRange, setLoadedRange] = useState({ start: 0, end: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const containerSize = useContainerSize(containerRef)

  // Timeline store for highlight state and replay status
  const storeHighlight = useTimelineStore((s) => s.highlight)
  const isReplaying = useTimelineStore((s) => s.isReplaying)
  // Use prop if provided, otherwise fall back to store
  const activeHighlight = timelineHighlight ?? (storeHighlight.commandId ? storeHighlight : null)

  // Edit store for tracking edits (legacy)
  const recordEdit = useEditStore((s) => s.recordEdit)

  // Timeline-based dirty cell tracking (replaces editStore.isDirty)
  const getDirtyCellsAtPosition = useTimelineStore((s) => s.getDirtyCellsAtPosition)
  const timelinePosition = useTimelineStore((s) => {
    if (!tableId) return -1
    return s.timelines.get(tableId)?.currentPosition ?? -1
  })

  // Compute dirty cells set based on timeline position
  // This re-computes when position changes (undo/redo)
  // Note: timelinePosition is intentionally included to trigger recomputation
  const dirtyCells = useMemo(
    () => {
      if (!tableId) return new Set<string>()
      return getDirtyCellsAtPosition(tableId)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableId, getDirtyCellsAtPosition, timelinePosition]
  )

  // Audit store for logging edits
  const addManualEditEntry = useAuditStore((s) => s.addManualEditEntry)

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((col) => ({
        id: col,
        title: col,
        width: 150,
      })),
    [columns]
  )

  // Load initial data (re-runs when rowCount changes, e.g., after merge operations)
  useEffect(() => {
    console.log('[DATAGRID] useEffect triggered', { tableName, columnCount: columns.length, rowCount, dataVersion, isReplaying })
    if (!tableName || columns.length === 0) {
      console.log('[DATAGRID] Early return - no tableName or columns')
      return
    }

    // Don't fetch during replay - table might be in inconsistent state
    if (isReplaying) {
      console.log('[DATAGRID] Skipping fetch - replay in progress')
      return
    }

    console.log('[DATAGRID] Starting data reload...')
    setIsLoading(true)
    setData([]) // Clear stale data immediately
    setLoadedRange({ start: 0, end: 0 }) // Reset loaded range
    setCsIdToRowIndex(new Map()) // Reset row ID mapping

    // Load data with row IDs for timeline highlighting
    getDataWithRowIds(tableName, 0, PAGE_SIZE)
      .then((rowsWithIds) => {
        console.log('[DATAGRID] Data fetched, row count:', rowsWithIds.length)
        // Build _cs_id -> row index map
        const idMap = new Map<string, number>()
        const rows = rowsWithIds.map((row, index) => {
          if (row.csId) {
            idMap.set(row.csId, index)
          }
          return row.data
        })

        // Log first row for debugging
        if (rows.length > 0) {
          console.log('[DATAGRID] First row sample:', rows[0])
        }

        setData(rows)
        setCsIdToRowIndex(idMap)
        setLoadedRange({ start: 0, end: rows.length })
        setIsLoading(false)
      })
      .catch((err) => {
        console.error('Error loading data:', err)
        // Fallback to regular getData if getDataWithRowIds fails
        getData(tableName, 0, PAGE_SIZE)
          .then((rows) => {
            setData(rows)
            setLoadedRange({ start: 0, end: rows.length })
            setIsLoading(false)
          })
          .catch((fallbackErr) => {
            console.error('Error loading fallback data:', fallbackErr)
            setIsLoading(false)
          })
      })
  }, [tableName, columns, getData, getDataWithRowIds, rowCount, dataVersion, isReplaying])

  // Load more data on scroll (with row ID tracking for timeline highlighting)
  const onVisibleRegionChanged = useCallback(
    async (range: { x: number; y: number; width: number; height: number }) => {
      const needStart = Math.max(0, range.y - PAGE_SIZE)
      const needEnd = Math.min(rowCount, range.y + range.height + PAGE_SIZE)

      if (needStart < loadedRange.start || needEnd > loadedRange.end) {
        try {
          const rowsWithIds = await getDataWithRowIds(tableName, needStart, needEnd - needStart)
          const idMap = new Map<string, number>()
          const rows = rowsWithIds.map((row: { csId: string; data: Record<string, unknown> }, index: number) => {
            if (row.csId) {
              idMap.set(row.csId, needStart + index)
            }
            return row.data
          })
          setData(rows)
          setCsIdToRowIndex(idMap)
          setLoadedRange({ start: needStart, end: needStart + rows.length })
        } catch {
          // Fallback to regular getData
          const newData = await getData(tableName, needStart, needEnd - needStart)
          setData(newData)
          setLoadedRange({ start: needStart, end: needStart + newData.length })
        }
      }
    },
    [getData, getDataWithRowIds, tableName, rowCount, loadedRange]
  )

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const adjustedRow = row - loadedRange.start
      const rowData = data[adjustedRow]

      if (!rowData) {
        return {
          kind: GridCellKind.Loading as const,
          allowOverlay: false,
        }
      }

      const colName = columns[col]
      const value = rowData[colName]

      return {
        kind: GridCellKind.Text as const,
        data: value === null || value === undefined ? '' : String(value),
        displayData: value === null || value === undefined ? '' : String(value),
        allowOverlay: true,
        readonly: !editable,
      }
    },
    [data, columns, loadedRange.start, editable]
  )

  // Handle cell edits
  const onCellEdited = useCallback(
    async ([col, row]: Item, newValue: EditableGridCell) => {
      if (!editable || !tableId) return

      const colName = columns[col]
      const adjustedRow = row - loadedRange.start
      const rowData = data[adjustedRow]
      const previousValue = rowData?.[colName]

      // Get the new value from the cell
      let newCellValue: unknown
      if (newValue.kind === GridCellKind.Text) {
        newCellValue = newValue.data
      } else {
        return // Only handle text cells for now
      }

      // Skip if value hasn't changed
      if (previousValue === newCellValue) return

      try {
        // IMPORTANT: Initialize timeline BEFORE modifying data
        // This ensures the original snapshot captures the pre-modification state
        console.log('[DATAGRID] Initializing timeline before cell edit...')
        await initializeTimeline(tableId, tableName)

        // Create original snapshot before first edit (for "Compare with Preview")
        await createOriginalSnapshot(tableName)

        // Update DuckDB and get the row's _cs_id
        console.log('[DATAGRID] Updating cell in DuckDB...')
        const result = await updateCell(tableName, row, colName, newCellValue)
        console.log('[DATAGRID] Cell updated, csId:', result.csId)
        const csId = result.csId

        // Update local data state
        setData((prevData) => {
          const newData = [...prevData]
          if (newData[adjustedRow]) {
            newData[adjustedRow] = {
              ...newData[adjustedRow],
              [colName]: newCellValue,
            }
          }
          return newData
        })

        // Record the edit for undo/redo (legacy editStore)
        recordEdit({
          tableId,
          tableName,
          rowIndex: row,
          columnName: colName,
          previousValue,
          newValue: newCellValue,
          timestamp: new Date(),
        })

        // Log to audit and get the auditEntryId for timeline linkage
        const auditEntryId = addManualEditEntry({
          tableId,
          tableName,
          rowIndex: row,
          columnName: colName,
          previousValue,
          newValue: newCellValue,
        })

        // Record to timeline for unified undo/redo (if we have a csId)
        if (csId) {
          const timelineParams: ManualEditParams = {
            type: 'manual_edit',
            csId,
            columnName: colName,
            previousValue,
            newValue: newCellValue,
          }

          await recordCommand(
            tableId,
            tableName,
            'manual_edit',
            `Edit cell [${row}, ${colName}]`,
            timelineParams,
            {
              auditEntryId, // Link timeline command to audit entry
              affectedRowIds: [csId],
              affectedColumns: [colName],
              cellChanges: [{
                csId,
                columnName: colName,
                previousValue,
                newValue: newCellValue,
              }],
              rowsAffected: 1,
            }
          )
        }
      } catch (error) {
        console.error('Failed to update cell:', error)
      }
    },
    [editable, tableId, tableName, columns, loadedRange.start, data, recordEdit, addManualEditEntry]
  )

  // Compute reverse map: row index -> csId for the loaded range
  const rowIndexToCsId = useMemo(() => {
    const map = new Map<number, string>()
    for (const [csId, rowIndex] of csIdToRowIndex) {
      map.set(rowIndex, csId)
    }
    return map
  }, [csIdToRowIndex])

  // Custom cell drawing to show dirty indicator and timeline highlights
  const drawCell: DrawCellCallback = useCallback(
    (args, draw) => {
      const { col, row, rect, ctx } = args
      const colName = columns[col]

      // Get csId for this row (used for both highlighting and dirty tracking)
      const csId = rowIndexToCsId.get(row)
      const cellKey = csId ? `${csId}:${colName}` : null

      // Check for timeline cell highlight (yellow background for highlighted cells)
      const isCellHighlighted = activeHighlight?.cellKeys?.has(cellKey ?? '') ?? false
      // Check for column highlight (when entire column is affected, e.g., standardization)
      const isColumnHighlighted = activeHighlight?.diffMode === 'column' &&
        activeHighlight?.highlightedColumns?.has(colName)

      if (isCellHighlighted || isColumnHighlighted) {
        // Draw yellow highlight background before the cell content
        ctx.save()
        ctx.fillStyle = 'rgba(234, 179, 8, 0.25)' // yellow-500 with opacity
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
        ctx.restore()
      }

      // Draw the default cell
      draw()

      // Then overlay the dirty indicator if applicable
      // Uses timeline-based tracking: cell is dirty if there's a manual_edit
      // command that modified it AND we're at/past that command's position
      const isCellDirty = cellKey && dirtyCells.has(cellKey)
      if (editable && isCellDirty) {
        // Save canvas state before modifying
        ctx.save()

        // Draw a small red triangle in the top-right corner
        const triangleSize = 8
        ctx.beginPath()
        ctx.moveTo(rect.x + rect.width - triangleSize, rect.y)
        ctx.lineTo(rect.x + rect.width, rect.y)
        ctx.lineTo(rect.x + rect.width, rect.y + triangleSize)
        ctx.closePath()
        ctx.fillStyle = '#ef4444' // red-500
        ctx.fill()

        // Restore canvas state to prevent affecting other cells
        ctx.restore()
      }
    },
    [editable, columns, dirtyCells, rowIndexToCsId, activeHighlight]
  )

  const getRowThemeOverride: GetRowThemeCallback = useCallback(
    (row: number) => {
      // Check for traditional highlightedRows (diff view)
      if (highlightedRows) {
        const status = highlightedRows.get(row)
        if (status === 'added') {
          return { bgCell: 'rgba(34, 197, 94, 0.15)' }
        }
        if (status === 'removed') {
          return { bgCell: 'rgba(239, 68, 68, 0.15)' }
        }
        if (status === 'modified') {
          return { bgCell: 'rgba(234, 179, 8, 0.1)' }
        }
      }

      // Check for timeline-based row highlight (uses _cs_id)
      if (activeHighlight && activeHighlight.rowIds.size > 0) {
        const csId = rowIndexToCsId.get(row)
        if (csId && activeHighlight.rowIds.has(csId)) {
          // Different highlight based on diff mode
          if (activeHighlight.diffMode === 'row') {
            return { bgCell: 'rgba(59, 130, 246, 0.15)' } // blue for row highlight
          }
          // For cell mode, we rely on drawCell for cell-level highlights
        }
      }

      return undefined
    },
    [highlightedRows, activeHighlight, rowIndexToCsId]
  )

  if (isLoading) {
    return (
      <div className="h-full w-full p-4 space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  if (columns.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        No data to display
      </div>
    )
  }

  // Use container size or fallback to reasonable defaults
  const gridWidth = containerSize.width || 800
  const gridHeight = containerSize.height || 500

  return (
    <div ref={containerRef} className="h-full w-full gdg-container min-h-[400px]" data-testid="data-grid">
      {data.length > 0 && (
        <DataGridLib
          columns={gridColumns}
          rows={rowCount}
          getCellContent={getCellContent}
          onVisibleRegionChanged={onVisibleRegionChanged}
          getRowThemeOverride={getRowThemeOverride}
          onCellClicked={
            onCellClick
              ? ([col, row]) => onCellClick(col, row)
              : undefined
          }
          onCellEdited={editable ? onCellEdited : undefined}
          drawCell={editable ? drawCell : undefined}
          width={gridWidth}
          height={gridHeight}
          smoothScrollX
          smoothScrollY
          theme={{
            bgCell: '#18191c',
            bgCellMedium: '#28292d',
            bgHeader: '#1f2024',
            bgHeaderHasFocus: '#3d3020',
            bgHeaderHovered: '#252629',
            textDark: '#e8e6e3',
            textMedium: '#8b8d93',
            textLight: '#8b8d93',
            textHeader: '#e8e6e3',
            borderColor: '#2d2e33',
            accentColor: '#e09520',
            accentFg: '#141517',
            accentLight: '#3d3020',
            linkColor: '#e09520',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            baseFontStyle: '13px',
            headerFontStyle: '600 13px',
            editorFontSize: '13px',
          }}
        />
      )}
    </div>
  )
}
