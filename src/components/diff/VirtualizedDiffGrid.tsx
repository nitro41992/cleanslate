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
import { fetchDiffPageWithKeyset, getRowsWithColumnChanges, type DiffRow } from '@/lib/diff-engine'
import { useDiffStore } from '@/stores/diffStore'

// Column sizing constants (same as DataGrid)
const GLOBAL_MIN_COLUMN_WIDTH = 50
const GLOBAL_MAX_COLUMN_WIDTH = 500
const DEFAULT_COLUMN_WIDTH = 180

// Row height constants
const BASE_ROW_HEIGHT = 33
const WORD_WRAP_ROW_HEIGHT = 80

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
const PREFETCH_BUFFER = 1000   // Increased from 500 to 1000 rows for smoother scrolling
const MAX_CACHED_PAGES = 12    // LRU cache: 12 pages for diff (OOM fix reduces per-row memory)

/**
 * LRU page cache entry for diff grid.
 * Caches pages by their starting offset for O(1) lookup.
 * Includes cursor positions for keyset pagination.
 */
interface CachedDiffPage {
  startRow: number
  rows: DiffRow[]
  timestamp: number          // For LRU eviction
  firstSortKey: number | null  // Cursor at start of page (for backward navigation)
  lastSortKey: number | null   // Cursor at end of page (for forward navigation)
}

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
  // LRU page cache for efficient scrolling (keyed by page start offset)
  const pageCacheRef = useRef<Map<number, CachedDiffPage>>(new Map())

  // Get store state and actions
  const columnWidths = useDiffStore((s) => s.columnWidths)
  const setColumnWidth = useDiffStore((s) => s.setColumnWidth)
  const wordWrapEnabled = useDiffStore((s) => s.wordWrapEnabled)
  const statusFilter = useDiffStore((s) => s.statusFilter)
  const columnFilter = useDiffStore((s) => s.columnFilter)

  // Track row IDs with changes in the selected column (for column filtering)
  const [columnFilterRowIds, setColumnFilterRowIds] = useState<Set<string> | null>(null)
  const [isLoadingColumnFilter, setIsLoadingColumnFilter] = useState(false)

  // Fetch row IDs when column filter changes
  useEffect(() => {
    if (!columnFilter || !diffTableName) {
      setColumnFilterRowIds(null)
      return
    }

    setIsLoadingColumnFilter(true)
    getRowsWithColumnChanges(
      diffTableName,
      sourceTableName,
      targetTableName,
      columnFilter,
      storageType
    )
      .then((rowIds) => {
        setColumnFilterRowIds(rowIds)
        setIsLoadingColumnFilter(false)
      })
      .catch((err) => {
        console.error('[DiffGrid] Failed to fetch column filter rows:', err)
        setColumnFilterRowIds(null)
        setIsLoadingColumnFilter(false)
      })
  }, [columnFilter, diffTableName, sourceTableName, targetTableName, storageType])

  // Track word wrap changes to force grid remount (same pattern as DataGrid)
  const [gridKey, setGridKey] = useState(0)
  const prevWordWrapRef = useRef(wordWrapEnabled)

  useEffect(() => {
    if (prevWordWrapRef.current !== wordWrapEnabled) {
      pageCacheRef.current.clear()
      setGridKey(k => k + 1)
    }
    prevWordWrapRef.current = wordWrapEnabled
  }, [wordWrapEnabled])

  // Debounce timer for scroll handling - prevents excessive fetches during rapid scrolling
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null)
  // Abort controller for cancelling in-flight fetches when scroll position changes
  const fetchAbortRef = useRef<AbortController | null>(null)
  // Track the last requested range to avoid applying stale data
  const pendingRangeRef = useRef<{ start: number; end: number } | null>(null)

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

  // Filter data by status and/or column if filters are active
  // MUST be defined BEFORE callbacks that use it!
  const filteredData = useMemo(() => {
    let result = data

    // Apply status filter
    if (statusFilter) {
      result = result.filter(row => statusFilter.includes(row.diff_status as 'added' | 'removed' | 'modified'))
    }

    // Apply column filter (only show rows where that column changed)
    if (columnFilter && columnFilterRowIds) {
      result = result.filter(row => columnFilterRowIds.has(row.row_id as string))
    }

    return result
  }, [data, statusFilter, columnFilter, columnFilterRowIds])

  // Check if any filter is active
  const hasActiveFilter = statusFilter !== null || columnFilter !== null

  // Build grid columns: Row # + Status (if not blind mode) + all data columns
  const gridColumns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = []

    // Row number column (always first)
    cols.push({
      id: '_row_num',
      title: 'Row #',
      width: columnWidths['_row_num'] ?? 70,
    })

    if (!blindMode) {
      cols.push({
        id: '_status',
        title: 'Status',
        width: columnWidths['_status'] ?? 100,
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
        width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTH,
      })
    }

    return cols
  }, [allColumns, keyColumns, userNewColumns, userRemovedColumns, blindMode, columnWidths])

  // Load initial data using keyset pagination to capture cursor positions
  useEffect(() => {
    if (!diffTableName || totalRows === 0) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setData([])
    setLoadedRange({ start: 0, end: 0 })
    pageCacheRef.current.clear() // Clear LRU cache on data reload

    // Use keyset pagination for initial load to capture cursor positions
    fetchDiffPageWithKeyset(
      diffTableName, sourceTableName, targetTableName,
      allColumns, newColumns, removedColumns,
      { sortKey: null, direction: 'forward' },  // null cursor = start from beginning
      PAGE_SIZE, storageType
    )
      .then(({ rows, firstSortKey, lastSortKey }) => {
        setData(rows)
        setLoadedRange({ start: 0, end: rows.length })
        setIsLoading(false)

        // Cache the initial page with cursor positions
        pageCacheRef.current.set(0, {
          startRow: 0,
          rows,
          timestamp: Date.now(),
          firstSortKey,
          lastSortKey,
        })
      })
      .catch((err) => {
        console.error('Error loading diff data:', err)
        setIsLoading(false)
      })
  }, [diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, totalRows, storageType])

  // Debounce delay for scroll handling (ms) - shorter for responsive feel
  const SCROLL_DEBOUNCE_MS = 50

  // Load more data on scroll with LRU cache and debouncing
  // Uses prefetch buffer of ±PREFETCH_BUFFER rows for smooth scrolling
  // Debounced to prevent excessive fetches during rapid scrolling (e.g., scrollbar drag)
  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      if (!diffTableName || totalRows === 0) return

      // Calculate the range we need to cover (visible + prefetch buffer)
      const needStart = Math.max(0, range.y - PREFETCH_BUFFER)
      const needEnd = Math.min(totalRows, range.y + range.height + PREFETCH_BUFFER)

      // Check if we already have this range fully loaded (no fetch needed)
      if (needStart >= loadedRange.start && needEnd <= loadedRange.end) {
        return // Already have all needed data
      }

      // Clear any pending debounce timer
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current)
      }

      // Cancel any in-flight fetch for a different region
      if (fetchAbortRef.current) {
        fetchAbortRef.current.abort()
      }

      // Track this as the pending range
      pendingRangeRef.current = { start: needStart, end: needEnd }

      // Debounce the fetch - wait for scrolling to settle
      scrollDebounceRef.current = setTimeout(async () => {
        // Create new abort controller for this fetch
        const abortController = new AbortController()
        fetchAbortRef.current = abortController

        // Calculate which pages we need to cover the range
        const firstPageIdx = Math.floor(needStart / PAGE_SIZE)
        const lastPageIdx = Math.floor((needEnd - 1) / PAGE_SIZE)

        // Collect all cached pages that cover our range
        const cachedPages: CachedDiffPage[] = []
        const missingPageIndices: number[] = []

        for (let pageIdx = firstPageIdx; pageIdx <= lastPageIdx; pageIdx++) {
          const pageStartRow = pageIdx * PAGE_SIZE
          const cached = pageCacheRef.current.get(pageStartRow)
          if (cached && cached.rows.length > 0) {
            cached.timestamp = Date.now() // Update LRU timestamp
            cachedPages.push(cached)
          } else {
            missingPageIndices.push(pageIdx)
          }
        }

        // If we have all pages cached, merge them immediately
        if (missingPageIndices.length === 0 && cachedPages.length > 0) {
          // Sort by startRow and merge
          cachedPages.sort((a, b) => a.startRow - b.startRow)
          const mergedRows: DiffRow[] = []
          const rangeStart = cachedPages[0].startRow

          for (const page of cachedPages) {
            mergedRows.push(...page.rows)
          }

          const rangeEnd = rangeStart + mergedRows.length
          console.log(`[DIFFGRID] Cache hit: merged ${cachedPages.length} pages (rows ${rangeStart}-${rangeEnd})`)
          setData(mergedRows)
          setLoadedRange({ start: rangeStart, end: rangeEnd })
          pendingRangeRef.current = null
          return
        }

        // Fetch missing pages using keyset pagination when possible
        // Strategy: Find nearest cached page with cursor and navigate from there
        try {
          for (const pageIdx of missingPageIndices) {
            // Check if this fetch was aborted (user scrolled to different position)
            if (abortController.signal.aborted) {
              console.log('[DIFFGRID] Fetch aborted - scroll position changed')
              return
            }

            const pageStartRow = pageIdx * PAGE_SIZE
            let newData: DiffRow[]
            let firstSortKey: number | null = null
            let lastSortKey: number | null = null

            // Try to find a cached page with cursor to use keyset pagination
            // Look for adjacent pages (one before or one after)
            const prevPageStart = (pageIdx - 1) * PAGE_SIZE
            const nextPageStart = (pageIdx + 1) * PAGE_SIZE
            const prevCached = pageCacheRef.current.get(prevPageStart)
            const nextCached = pageCacheRef.current.get(nextPageStart)

            if (prevCached?.lastSortKey !== null && prevCached?.lastSortKey !== undefined) {
              // Use keyset pagination from end of previous page (forward)
              console.log(`[DIFFGRID] Keyset fetch: page ${pageIdx} from cursor ${prevCached.lastSortKey}`)
              const result = await fetchDiffPageWithKeyset(
                diffTableName, sourceTableName, targetTableName,
                allColumns, newColumns, removedColumns,
                { sortKey: prevCached.lastSortKey, direction: 'forward' },
                PAGE_SIZE, storageType
              )
              newData = result.rows
              firstSortKey = result.firstSortKey
              lastSortKey = result.lastSortKey
            } else if (nextCached?.firstSortKey !== null && nextCached?.firstSortKey !== undefined) {
              // Use keyset pagination from start of next page (backward)
              console.log(`[DIFFGRID] Keyset fetch (backward): page ${pageIdx} from cursor ${nextCached.firstSortKey}`)
              const result = await fetchDiffPageWithKeyset(
                diffTableName, sourceTableName, targetTableName,
                allColumns, newColumns, removedColumns,
                { sortKey: nextCached.firstSortKey, direction: 'backward' },
                PAGE_SIZE, storageType
              )
              newData = result.rows
              firstSortKey = result.firstSortKey
              lastSortKey = result.lastSortKey
            } else {
              // No adjacent cached page - estimate sort_key from row number
              // sort_key = ROW_NUMBER() which starts at 1, so row N has sort_key = N + 1
              // For page starting at row 500, we want sort_key > 500 to get rows 501+
              const estimatedSortKey = pageStartRow > 0 ? pageStartRow : null
              console.log(`[DIFFGRID] Keyset fetch (estimated): page ${pageIdx} from cursor ${estimatedSortKey}`)
              const result = await fetchDiffPageWithKeyset(
                diffTableName, sourceTableName, targetTableName,
                allColumns, newColumns, removedColumns,
                { sortKey: estimatedSortKey, direction: 'forward' },
                PAGE_SIZE, storageType
              )
              newData = result.rows
              firstSortKey = result.firstSortKey
              lastSortKey = result.lastSortKey
            }

            // Check abort again after async operation
            if (abortController.signal.aborted) {
              console.log('[DIFFGRID] Fetch aborted after page load - scroll position changed')
              return
            }

            // Add to LRU cache with cursor positions
            const newPage: CachedDiffPage = {
              startRow: pageStartRow,
              rows: newData,
              timestamp: Date.now(),
              firstSortKey,
              lastSortKey,
            }
            pageCacheRef.current.set(pageStartRow, newPage)
            cachedPages.push(newPage)

            // Evict oldest pages if cache is full
            while (pageCacheRef.current.size > MAX_CACHED_PAGES) {
              let oldestKey = -1
              let oldestTime = Infinity
              for (const [key, page] of pageCacheRef.current.entries()) {
                if (page.timestamp < oldestTime) {
                  oldestTime = page.timestamp
                  oldestKey = key
                }
              }
              if (oldestKey >= 0) {
                pageCacheRef.current.delete(oldestKey)
              } else {
                break
              }
            }
          }

          // Final abort check before updating state
          if (abortController.signal.aborted) {
            console.log('[DIFFGRID] Fetch aborted before state update')
            return
          }

          // Merge all pages (cached + newly fetched)
          cachedPages.sort((a, b) => a.startRow - b.startRow)
          const mergedRows: DiffRow[] = []
          const rangeStart = cachedPages[0].startRow

          for (const page of cachedPages) {
            mergedRows.push(...page.rows)
          }

          const rangeEnd = rangeStart + mergedRows.length
          console.log(`[DIFFGRID] Fetched ${missingPageIndices.length} pages, merged ${cachedPages.length} total (rows ${rangeStart}-${rangeEnd})`)
          setData(mergedRows)
          setLoadedRange({ start: rangeStart, end: rangeEnd })
          pendingRangeRef.current = null
        } catch (err) {
          // Check if this was an intentional abort
          if (abortController.signal.aborted) {
            return
          }
          console.error('[DIFFGRID] Error loading diff page:', err)
        }
      }, SCROLL_DEBOUNCE_MS)
    },
    [diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, totalRows, keyOrderBy, storageType, loadedRange]
  )

  // Cleanup debounce timer and abort controller on unmount
  useEffect(() => {
    return () => {
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current)
      }
      if (fetchAbortRef.current) {
        fetchAbortRef.current.abort()
      }
    }
  }, [])

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      // When filtering, use filteredData instead of raw data
      const dataSource = hasActiveFilter ? filteredData : data
      const adjustedRow = hasActiveFilter ? row : row - loadedRange.start
      const rowData = dataSource[adjustedRow]

      if (!rowData) {
        return {
          kind: GridCellKind.Loading as const,
          allowOverlay: false,
        }
      }

      // Handle row number column (always first column, col === 0)
      if (col === 0) {
        const bRowNum = rowData.b_row_num
        // Show visual row number for added/modified rows, "-" for removed rows
        const displayValue = bRowNum != null ? String(bRowNum) : '-'
        return {
          kind: GridCellKind.Text as const,
          data: displayValue,
          displayData: displayValue,
          allowOverlay: false,
          readonly: true,
        }
      }

      // Handle status column (second column if not in blind mode)
      // Column index offset: col 0 = Row #, col 1 = Status (if not blind), then data columns
      const statusColOffset = blindMode ? 1 : 2
      const colIndex = col - statusColOffset
      if (!blindMode && col === 1) {
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

      // Get the column name (accounting for Row # and Status column offsets)
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
        allowWrapping: wordWrapEnabled,
      }
    },
    [data, filteredData, hasActiveFilter, allColumns, userNewColumnsSet, userRemovedColumnsSet, loadedRange.start, blindMode, modifiedColumnsCache, wordWrapEnabled]
  )

  // Custom cell drawing for modified cells (show A→B with styling)
  const drawCell: DrawCellCallback = useCallback(
    (args, draw) => {
      const { col, row, rect, ctx } = args
      // When filtering, use filteredData instead of raw data
      const dataSource = hasActiveFilter ? filteredData : data
      const adjustedRow = hasActiveFilter ? row : row - loadedRange.start
      const rowData = dataSource[adjustedRow]

      if (!rowData || blindMode) {
        draw()
        return
      }

      // Handle row number column (col === 0)
      if (col === 0) {
        const bRowNum = rowData.b_row_num
        const displayValue = bRowNum != null ? String(bRowNum) : '-'

        // Subtle muted styling for row number column
        ctx.save()
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

        ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#6b7280'  // Muted gray
        ctx.fillText(displayValue, rect.x + 8, rect.y + rect.height / 2)
        ctx.restore()
        return
      }

      // Handle status column styling (col === 1 when not in blind mode)
      if (col === 1) {
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

      // Column index offset: col 0 = Row #, col 1 = Status, then data columns
      const colIndex = col - 2
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
    [data, filteredData, hasActiveFilter, allColumns, userNewColumnsSet, userRemovedColumnsSet, loadedRange.start, blindMode, modifiedColumnsCache]
  )

  // Row theme based on diff status
  const getRowThemeOverride: GetRowThemeCallback = useCallback(
    (row: number) => {
      if (blindMode) return undefined

      // When filtering, use filteredData instead of raw data
      const dataSource = hasActiveFilter ? filteredData : data
      const adjustedRow = hasActiveFilter ? row : row - loadedRange.start
      const rowData = dataSource[adjustedRow]
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
    [data, filteredData, hasActiveFilter, loadedRange.start, blindMode, modifiedColumnsCache]
  )

  // Handle column resize - persist to store
  const handleColumnResize = useCallback(
    (column: GridColumn, newSize: number) => {
      if (column.id) {
        setColumnWidth(column.id as string, newSize)
      }
    },
    [setColumnWidth]
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
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
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

  // Determine the row count to display
  // When filtering by status or column, use the filtered data length
  const effectiveRowCount = hasActiveFilter ? filteredData.length : totalRows

  // Show loading indicator when column filter is being fetched
  if (isLoadingColumnFilter) {
    return (
      <div className="h-full w-full p-4 space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full w-full gdg-container min-h-[400px]" data-testid="diff-grid">
      {data.length > 0 && (
        <DataGridLib
          key={gridKey}
          columns={gridColumns}
          rows={effectiveRowCount}
          getCellContent={getCellContent}
          onVisibleRegionChanged={hasActiveFilter ? undefined : onVisibleRegionChanged}
          getRowThemeOverride={getRowThemeOverride}
          drawCell={wordWrapEnabled ? undefined : drawCell}
          // Column resize support
          onColumnResize={handleColumnResize}
          minColumnWidth={GLOBAL_MIN_COLUMN_WIDTH}
          maxColumnWidth={GLOBAL_MAX_COLUMN_WIDTH}
          // Row height for word wrap
          rowHeight={wordWrapEnabled ? WORD_WRAP_ROW_HEIGHT : BASE_ROW_HEIGHT}
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
          experimental={{ hyperWrapping: true }}
        />
      )}
    </div>
  )
}
