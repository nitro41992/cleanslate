import { useCallback, useMemo, useEffect, useState, useRef } from 'react'
import DataGridLib, {
  GridColumn,
  GridCellKind,
  Item,
  GetRowThemeCallback,
  DrawCellCallback,
  Rectangle,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchDiffPage, getModifiedColumns, type DiffRow } from '@/lib/diff-engine'

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

    const observer = new ResizeObserver(() => {
      updateSize()
    })

    observer.observe(element)
    updateSize()
    const timeoutId = setTimeout(updateSize, 100)

    return () => {
      observer.disconnect()
      clearTimeout(timeoutId)
    }
  }, [ref])

  return size
}

interface VirtualizedDiffGridProps {
  diffTableName: string
  totalRows: number
  allColumns: string[]
  keyColumns: string[]
  keyOrderBy: string
  blindMode?: boolean
  newColumns?: string[]      // Columns added (in current but not original)
  removedColumns?: string[]  // Columns removed (in original but not current)
}

const PAGE_SIZE = 500

export function VirtualizedDiffGrid({
  diffTableName,
  totalRows,
  allColumns,
  keyColumns,
  keyOrderBy,
  blindMode = false,
  newColumns = [],
  removedColumns = [],
}: VirtualizedDiffGridProps) {
  const [data, setData] = useState<DiffRow[]>([])
  const [loadedRange, setLoadedRange] = useState({ start: 0, end: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const containerSize = useContainerSize(containerRef)

  // Build grid columns: Status (if not blind mode) + all data columns
  const gridColumns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = []

    if (!blindMode) {
      cols.push({
        id: '_status',
        title: 'Status',
        width: 100,
      })
    }

    // Add columns for the actual data
    // Each column shows A→B for modified, or the value for added/removed
    for (const col of allColumns) {
      // Build column title with badges for key/new/removed status
      let title = col
      const badges: string[] = []
      if (keyColumns.includes(col)) badges.push('KEY')
      if (newColumns.includes(col)) badges.push('+NEW')
      if (removedColumns.includes(col)) badges.push('-DEL')
      if (badges.length > 0) {
        title = `${col} (${badges.join(', ')})`
      }

      cols.push({
        id: col,
        title,
        width: 180,
      })
    }

    return cols
  }, [allColumns, keyColumns, newColumns, removedColumns, blindMode])

  // Load initial data
  useEffect(() => {
    if (!diffTableName || totalRows === 0) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setData([])
    setLoadedRange({ start: 0, end: 0 })

    fetchDiffPage(diffTableName, 0, PAGE_SIZE, keyOrderBy)
      .then((rows) => {
        setData(rows)
        setLoadedRange({ start: 0, end: rows.length })
        setIsLoading(false)
      })
      .catch((err) => {
        console.error('Error loading diff data:', err)
        setIsLoading(false)
      })
  }, [diffTableName, totalRows, keyOrderBy])

  // Load more data on scroll
  const onVisibleRegionChanged = useCallback(
    async (range: Rectangle) => {
      if (!diffTableName || totalRows === 0) return

      const needStart = Math.max(0, range.y - PAGE_SIZE)
      const needEnd = Math.min(totalRows, range.y + range.height + PAGE_SIZE)

      if (needStart < loadedRange.start || needEnd > loadedRange.end) {
        try {
          const newData = await fetchDiffPage(diffTableName, needStart, needEnd - needStart, keyOrderBy)
          setData(newData)
          setLoadedRange({ start: needStart, end: needStart + newData.length })
        } catch (err) {
          console.error('Error loading diff page:', err)
        }
      }
    },
    [diffTableName, totalRows, keyOrderBy, loadedRange]
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

      // Handle status column (first column if not in blind mode)
      const colIndex = blindMode ? col : col - 1
      if (!blindMode && col === 0) {
        const status = rowData.diff_status
        const statusText = status === 'added' ? '+ ADDED' :
                          status === 'removed' ? '- REMOVED' :
                          status === 'modified' ? '~ MODIFIED' : ''
        return {
          kind: GridCellKind.Text as const,
          data: statusText,
          displayData: statusText,
          allowOverlay: false,
          readonly: true,
        }
      }

      // Get the column name (accounting for status column offset)
      const colName = allColumns[colIndex]
      if (!colName) {
        return {
          kind: GridCellKind.Text as const,
          data: '',
          displayData: '',
          allowOverlay: false,
          readonly: true,
        }
      }

      const status = rowData.diff_status
      const valA = rowData[`a_${colName}`]
      const valB = rowData[`b_${colName}`]
      const strA = valA === null || valA === undefined ? '' : String(valA)
      const strB = valB === null || valB === undefined ? '' : String(valB)

      let displayValue: string
      if (status === 'added') {
        displayValue = strB
      } else if (status === 'removed') {
        displayValue = strA
      } else {
        // Modified or unchanged - show A→B for modified columns
        const modifiedCols = getModifiedColumns(rowData, allColumns, keyColumns, newColumns, removedColumns)
        if (modifiedCols.includes(colName)) {
          displayValue = `${strA} → ${strB}`
        } else {
          displayValue = strA
        }
      }

      return {
        kind: GridCellKind.Text as const,
        data: displayValue,
        displayData: displayValue,
        allowOverlay: true,
        readonly: true,
      }
    },
    [data, allColumns, keyColumns, newColumns, removedColumns, loadedRange.start, blindMode]
  )

  // Custom cell drawing for modified cells (show A→B with styling)
  const drawCell: DrawCellCallback = useCallback(
    (args, draw) => {
      const { col, row, rect, ctx } = args
      const adjustedRow = row - loadedRange.start
      const rowData = data[adjustedRow]

      if (!rowData || blindMode) {
        draw()
        return
      }

      // Handle status column styling
      if (col === 0) {
        draw()

        // Add color indicator to status cell
        const status = rowData.diff_status
        ctx.save()
        ctx.fillStyle = status === 'added' ? '#22c55e' :
                        status === 'removed' ? '#ef4444' :
                        status === 'modified' ? '#eab308' : '#6b7280'
        ctx.fillRect(rect.x, rect.y, 4, rect.height)
        ctx.restore()
        return
      }

      const colIndex = col - 1
      const colName = allColumns[colIndex]
      const status = rowData.diff_status

      // Check if this specific column was modified
      const modifiedCols = getModifiedColumns(rowData, allColumns, keyColumns, newColumns, removedColumns)
      const isModified = status === 'modified' && modifiedCols.includes(colName)

      if (isModified) {
        // Custom draw for modified cells: strikethrough old value + arrow + new value
        const valA = rowData[`a_${colName}`]
        const valB = rowData[`b_${colName}`]
        const strA = valA === null || valA === undefined ? '' : String(valA)
        const strB = valB === null || valB === undefined ? '' : String(valB)

        // Clear background with modified highlight
        ctx.save()
        ctx.fillStyle = 'rgba(234, 179, 8, 0.1)'
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

        // Draw text
        ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        const y = rect.y + rect.height / 2
        let x = rect.x + 8

        // Old value (with strikethrough)
        ctx.fillStyle = 'rgba(232, 230, 227, 0.5)'
        ctx.fillText(strA, x, y)
        const oldWidth = ctx.measureText(strA).width

        // Strikethrough line
        ctx.strokeStyle = 'rgba(232, 230, 227, 0.5)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + oldWidth, y)
        ctx.stroke()

        x += oldWidth + 4

        // Arrow
        ctx.fillStyle = '#8b8d93'
        ctx.fillText('→', x, y)
        x += ctx.measureText('→').width + 4

        // New value (highlighted)
        ctx.fillStyle = '#eab308'
        ctx.fillText(strB, x, y)

        ctx.restore()
      } else {
        draw()
      }
    },
    [data, allColumns, keyColumns, newColumns, removedColumns, loadedRange.start, blindMode]
  )

  // Row theme based on diff status
  const getRowThemeOverride: GetRowThemeCallback = useCallback(
    (row: number) => {
      if (blindMode) return undefined

      const adjustedRow = row - loadedRange.start
      const rowData = data[adjustedRow]
      if (!rowData) return undefined

      const status = rowData.diff_status
      if (status === 'added') {
        return { bgCell: 'rgba(34, 197, 94, 0.12)' }
      }
      if (status === 'removed') {
        return { bgCell: 'rgba(239, 68, 68, 0.12)' }
      }
      if (status === 'modified') {
        return { bgCell: 'rgba(234, 179, 8, 0.08)' }
      }
      return undefined
    },
    [data, loadedRange.start, blindMode]
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

  if (totalRows === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
          <span className="text-2xl">✓</span>
        </div>
        <p className="font-medium">No differences found</p>
        <p className="text-sm mt-1">The tables are identical</p>
      </div>
    )
  }

  const gridWidth = containerSize.width || 800
  const gridHeight = containerSize.height || 500

  return (
    <div ref={containerRef} className="h-full w-full gdg-container min-h-[400px]" data-testid="diff-grid">
      {data.length > 0 && (
        <DataGridLib
          columns={gridColumns}
          rows={totalRows}
          getCellContent={getCellContent}
          onVisibleRegionChanged={onVisibleRegionChanged}
          getRowThemeOverride={getRowThemeOverride}
          drawCell={drawCell}
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
