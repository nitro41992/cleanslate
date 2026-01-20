import { useCallback, useMemo, useEffect, useState } from 'react'
import DataGridLib, {
  GridColumn,
  GridCellKind,
  Item,
  GetRowThemeCallback,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useDuckDB } from '@/hooks/useDuckDB'
import { Skeleton } from '@/components/ui/skeleton'

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

  return (
    <div className="h-full w-full gdg-container">
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
        smoothScrollX
        smoothScrollY
        theme={{
          bgCell: 'hsl(220, 14%, 11%)',
          bgCellMedium: 'hsl(220, 12%, 18%)',
          bgHeader: 'hsl(220, 12%, 14%)',
          bgHeaderHasFocus: 'hsl(35, 50%, 18%)',
          bgHeaderHovered: 'hsl(220, 12%, 16%)',
          textDark: 'hsl(40, 15%, 90%)',
          textMedium: 'hsl(220, 10%, 55%)',
          textLight: 'hsl(220, 10%, 55%)',
          textHeader: 'hsl(40, 15%, 90%)',
          borderColor: 'hsl(220, 12%, 20%)',
          accentColor: 'hsl(35, 90%, 55%)',
          accentFg: 'hsl(220, 15%, 8%)',
          accentLight: 'hsl(35, 50%, 18%)',
          linkColor: 'hsl(35, 90%, 55%)',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      />
    </div>
  )
}
