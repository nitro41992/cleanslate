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
import { fetchDiffPage, type DiffRow } from '@/lib/diff-engine'

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
  sourceTableName: string
  targetTableName: string
  totalRows: number
  allColumns: string[]
  keyColumns: string[]
  keyOrderBy: string
  blindMode?: boolean
  /** Columns in A (original) but not B (current) - from diff engine's perspective */
  newColumns?: string[]
  /** Columns in B (current) but not A (original) - from diff engine's perspective */
  removedColumns?: string[]
  storageType?: 'memory' | 'parquet'
}

const PAGE_SIZE = 500

export function VirtualizedDiffGrid({
  diffTableName,
  sourceTableName,
  targetTableName,
  totalRows,
  allColumns,
  keyColumns,
  keyOrderBy,
  blindMode = false,
  newColumns = [],
  removedColumns = [],
  storageType = 'memory',
}: VirtualizedDiffGridProps) {
  const [data, setData] = useState<DiffRow[]>([])
  const [loadedRange, setLoadedRange] = useState({ start: 0, end: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const containerSize = useContainerSize(containerRef)
  // Prevent concurrent fetch requests during rapid scrolling
  const fetchLockRef = useRef(false)

  // IMPORTANT: Perspective swap for display
  // The diff engine computes columns from tableA's perspective where A=original, B=current:
  //   newColumns     = Set(A) - Set(B) = columns in original not current = USER's REMOVED columns
  //   removedColumns = Set(B) - Set(A) = columns in current not original = USER's NEW columns
  //
  // We swap the names here to match user expectations in the UI:
  const userNewColumns = removedColumns    // columns added to current (e.g., 'age' from Calculate Age)
  const userRemovedColumns = newColumns    // columns removed from current

  // Pre-compute Sets for O(1) lookups (performance optimization)
  const keyColumnsSet = useMemo(() => new Set(keyColumns), [keyColumns])
  const userNewColumnsSet = useMemo(() => new Set(userNewColumns), [userNewColumns])
  const userRemovedColumnsSet = useMemo(() => new Set(userRemovedColumns), [userRemovedColumns])

  // Pre-compute modified columns for all loaded rows (performance optimization)
  // This replaces ~60,000 per-cell getModifiedColumns() calls with O(1) lookups
  const modifiedColumnsCache = useMemo(() => {
    const cache = new Map<string, Set<string>>()
    for (const row of data) {
      if (row.diff_status === 'modified') {
        const modCols = new Set<string>()
        for (const col of allColumns) {
          // Skip key columns and new/removed columns
          if (keyColumnsSet.has(col) || userNewColumnsSet.has(col) || userRemovedColumnsSet.has(col)) continue
          const valA = row[`a_${col}`]
          const valB = row[`b_${col}`]
          if (String(valA ?? '') !== String(valB ?? '')) {
            modCols.add(col)
          }
        }
        cache.set(row.row_id as string, modCols)
      }
    }
    return cache
  }, [data, allColumns, keyColumnsSet, userNewColumnsSet, userRemovedColumnsSet])

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
      // Use user perspective for badges (swapped from engine perspective)
      let title = col
      const badges: string[] = []
      if (keyColumns.includes(col)) badges.push('KEY')
      if (userNewColumns.includes(col)) badges.push('+NEW')
      if (userRemovedColumns.includes(col)) badges.push('-DEL')
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
  }, [allColumns, keyColumns, userNewColumns, userRemovedColumns, blindMode])

  // Load initial data
  useEffect(() => {
    if (!diffTableName || totalRows === 0) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setData([])
    setLoadedRange({ start: 0, end: 0 })

    fetchDiffPage(diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, 0, PAGE_SIZE, keyOrderBy, storageType)
      .then((rows) => {
        setData(rows)
        setLoadedRange({ start: 0, end: rows.length })
        setIsLoading(false)
      })
      .catch((err) => {
        console.error('Error loading diff data:', err)
        setIsLoading(false)
      })
  }, [diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, totalRows, keyOrderBy, storageType])

  // Load more data on scroll
  const onVisibleRegionChanged = useCallback(
    async (range: Rectangle) => {
      if (!diffTableName || totalRows === 0) return

      // Skip if a fetch is already in progress (prevents concurrent requests during rapid scroll)
      if (fetchLockRef.current) return

      const needStart = Math.max(0, range.y - PAGE_SIZE)
      const needEnd = Math.min(totalRows, range.y + range.height + PAGE_SIZE)

      if (needStart < loadedRange.start || needEnd > loadedRange.end) {
        fetchLockRef.current = true
        try {
          const newData = await fetchDiffPage(diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, needStart, needEnd - needStart, keyOrderBy, storageType)
          setData(newData)
          setLoadedRange({ start: needStart, end: needStart + newData.length })
        } catch (err) {
          console.error('Error loading diff page:', err)
        } finally {
          fetchLockRef.current = false
        }
      }
    },
    [diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, totalRows, keyOrderBy, storageType, loadedRange]
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
      // A = original/source, B = current/target
      const valA = rowData[`a_${colName}`]
      const valB = rowData[`b_${colName}`]
      const strA = valA === null || valA === undefined ? '' : String(valA)
      const strB = valB === null || valB === undefined ? '' : String(valB)

      let displayValue: string
      if (status === 'added') {
        // Row exists in B (current) only - show current value
        displayValue = strB
      } else if (status === 'removed') {
        // Row exists in A (original) only - show original value
        displayValue = strA
      } else if (userNewColumnsSet.has(colName)) {
        // New column (in B/current) - show current value (this is added data)
        displayValue = strB
      } else if (userRemovedColumnsSet.has(colName)) {
        // Removed column (in A/original) - show original value (this is removed data)
        displayValue = strA
      } else {
        // Modified or unchanged - show A→B for modified columns
        // Use cached modified columns for O(1) lookup
        const rowModifiedCols = modifiedColumnsCache.get(rowData.row_id as string)
        if (rowModifiedCols?.has(colName)) {
          displayValue = `${strA} → ${strB}`
        } else {
          // Show current value for unchanged columns
          displayValue = strB
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
    [data, allColumns, userNewColumnsSet, userRemovedColumnsSet, loadedRange.start, blindMode, modifiedColumnsCache]
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

      // Use user perspective for column classification (O(1) Set lookups)
      // userNewColumns = columns added to current (in B)
      // userRemovedColumns = columns removed from current (in A only)
      const isUserNewColumn = userNewColumnsSet.has(colName)
      const isUserRemovedColumn = userRemovedColumnsSet.has(colName)
      // Check if this specific column was modified (use cached modified columns)
      const rowModifiedCols = modifiedColumnsCache.get(rowData.row_id as string)
      const isModified = status === 'modified' && (rowModifiedCols?.has(colName) ?? false)

      // Handle new columns (in B/current) - show with green styling
      if (isUserNewColumn && status !== 'removed') {
        // New columns are in B (current), so show strB
        const valB = rowData[`b_${colName}`]
        const strB = valB === null || valB === undefined ? '' : String(valB)

        // Clear background with green highlight (added data)
        ctx.save()
        ctx.fillStyle = 'rgba(34, 197, 94, 0.15)'
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

        // Draw text
        ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#22c55e'  // Green text for new data
        ctx.fillText(strB, rect.x + 8, rect.y + rect.height / 2)

        ctx.restore()
        return
      }

      // Handle removed columns (in A/original) - show with red styling
      if (isUserRemovedColumn && status !== 'added') {
        // Removed columns are in A (original), so show strA
        const valA = rowData[`a_${colName}`]
        const strA = valA === null || valA === undefined ? '' : String(valA)

        // Clear background with red highlight (removed data)
        ctx.save()
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)'
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

        // Draw text with strikethrough
        ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#ef4444'  // Red text for removed data
        const y = rect.y + rect.height / 2
        ctx.fillText(strA, rect.x + 8, y)

        // Strikethrough line
        const textWidth = ctx.measureText(strA).width
        ctx.strokeStyle = '#ef4444'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(rect.x + 8, y)
        ctx.lineTo(rect.x + 8 + textWidth, y)
        ctx.stroke()

        ctx.restore()
        return
      }

      if (isModified) {
        // Custom draw for modified cells: strikethrough old value + arrow + new value
        // A = original, B = current
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
    [data, allColumns, userNewColumnsSet, userRemovedColumnsSet, loadedRange.start, blindMode, modifiedColumnsCache]
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
        // Check if any SHARED columns were actually modified
        // If only new/removed columns have changes, don't show yellow row background
        // Use cached modified columns for O(1) lookup
        const rowModifiedCols = modifiedColumnsCache.get(rowData.row_id as string)
        if (!rowModifiedCols || rowModifiedCols.size === 0) {
          // Only new/removed columns changed - no row-level highlight
          return undefined
        }
        return { bgCell: 'rgba(234, 179, 8, 0.08)' }
      }
      return undefined
    },
    [data, loadedRange.start, blindMode, modifiedColumnsCache]
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
    // Check if there are column-level changes (shown in the banner above)
    const hasColumnChanges = userNewColumns.length > 0 || userRemovedColumns.length > 0

    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
          <span className="text-2xl">{hasColumnChanges ? '📊' : '✓'}</span>
        </div>
        <p className="font-medium">
          {hasColumnChanges ? 'No row-level changes' : 'No differences found'}
        </p>
        <p className="text-sm mt-1 text-center max-w-xs">
          {hasColumnChanges
            ? 'Column structure changed (see banner above), but no individual row values were modified.'
            : 'The tables are identical'}
        </p>
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
