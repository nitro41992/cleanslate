import { useCallback, useMemo, useEffect, useState, useRef } from 'react'
import DataGridLib, {
  GridColumn,
  GridCellKind,
  Item,
  GetRowThemeCallback,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useDuckDB } from '@/hooks/useDuckDB'
import { Skeleton } from '@/components/ui/skeleton'

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
}

const PAGE_SIZE = 500

export function DataGrid({
  tableName,
  rowCount,
  columns,
  highlightedRows,
  highlightedCells: _highlightedCells,
  onCellClick,
}: DataGridProps) {
  const { getData } = useDuckDB()
  const [data, setData] = useState<Record<string, unknown>[]>([])
  const [loadedRange, setLoadedRange] = useState({ start: 0, end: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const containerSize = useContainerSize(containerRef)

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((col) => ({
        id: col,
        title: col,
        width: 150,
      })),
    [columns]
  )

  // Load initial data
  useEffect(() => {
    if (!tableName || columns.length === 0) return

    setIsLoading(true)
    getData(tableName, 0, PAGE_SIZE)
      .then((rows) => {
        setData(rows)
        setLoadedRange({ start: 0, end: rows.length })
        setIsLoading(false)
      })
      .catch((err) => {
        console.error('Error loading data:', err)
        setIsLoading(false)
      })
  }, [tableName, columns, getData])

  // Load more data on scroll
  const onVisibleRegionChanged = useCallback(
    async (range: { x: number; y: number; width: number; height: number }) => {
      const needStart = Math.max(0, range.y - PAGE_SIZE)
      const needEnd = Math.min(rowCount, range.y + range.height + PAGE_SIZE)

      if (needStart < loadedRange.start || needEnd > loadedRange.end) {
        const newData = await getData(tableName, needStart, needEnd - needStart)
        setData(newData)
        setLoadedRange({ start: needStart, end: needStart + newData.length })
      }
    },
    [getData, tableName, rowCount, loadedRange]
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
        readonly: true,
      }
    },
    [data, columns, loadedRange.start]
  )

  const getRowThemeOverride: GetRowThemeCallback = useCallback(
    (row: number) => {
      if (!highlightedRows) return undefined
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
      return undefined
    },
    [highlightedRows]
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
    <div ref={containerRef} className="h-full w-full gdg-container min-h-[400px]">
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
