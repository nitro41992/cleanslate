import { useCallback, useMemo, useEffect, useState, useRef } from 'react'
import DataGridLib, {
  GridColumn,
  GridCellKind,
  Item,
  GetRowThemeCallback,
  EditableGridCell,
  DrawCellCallback,
  DataEditorRef,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useDuckDB } from '@/hooks/useDuckDB'
import { Skeleton } from '@/components/ui/skeleton'
import { useEditStore } from '@/stores/editStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { useUIStore } from '@/stores/uiStore'
import { useTableStore } from '@/stores/tableStore'
import { useEditBatchStore, type PendingEdit, isBatchingEnabled } from '@/stores/editBatchStore'
import { updateCell, estimateCsIdForRow } from '@/lib/duckdb'
import { recordCommand, initializeTimeline } from '@/lib/timeline-engine'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import { toast } from '@/hooks/use-toast'
import { validateValueForType, getTypeDisplayName } from '@/lib/validation/type-validation'
import {
  getDefaultColumnWidth,
  GLOBAL_MIN_COLUMN_WIDTH,
  GLOBAL_MAX_COLUMN_WIDTH,
  MAX_COLUMN_AUTO_WIDTH,
} from '@/components/grid/column-sizing'
import { ColumnHeaderMenu, FilterBar } from '@/components/grid/filters'
import { buildWhereClause, buildOrderByClause } from '@/lib/duckdb/filter-builder'
import type { TimelineHighlight, ManualEditParams, ColumnInfo, ColumnFilter } from '@/types'

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

/**
 * Subtle custom header icons for column types.
 * These are minimal text-based icons without the boxed appearance of the built-in icons.
 */
import type { SpriteMap } from '@glideapps/glide-data-grid'

const customHeaderIcons: SpriteMap = {
  // Text: "T" - serif style for readability
  typeText: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <text x="10" y="15" text-anchor="middle" fill="${fgColor}" font-size="12" font-family="Georgia, serif" font-weight="500">T</text>
    </svg>
  `,
  // Integer: "#" - number sign
  typeInteger: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <text x="10" y="15" text-anchor="middle" fill="${fgColor}" font-size="11" font-family="ui-monospace, monospace" font-weight="500">#</text>
    </svg>
  `,
  // Decimal: ".0" - decimal notation
  typeDecimal: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <text x="10" y="14" text-anchor="middle" fill="${fgColor}" font-size="10" font-family="ui-monospace, monospace" font-weight="500">.0</text>
    </svg>
  `,
  // Date: calendar icon (simple)
  typeDate: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="5" width="12" height="11" rx="1" fill="none" stroke="${fgColor}" stroke-width="1.2"/>
      <line x1="4" y1="8" x2="16" y2="8" stroke="${fgColor}" stroke-width="1"/>
      <line x1="7" y1="3" x2="7" y2="6" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="13" y1="3" x2="13" y2="6" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  `,
  // Timestamp: clock icon (simple)
  typeTime: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="6" fill="none" stroke="${fgColor}" stroke-width="1.2"/>
      <line x1="10" y1="10" x2="10" y2="6" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="10" y1="10" x2="13" y2="10" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  `,
  // Boolean: toggle/checkbox
  typeBool: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="6" width="8" height="8" rx="1" fill="none" stroke="${fgColor}" stroke-width="1.2"/>
      <polyline points="6,10 8,12 12,7" fill="none" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,
  // UUID: key icon
  typeUUID: ({ fgColor }) => `
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="10" r="3" fill="none" stroke="${fgColor}" stroke-width="1.2"/>
      <line x1="10" y1="10" x2="16" y2="10" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="14" y1="10" x2="14" y2="13" stroke="${fgColor}" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  `,
}

/**
 * Maps DuckDB column types to custom subtle icons.
 * Returns undefined for types without a suitable icon.
 */
function getColumnIcon(type: string): string | undefined {
  const normalizedType = type.toUpperCase()

  // Text types
  if (normalizedType.includes('VARCHAR') || normalizedType.includes('TEXT') || normalizedType === 'STRING') {
    return 'typeText'
  }

  // Integer types
  if (
    normalizedType.includes('INT') ||
    normalizedType.includes('BIGINT') ||
    normalizedType.includes('SMALLINT') ||
    normalizedType.includes('TINYINT') ||
    normalizedType.includes('HUGEINT')
  ) {
    return 'typeInteger'
  }

  // Floating point types
  if (
    normalizedType.includes('DOUBLE') ||
    normalizedType.includes('DECIMAL') ||
    normalizedType.includes('FLOAT') ||
    normalizedType.includes('REAL') ||
    normalizedType.includes('NUMERIC')
  ) {
    return 'typeDecimal'
  }

  // Date (but not timestamp)
  if (normalizedType.includes('DATE') && !normalizedType.includes('TIMESTAMP')) {
    return 'typeDate'
  }

  // Timestamp and time types
  if (normalizedType.includes('TIMESTAMP') || normalizedType === 'TIME') {
    return 'typeTime'
  }

  // Boolean
  if (normalizedType.includes('BOOL')) {
    return 'typeBool'
  }

  // UUID
  if (normalizedType.includes('UUID')) {
    return 'typeUUID'
  }

  return undefined
}

/**
 * Returns a description of what the column type means.
 * Used in the persistent tooltip when clicking column headers.
 */
function getTypeDescription(type: string): string {
  const normalizedType = type.toUpperCase()

  if (normalizedType.includes('VARCHAR') || normalizedType.includes('TEXT') || normalizedType === 'STRING') {
    return 'Variable-length text string'
  }
  if (normalizedType.includes('BIGINT') || normalizedType.includes('HUGEINT')) {
    return 'Large whole number (no decimals)'
  }
  if (normalizedType.includes('INT')) {
    return 'Whole number (no decimals)'
  }
  if (normalizedType.includes('DOUBLE') || normalizedType.includes('FLOAT') || normalizedType.includes('REAL')) {
    return 'Number with decimal precision'
  }
  if (normalizedType.includes('DECIMAL') || normalizedType.includes('NUMERIC')) {
    return 'Fixed-precision decimal number'
  }
  if (normalizedType.includes('TIMESTAMP')) {
    return 'Date and time combined'
  }
  if (normalizedType.includes('DATE')) {
    return 'Calendar date (year-month-day)'
  }
  if (normalizedType === 'TIME') {
    return 'Time of day (hours:minutes:seconds)'
  }
  if (normalizedType.includes('BOOL')) {
    return 'True or False value'
  }
  if (normalizedType.includes('UUID')) {
    return 'Unique identifier'
  }

  return 'Data value'
}

interface DataGridProps {
  tableName: string
  rowCount: number
  columns: string[]
  /** Column type information for validation and display */
  columnTypes?: ColumnInfo[]
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
  // Word wrap for cell content
  wordWrapEnabled?: boolean
}

const PAGE_SIZE = 500
const PREFETCH_BUFFER = 1000 // Increased from 500 to 1000 rows for smoother scrolling
const MAX_CACHED_PAGES = 10  // LRU cache: 10 pages = ~5000 rows

/**
 * LRU page cache entry for keyset pagination.
 * Caches pages by their starting row index for O(1) lookup.
 */
interface CachedPage {
  startRow: number
  rows: { csId: string; data: Record<string, unknown> }[]
  firstCsId: string | null
  lastCsId: string | null
  timestamp: number          // For LRU eviction
}

export function DataGrid({
  tableName,
  rowCount,
  columns,
  columnTypes,
  highlightedRows,
  highlightedCells: _highlightedCells,
  onCellClick,
  editable = false,
  tableId,
  timelineHighlight,
  ghostRows: _ghostRows = [],
  dataVersion,
  wordWrapEnabled = false,
}: DataGridProps) {
  const { getData, getDataWithRowIds, getDataWithKeyset, getFilteredCount } = useDuckDB()

  // Create a lookup map for column types (used for validation and display)
  const columnTypeMap = useMemo(() => {
    const map = new Map<string, string>()
    if (columnTypes) {
      for (const col of columnTypes) {
        map.set(col.name, col.type)
      }
    }
    return map
  }, [columnTypes])
  const [data, setData] = useState<Record<string, unknown>[]>([])
  // Map of _cs_id -> row index in current loaded data (for timeline highlighting)
  const [csIdToRowIndex, setCsIdToRowIndex] = useState<Map<string, number>>(new Map())
  const [loadedRange, setLoadedRange] = useState({ start: 0, end: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const containerSize = useContainerSize(containerRef)
  // Grid ref for programmatic control (e.g., forcing re-render on highlight changes)
  const gridRef = useRef<DataEditorRef>(null)
  // Track scroll position for restore after data reload (transforms, not cell edits)
  // This preserves the user's view position across structural changes (column adds, transforms)
  const scrollPositionRef = useRef<{ col: number; row: number } | null>(null)

  // LRU page cache for efficient scrolling (keyed by approximate start row)
  // Caches up to MAX_CACHED_PAGES pages (~5000 rows) for instant access on scroll-back
  const pageCacheRef = useRef<Map<number, CachedPage>>(new Map())

  // Debounce timer for scroll handling - prevents excessive fetches during rapid scrolling
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null)
  // Abort controller for cancelling in-flight fetches when scroll position changes
  const fetchAbortRef = useRef<AbortController | null>(null)
  // Track the last requested range to avoid applying stale data
  const pendingRangeRef = useRef<{ start: number; end: number } | null>(null)

  // Timeline store for highlight state and replay status
  const storeHighlight = useTimelineStore((s) => s.highlight)
  const isReplaying = useTimelineStore((s) => s.isReplaying)
  // UI store for busy state (prevents concurrent DuckDB operations)
  const isBusy = useUIStore((s) => s.busyCount > 0)
  // Use prop if provided, otherwise fall back to store
  const activeHighlight = timelineHighlight ?? (storeHighlight.commandId ? storeHighlight : null)

  // Edit store for tracking edits (legacy)
  const recordEdit = useEditStore((s) => s.recordEdit)

  // Hook for executing commands with confirmation when discarding redo states
  // Note: executeWithConfirmation kept for potential future use (e.g., undo confirmation during batch)
  const { executeWithConfirmation: _executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  // Track CommandExecutor timeline version for triggering re-renders
  const [executorTimelineVersion, setExecutorTimelineVersion] = useState(0)

  // Timeline-based dirty cell tracking (replaces editStore.isDirty)
  // Subscribe directly to the timeline object so we re-render when loadTimelines() restores state
  // This fixes the bug where dirty cell indicators don't persist after page refresh
  const timeline = useTimelineStore((s) => tableId ? s.timelines.get(tableId) : undefined)

  // Compute dirty cells set based on timeline position
  // This re-computes when the timeline object changes (including after persistence restore)
  // Combines cells from timeline AND CommandExecutor
  const dirtyCells = useMemo(
    () => {
      if (!tableId) return new Set<string>()

      const dirtyCells = new Set<string>()

      // Get dirty cells from timeline if it exists
      if (timeline) {
        // Only consider commands up to currentPosition (inclusive)
        // Commands after currentPosition are "undone" and shouldn't show as dirty
        for (let i = 0; i <= timeline.currentPosition && i < timeline.commands.length; i++) {
          const cmd = timeline.commands[i]
          // Track cells modified by manual_edit or batch_edit commands
          if (cmd.cellChanges) {
            for (const change of cmd.cellChanges) {
              dirtyCells.add(`${change.csId}:${change.columnName}`)
            }
          }
          // Also handle single manual_edit without cellChanges array
          if (cmd.commandType === 'manual_edit' && cmd.params.type === 'manual_edit') {
            dirtyCells.add(`${cmd.params.csId}:${cmd.params.columnName}`)
          }
        }
      }

      // Merge with executor dirty cells (for current session edits not yet in timeline)
      const executor = getCommandExecutor()
      const executorDirtyCells = executor.getDirtyCells(tableId)
      for (const cell of executorDirtyCells) {
        dirtyCells.add(cell)
      }

      return dirtyCells
    },
    [tableId, timeline, executorTimelineVersion]
  )

  // Audit store for logging edits

  // Edit batch store for batching rapid edits
  const addEditToBatch = useEditBatchStore((s) => s.addEdit)

  // Set up the batch flush callback - executes when batch timer fires
  // NOTE: This callback is global and handles ALL tables' edits, not just the current one.
  // This is critical for deferred flushes - if user switches tables during a transform,
  // edits for the original table must still be flushed when the transform completes.
  useEffect(() => {
    if (!tableId || !tableName) return

    useEditBatchStore.getState()._setFlushCallback(async (batchTableId: string, edits: PendingEdit[]) => {
      if (edits.length === 0) return

      // Look up the table name from the store (handles edits for any table, not just current)
      const { useTableStore } = await import('@/stores/tableStore')
      const table = useTableStore.getState().tables.find((t) => t.id === batchTableId)
      const batchTableName = table?.name ?? 'unknown'

      console.log(`[DATAGRID] Flushing batch of ${edits.length} edits for ${batchTableName}`)

      try {
        // Create batch command with all accumulated edits
        // Use batchTableId/batchTableName to handle edits for any table
        const command = createCommand('edit:batch', {
          tableId: batchTableId,
          tableName: batchTableName,
          changes: edits.map((e) => ({
            csId: e.csId,
            columnName: e.columnName,
            previousValue: e.previousValue,
            newValue: e.newValue,
          })),
        })

        // Execute via CommandExecutor (handles database, timeline, audit)
        const result = await getCommandExecutor().execute(command)

        if (result.success) {
          console.log(`[DATAGRID] Batch edit successful: ${edits.length} cells`)

          // Save to changelog for fast persistence (non-blocking)
          // This avoids triggering full Parquet export for cell edits
          const { saveCellEditsToChangelog } = await import('@/hooks/usePersistence')
          await saveCellEditsToChangelog(
            edits.map((e) => ({
              tableId: batchTableId,
              rowId: parseInt(e.csId, 10), // _cs_id is numeric
              column: e.columnName,
              oldValue: e.previousValue,
              newValue: e.newValue,
            }))
          )

          // Mark table clean after successful changelog write
          // This is critical for deferred flushes where Effect 6b can't mark clean
          // (because pending edits existed at the time)
          const { useUIStore } = await import('@/stores/uiStore')
          useUIStore.getState().markTableClean(batchTableId)

          // Trigger re-render for dirty cell tracking
          setExecutorTimelineVersion((v) => v + 1)
        } else {
          console.error('[DATAGRID] Batch edit failed:', result.error)
        }
      } catch (error) {
        console.error('[DATAGRID] Failed to execute batch edit:', error)
      }
    })
  }, [tableId, tableName])

  // Get saved column preferences for this table
  const columnPreferences = useTableStore((s) =>
    tableId ? s.getColumnPreferences(tableId) : undefined
  )
  const updateColumnWidth = useTableStore((s) => s.updateColumnWidth)

  // Get view state (filters/sort) for this table
  const viewState = useTableStore((s) =>
    tableId ? s.getViewState(tableId) : undefined
  )
  const setFilter = useTableStore((s) => s.setFilter)
  const removeFilter = useTableStore((s) => s.removeFilter)
  const clearFilters = useTableStore((s) => s.clearFilters)
  const setSort = useTableStore((s) => s.setSort)

  // Track filtered row count (null = no filter active, use total rowCount)
  const [filteredRowCount, setFilteredRowCount] = useState<number | null>(null)

  // Header tooltip state - shows column type on click (persistent until dismissed)
  const [headerTooltip, setHeaderTooltip] = useState<{
    column: string
    type: string
    description: string
    x: number
    y: number
  } | null>(null)

  // Check if a column has an active filter
  const getColumnFilter = useCallback((colName: string): ColumnFilter | undefined => {
    return viewState?.filters.find(f => f.column === colName)
  }, [viewState])

  // Filter/sort action handlers
  const handleSetFilter = useCallback((filter: ColumnFilter) => {
    if (tableId) {
      setFilter(tableId, filter)
    }
  }, [tableId, setFilter])

  const handleRemoveFilter = useCallback((column: string) => {
    if (tableId) {
      removeFilter(tableId, column)
    }
  }, [tableId, removeFilter])

  const handleClearAllFilters = useCallback(() => {
    if (tableId) {
      clearFilters(tableId)
    }
  }, [tableId, clearFilters])

  const handleSetSort = useCallback((column: string, direction: 'asc' | 'desc') => {
    if (tableId) {
      setSort(tableId, column, direction)
    }
  }, [tableId, setSort])

  const handleClearSort = useCallback(() => {
    if (tableId) {
      setSort(tableId, null, 'asc')
    }
  }, [tableId, setSort])

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((col) => {
        const colType = columnTypeMap.get(col)

        // Build title with sort indicator if this column is sorted
        const isSorted = viewState?.sortColumn === col
        const sortIndicator = isSorted
          ? viewState?.sortDirection === 'asc' ? ' ↑' : ' ↓'
          : ''
        const hasFilter = viewState?.filters.some(f => f.column === col)
        const filterIndicator = hasFilter ? ' ⚡' : ''
        const title = `${col}${sortIndicator}${filterIndicator}`

        // Priority: 1. User-saved width, 2. Type-based default, 3. Fallback 150px
        const savedWidth = columnPreferences?.widths?.[col]
        const typeBasedWidth = colType ? getDefaultColumnWidth(colType) : 150
        const width = savedWidth ?? typeBasedWidth

        // Get type-specific icon for header
        const icon = colType ? getColumnIcon(colType) : undefined

        return {
          id: col,
          title,
          width,
          icon,
        }
      }),
    [columns, columnTypeMap, columnPreferences, viewState]
  )

  // Memoize theme to prevent unnecessary re-renders
  // Note: Matching VirtualizedDiffGrid theme (no lineHeight/padding overrides)
  const gridTheme = useMemo(() => ({
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
  }), [])

  // Load initial data (re-runs when rowCount changes, e.g., after merge operations)
  // Also re-runs when view state (filters/sort) changes
  useEffect(() => {
    console.log('[DATAGRID] useEffect triggered', { tableName, columnCount: columns.length, rowCount, dataVersion, isReplaying, viewState })

    // Check and consume skip flag (e.g., after diff close to prevent unnecessary reload)
    const shouldSkip = useUIStore.getState().skipNextGridReload
    if (shouldSkip) {
      useUIStore.getState().setSkipNextGridReload(false)
      console.log('[DATAGRID] Skipping fetch - skipNextGridReload flag was set')
      return
    }

    if (!tableName || columns.length === 0) {
      console.log('[DATAGRID] Early return - no tableName or columns')
      return
    }

    // Don't fetch during replay - table might be in inconsistent state
    if (isReplaying) {
      console.log('[DATAGRID] Skipping fetch - replay in progress')
      return
    }

    // Don't fetch when DuckDB is busy with heavy operations (diff, transforms, etc.)
    if (isBusy) {
      console.log('[DATAGRID] Skipping fetch - DuckDB busy with heavy operation')
      return
    }

    console.log('[DATAGRID] Starting data reload...')

    // Capture scroll position BEFORE clearing data (for restore after structural changes)
    const savedScrollPosition = scrollPositionRef.current

    setIsLoading(true)
    setData([]) // Clear stale data immediately
    setLoadedRange({ start: 0, end: 0 }) // Reset loaded range
    setCsIdToRowIndex(new Map()) // Reset row ID mapping
    pageCacheRef.current.clear() // Clear LRU cache on data reload

    // Build filter/sort clauses from viewState
    const filters = viewState?.filters ?? []
    const sortColumn = viewState?.sortColumn ?? null
    const sortDirection = viewState?.sortDirection ?? 'asc'

    // Build WHERE and ORDER BY clauses
    const whereClause = filters.length > 0 ? buildWhereClause(filters) : undefined
    const orderByClause = sortColumn ? buildOrderByClause(sortColumn, sortDirection) : undefined

    // Fetch filtered row count if filters are active
    if (filters.length > 0) {
      getFilteredCount(tableName, filters)
        .then(count => {
          setFilteredRowCount(count)
          console.log('[DATAGRID] Filtered row count:', count)
        })
        .catch(err => {
          console.warn('[DATAGRID] Failed to get filtered count:', err)
          setFilteredRowCount(null)
        })
    } else {
      setFilteredRowCount(null)
    }

    // Load initial data using keyset pagination with optional filter/sort
    const cursor = {
      direction: 'forward' as const,
      csId: null,
      whereClause,
      orderByClause,
    }

    getDataWithKeyset(tableName, cursor, PAGE_SIZE)
      .then((pageResult) => {
        console.log('[DATAGRID] Data fetched with keyset, row count:', pageResult.rows.length)
        // Build _cs_id -> row index map
        const idMap = new Map<string, number>()
        const rows = pageResult.rows.map((row, index) => {
          if (row.csId) {
            idMap.set(row.csId, index)
          }
          return row.data
        })

        // Log first row for debugging
        if (rows.length > 0) {
          console.log('[DATAGRID] First row sample:', rows[0])
        }

        // Cache this initial page
        pageCacheRef.current.set(0, {
          startRow: 0,
          rows: pageResult.rows,
          firstCsId: pageResult.firstCsId,
          lastCsId: pageResult.lastCsId,
          timestamp: Date.now(),
        })

        setData(rows)
        setCsIdToRowIndex(idMap)
        setLoadedRange({ start: 0, end: rows.length })
        setIsLoading(false)

        // Restore scroll position after data loads (for structural changes like transforms)
        // Use requestAnimationFrame to ensure grid has rendered before scrolling
        if (savedScrollPosition && gridRef.current) {
          requestAnimationFrame(() => {
            if (gridRef.current) {
              const { col, row } = savedScrollPosition
              // Clamp row to valid range (in case row count decreased)
              const clampedRow = Math.min(row, Math.max(0, rowCount - 1))
              gridRef.current.scrollTo(col, clampedRow)
              console.log('[DATAGRID] Restored scroll position:', { col, row: clampedRow })
            }
          })
        }
      })
      .catch((err) => {
        console.error('Error loading data with keyset:', err)
        // Fallback to OFFSET-based getData if keyset fails
        getDataWithRowIds(tableName, 0, PAGE_SIZE)
          .then((rowsWithIds) => {
            const idMap = new Map<string, number>()
            const rows = rowsWithIds.map((row, index) => {
              if (row.csId) {
                idMap.set(row.csId, index)
              }
              return row.data
            })
            setData(rows)
            setCsIdToRowIndex(idMap)
            setLoadedRange({ start: 0, end: rows.length })
            setIsLoading(false)
          })
          .catch((fallbackErr) => {
            console.error('Error loading fallback data:', fallbackErr)
            setIsLoading(false)
          })
      })
  }, [tableName, columns, getData, getDataWithRowIds, getDataWithKeyset, getFilteredCount, rowCount, dataVersion, isReplaying, isBusy, viewState])

  // Track previous values to detect changes
  const prevHighlightCommandId = useRef<string | null | undefined>(undefined)
  const prevTimelinePosition = useRef<number>(-1)

  // Helper to invalidate visible cells in the grid
  // For full grid refresh (e.g., word wrap), set allColumns=true
  const invalidateVisibleCells = useCallback((allColumns = false) => {
    if (!gridRef.current) return
    const cellsToUpdate: { cell: [number, number] }[] = []
    const visibleStart = loadedRange.start
    const visibleEnd = Math.min(loadedRange.end, loadedRange.start + 50) // Limit to 50 rows for performance
    const colCount = allColumns ? columns.length : 1
    for (let row = visibleStart; row < visibleEnd; row++) {
      for (let col = 0; col < colCount; col++) {
        cellsToUpdate.push({ cell: [col, row] })
      }
    }
    if (cellsToUpdate.length > 0) {
      gridRef.current.updateCells(cellsToUpdate)
    }
  }, [loadedRange, columns.length])

  // Force grid re-render when highlight changes (set or cleared)
  // Canvas-based grids need explicit invalidation to redraw cells with new highlight state
  useEffect(() => {
    const currentCommandId = activeHighlight?.commandId ?? null
    if (prevHighlightCommandId.current !== currentCommandId) {
      invalidateVisibleCells()
    }
    prevHighlightCommandId.current = currentCommandId
  }, [activeHighlight?.commandId, invalidateVisibleCells])

  // Force grid re-render when timeline position changes (undo/redo)
  // This ensures dirty cell indicators (red triangles) update correctly
  // Must invalidate ALL columns since cell indicators appear in col > 0
  const timelinePosition = timeline?.currentPosition ?? -1
  useEffect(() => {
    if (prevTimelinePosition.current !== timelinePosition) {
      invalidateVisibleCells(true)
    }
    prevTimelinePosition.current = timelinePosition
  }, [timelinePosition, invalidateVisibleCells])

  // Force grid re-render when executor timeline version changes (batch flush)
  // After edits are flushed to DuckDB, we need to update the cell indicators
  // from orange (pending) to green (committed) or clear them
  // Must invalidate ALL columns since cell indicators appear in col > 0
  const prevExecutorVersionRef = useRef(executorTimelineVersion)
  useEffect(() => {
    if (prevExecutorVersionRef.current !== executorTimelineVersion) {
      invalidateVisibleCells(true)
    }
    prevExecutorVersionRef.current = executorTimelineVersion
  }, [executorTimelineVersion, invalidateVisibleCells])

  // Force grid re-render when loaded range changes (scroll)
  // This ensures word wrap is applied correctly to cells that scroll back into view
  const prevLoadedRangeRef = useRef(loadedRange)
  useEffect(() => {
    if (prevLoadedRangeRef.current.start !== loadedRange.start ||
        prevLoadedRangeRef.current.end !== loadedRange.end) {
      // Invalidate all columns to ensure word wrap is applied correctly
      invalidateVisibleCells(true)
    }
    prevLoadedRangeRef.current = loadedRange
  }, [loadedRange, invalidateVisibleCells])

  // Debounce delay for scroll handling (ms) - shorter for responsive feel
  const SCROLL_DEBOUNCE_MS = 50

  // Load more data on scroll with LRU cache and keyset pagination
  // Uses prefetch buffer of ±PREFETCH_BUFFER rows for smooth scrolling
  // Debounced to prevent excessive fetches during rapid scrolling (e.g., scrollbar drag)
  const onVisibleRegionChanged = useCallback(
    (range: { x: number; y: number; width: number; height: number }) => {
      // Save current scroll position for restore after data reload (transforms)
      scrollPositionRef.current = { col: range.x, row: range.y }

      // Skip if DuckDB is busy with heavy operations
      if (useUIStore.getState().busyCount > 0) return

      // Calculate the range we need to cover (visible + prefetch buffer)
      const needStart = Math.max(0, range.y - PREFETCH_BUFFER)
      const needEnd = Math.min(rowCount, range.y + range.height + PREFETCH_BUFFER)

      // Guard against invalid range (can happen when row height changes dramatically
      // and scroll position hasn't adjusted yet, e.g., toggling word wrap off)
      if (needEnd <= needStart) {
        return
      }

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
        const cachedPages: CachedPage[] = []
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
          const mergedRows: Record<string, unknown>[] = []
          const idMap = new Map<string, number>()
          const rangeStart = cachedPages[0].startRow

          for (const page of cachedPages) {
            for (let i = 0; i < page.rows.length; i++) {
              const row = page.rows[i]
              const globalIdx = page.startRow + i
              if (row.csId) {
                idMap.set(row.csId, globalIdx)
              }
              mergedRows.push(row.data)
            }
          }

          const rangeEnd = rangeStart + mergedRows.length
          console.log(`[DATAGRID] Cache hit: merged ${cachedPages.length} pages (rows ${rangeStart}-${rangeEnd})`)
          setData(mergedRows)
          setCsIdToRowIndex(idMap)
          setLoadedRange({ start: rangeStart, end: rangeEnd })
          pendingRangeRef.current = null
          return
        }

        // Fetch missing pages using keyset pagination
        try {
          for (const pageIdx of missingPageIndices) {
            // Check if this fetch was aborted (user scrolled to different position)
            if (abortController.signal.aborted) {
              console.log('[DATAGRID] Fetch aborted - scroll position changed')
              return
            }

            const pageStartRow = pageIdx * PAGE_SIZE
            const targetCsId = pageStartRow > 0 ? estimateCsIdForRow(pageStartRow - 1) : null

            // Build filter/sort clauses from viewState
            const filters = viewState?.filters ?? []
            const sortColumn = viewState?.sortColumn ?? null
            const sortDirection = viewState?.sortDirection ?? 'asc'
            const whereClause = filters.length > 0 ? buildWhereClause(filters) : undefined
            const orderByClause = sortColumn ? buildOrderByClause(sortColumn, sortDirection) : undefined

            const pageResult = await getDataWithKeyset(
              tableName,
              { direction: 'forward', csId: targetCsId, whereClause, orderByClause },
              PAGE_SIZE
            )

            // Check abort again after async operation
            if (abortController.signal.aborted) {
              console.log('[DATAGRID] Fetch aborted after page load - scroll position changed')
              return
            }

            // Add to LRU cache
            const newPage: CachedPage = {
              startRow: pageStartRow,
              rows: pageResult.rows,
              firstCsId: pageResult.firstCsId,
              lastCsId: pageResult.lastCsId,
              timestamp: Date.now(),
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
            console.log('[DATAGRID] Fetch aborted before state update')
            return
          }

          // Merge all pages (cached + newly fetched)
          cachedPages.sort((a, b) => a.startRow - b.startRow)
          const mergedRows: Record<string, unknown>[] = []
          const idMap = new Map<string, number>()
          const rangeStart = cachedPages[0].startRow

          for (const page of cachedPages) {
            for (let i = 0; i < page.rows.length; i++) {
              const row = page.rows[i]
              const globalIdx = page.startRow + i
              if (row.csId) {
                idMap.set(row.csId, globalIdx)
              }
              mergedRows.push(row.data)
            }
          }

          const rangeEnd = rangeStart + mergedRows.length
          console.log(`[DATAGRID] Fetched ${missingPageIndices.length} pages, merged ${cachedPages.length} total (rows ${rangeStart}-${rangeEnd})`)
          setData(mergedRows)
          setCsIdToRowIndex(idMap)
          setLoadedRange({ start: rangeStart, end: rangeEnd })
          pendingRangeRef.current = null
        } catch (err) {
          // Check if this was an intentional abort
          if (abortController.signal.aborted) {
            return
          }
          // Fallback to OFFSET-based getData if keyset fails
          console.log('[DATAGRID] Keyset pagination failed, falling back to OFFSET:', err)
          try {
            const rowsWithIds = await getDataWithRowIds(tableName, needStart, needEnd - needStart)
            if (abortController.signal.aborted) return
            const idMap = new Map<string, number>()
            const rows = rowsWithIds.map((row, index) => {
              if (row.csId) {
                idMap.set(row.csId, needStart + index)
              }
              return row.data
            })
            setData(rows)
            setCsIdToRowIndex(idMap)
            setLoadedRange({ start: needStart, end: needStart + rows.length })
            pendingRangeRef.current = null
          } catch (fallbackErr) {
            console.error('[DATAGRID] Fallback fetch also failed:', fallbackErr)
          }
        }
      }, SCROLL_DEBOUNCE_MS)
    },
    [getData, getDataWithRowIds, getDataWithKeyset, tableName, rowCount, loadedRange, viewState]
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

  // Compute reverse map: row index -> csId for the loaded range
  // IMPORTANT: This must be defined before getCellContent which depends on it
  const rowIndexToCsId = useMemo(() => {
    const map = new Map<number, string>()
    for (const [csId, rowIndex] of csIdToRowIndex) {
      map.set(rowIndex, csId)
    }
    return map
  }, [csIdToRowIndex])

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const adjustedRow = row - loadedRange.start
      const rowData = data[adjustedRow]

      if (!rowData) {
        return {
          kind: GridCellKind.Loading as const,
          allowOverlay: false,
          allowWrapping: wordWrapEnabled,
        }
      }

      const colName = columns[col]

      // Get base value from DuckDB data
      let value = rowData[colName]

      // OPTIMISTIC UI: Check for pending batch edit that should overlay
      // When batching is enabled, edits are accumulated in editBatchStore before
      // being flushed to DuckDB. During this window, we need to show the edited
      // value even though it's not yet in the database. This prevents the UI
      // from reverting to stale values during transforms.
      const csId = rowIndexToCsId.get(row)
      if (csId && tableId) {
        const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId)
        const pendingEdit = pendingEdits.find(
          e => e.csId === csId && e.columnName === colName
        )
        if (pendingEdit) {
          value = pendingEdit.newValue
        }
      }

      return {
        kind: GridCellKind.Text as const,
        data: value === null || value === undefined ? '' : String(value),
        displayData: value === null || value === undefined ? '' : String(value),
        allowOverlay: true,
        readonly: !editable,
        allowWrapping: wordWrapEnabled,
      }
    },
    [data, columns, loadedRange.start, editable, rowIndexToCsId, tableId, wordWrapEnabled]
  )

  // Helper to convert BigInt values to strings for command serialization
  const serializeValue = (value: unknown): unknown => {
    if (typeof value === 'bigint') {
      return value.toString()
    }
    return value
  }

  // Handle cell edits using CommandExecutor
  const onCellEdited = useCallback(
    async ([col, row]: Item, newValue: EditableGridCell) => {
      if (!editable || !tableId) return

      const colName = columns[col]
      const adjustedRow = row - loadedRange.start
      const rowData = data[adjustedRow]
      const previousValue = serializeValue(rowData?.[colName])

      // Get the new value from the cell
      let newCellValue: unknown
      if (newValue.kind === GridCellKind.Text) {
        newCellValue = newValue.data
        // Convert empty strings to null (users clearing a cell expect NULL, not '')
        // This prevents "Could not convert string '' to INT64" errors
        if (newCellValue === '') {
          newCellValue = null
        }
      } else {
        return // Only handle text cells for now
      }

      // Skip if value hasn't changed
      if (previousValue === newCellValue) return

      // Validate the new value against the column type
      const colType = columnTypeMap.get(colName)
      if (colType && newCellValue !== null) {
        const validation = validateValueForType(newCellValue, colType)
        if (!validation.isValid) {
          const typeDisplay = getTypeDisplayName(colType)
          toast({
            title: 'Invalid value',
            description: `${validation.error}. Column "${colName}" expects ${typeDisplay}${validation.formatHint ? ` (${validation.formatHint})` : ''}.`,
            variant: 'destructive',
          })
          // Block the edit - don't proceed
          return
        }
      }

      // Get the row's _cs_id for the command
      const csId = rowIndexToCsId.get(row)
      if (!csId) {
        console.error('[DATAGRID] No csId found for row', row)
        // Fallback to legacy method if no csId
        try {
          await initializeTimeline(tableId, tableName)
          const result = await updateCell(tableName, row, colName, newCellValue)
          if (result.csId) {
            // Update local data state
            setData((prevData) => {
              const newData = [...prevData]
              if (newData[adjustedRow]) {
                newData[adjustedRow] = { ...newData[adjustedRow], [colName]: newCellValue }
              }
              return newData
            })
            // Record legacy edit
            recordEdit({
              tableId, tableName, rowIndex: row, columnName: colName,
              previousValue, newValue: newCellValue, timestamp: new Date(),
            })
            const timelineParams: ManualEditParams = {
              type: 'manual_edit', csId: result.csId, columnName: colName,
              previousValue, newValue: newCellValue,
            }
            await recordCommand(tableId, tableName, 'manual_edit', `Edit cell [${row}, ${colName}]`,
              timelineParams, { affectedRowIds: [result.csId], affectedColumns: [colName],
                cellChanges: [{ csId: result.csId, columnName: colName, previousValue, newValue: newCellValue }],
                rowsAffected: 1 })
          }
        } catch (error) {
          console.error('Failed to update cell (fallback):', error)
        }
        return
      }

      try {
        // Check if batching is enabled
        if (isBatchingEnabled()) {
          console.log('[DATAGRID] Adding cell edit to batch...')

          // Update local data state immediately (UI feedback)
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

          // Record to legacy editStore for backward compatibility
          recordEdit({
            tableId,
            tableName,
            rowIndex: row,
            columnName: colName,
            previousValue,
            newValue: newCellValue,
            timestamp: new Date(),
          })

          // Mark table as dirty immediately (shows "unsaved changes" indicator)
          useUIStore.getState().markTableDirty(tableId)

          // Add edit to batch store (will be flushed after 500ms of no edits)
          // This batches rapid edits into a single audit log entry
          addEditToBatch(tableId, {
            csId,
            columnName: colName,
            previousValue,
            newValue: newCellValue,
            timestamp: Date.now(),
          })

          console.log('[DATAGRID] Cell edit added to batch')
        } else {
          // Batching disabled - execute immediately (for tests)
          console.log('[DATAGRID] Creating edit:cell command (batching disabled)...')

          const command = createCommand('edit:cell', {
            tableId,
            tableName,
            csId,
            columnName: colName,
            previousValue,
            newValue: newCellValue,
          })

          const result = await getCommandExecutor().execute(command)

          if (result.success) {
            console.log('[DATAGRID] Cell edit successful via CommandExecutor')

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

            // Record to legacy editStore for backward compatibility
            recordEdit({
              tableId,
              tableName,
              rowIndex: row,
              columnName: colName,
              previousValue,
              newValue: newCellValue,
              timestamp: new Date(),
            })

            // Trigger re-render for dirty cell tracking
            setExecutorTimelineVersion((v) => v + 1)
          } else {
            console.error('[DATAGRID] Cell edit failed:', result.error)
          }
        }
      } catch (error) {
        console.error('Failed to process cell edit:', error)
      }
    },
    [editable, tableId, tableName, columns, loadedRange.start, data, rowIndexToCsId, recordEdit, addEditToBatch, columnTypeMap]
  )

  // Custom cell drawing to show dirty indicator and timeline highlights
  // Uses VS Code-style left gutter bar for edit indicators:
  // - Orange bar = pending edit (in batch store, not yet in DuckDB)
  // - Green bar = committed edit (in DuckDB timeline, dirty state)
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

      // Check for pending batch edit (not yet committed to DuckDB)
      // These are edits in the 500ms batching window before flush
      let hasPendingEdit = false
      if (csId && tableId) {
        const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId)
        hasPendingEdit = pendingEdits.some(
          e => e.csId === csId && e.columnName === colName
        )
      }

      // Check for committed edit (in DuckDB timeline, shown as dirty)
      const isCellDirty = cellKey && dirtyCells.has(cellKey)

      // VS Code-style left gutter bar indicator
      // Draw on first column (col === 0) to create a row-level indicator
      // This makes edit state highly visible during scroll
      // CRITICAL: Check row-level status BEFORE the condition, not inside it
      // Otherwise we never enter the block if column 0 itself isn't dirty
      let rowHasPendingEdit = false
      let rowIsDirty = false

      if (col === 0 && csId && tableId) {
        // Check if ANY cell in this row has a pending edit
        const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId)
        rowHasPendingEdit = pendingEdits.some(e => e.csId === csId)

        // Check if ANY cell in this row is dirty (committed edit)
        for (const c of columns) {
          if (dirtyCells.has(`${csId}:${c}`)) {
            rowIsDirty = true
            break
          }
        }
      }

      // Draw gutter bar if ANY cell in the row has edits
      if (editable && col === 0 && (rowHasPendingEdit || rowIsDirty)) {
        ctx.save()
        // Draw full-height bar on left edge of row (VS Code git diff style)
        const barWidth = 3
        // Orange (#f97316) = pending edit, Green (#22c55e) = committed
        ctx.fillStyle = rowHasPendingEdit ? '#f97316' : '#22c55e'
        ctx.fillRect(rect.x, rect.y, barWidth, rect.height)
        ctx.restore()
      }

      // Also draw cell-level indicator for specific edited cells (beyond first column)
      // This provides per-cell granularity while keeping the row-level bar visible
      if (editable && col > 0 && hasPendingEdit) {
        ctx.save()
        // Small dot in top-left corner for edited cells
        ctx.beginPath()
        ctx.arc(rect.x + 6, rect.y + 6, 3, 0, Math.PI * 2)
        ctx.fillStyle = '#f97316' // orange for pending
        ctx.fill()
        ctx.restore()
      }

      // Keep the existing red triangle for committed dirty cells (col > 0)
      // This maintains visual consistency with the existing dirty cell indicator
      if (editable && col > 0 && isCellDirty && !hasPendingEdit) {
        ctx.save()
        // Draw a small green triangle in the top-right corner (committed)
        const triangleSize = 8
        ctx.beginPath()
        ctx.moveTo(rect.x + rect.width - triangleSize, rect.y)
        ctx.lineTo(rect.x + rect.width, rect.y)
        ctx.lineTo(rect.x + rect.width, rect.y + triangleSize)
        ctx.closePath()
        ctx.fillStyle = '#22c55e' // green-500 for committed
        ctx.fill()
        ctx.restore()
      }
    },
    [editable, columns, dirtyCells, rowIndexToCsId, activeHighlight, tableId]
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

  // Handle column resize end - persist the new width to store
  // Note: onColumnResize fires during drag (for immediate visual feedback)
  // onColumnResizeEnd fires when user releases - that's when we persist
  const handleColumnResizeEnd = useCallback(
    (column: GridColumn, newSize: number) => {
      if (!tableId || !column.id) return
      // Persist the new width
      updateColumnWidth(tableId, column.id as string, newSize)
    },
    [tableId, updateColumnWidth]
  )

  // Handle header click - show persistent type tooltip (or open filter menu)
  // Currently we show the tooltip on click, but the ColumnHeaderMenu is attached via
  // a custom header renderer which Glide Data Grid doesn't directly support.
  // Instead, we'll track the click and show the tooltip for type info.
  const handleHeaderClicked = useCallback(
    (col: number, event: { bounds: { x: number; y: number; width: number; height: number } }) => {
      const colName = columns[col]
      const colType = columnTypeMap.get(colName)
      if (colType) {
        const typeDisplay = getTypeDisplayName(colType)
        const typeDescription = getTypeDescription(colType)
        setHeaderTooltip({
          column: colName,
          type: typeDisplay,
          description: typeDescription,
          x: event.bounds.x + event.bounds.width / 2,
          y: event.bounds.y + event.bounds.height,
        })
        // No auto-hide - tooltip stays until click outside or Escape
      }
    },
    [columns, columnTypeMap]
  )

  // Dismiss tooltip on click outside or Escape key
  useEffect(() => {
    if (!headerTooltip) return

    const handleClickOutside = () => {
      setHeaderTooltip(null)
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHeaderTooltip(null)
      }
    }

    // Delay adding listeners to avoid immediate dismissal from the click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [headerTooltip])

  // Row height constants for word wrap
  // Using fixed heights for performance with large datasets (400k+ rows)
  // Dynamic per-row calculation is too expensive as it requires O(rows × columns) operations
  const BASE_ROW_HEIGHT = 33
  const WORD_WRAP_ROW_HEIGHT = 80 // Match official demo row height

  // Track word wrap changes to force grid remount
  // When row height changes dramatically (33px ↔ 80px), Glide Data Grid's virtualization
  // gets confused. A clean remount with a new key is the simplest reliable fix.
  const [gridKey, setGridKey] = useState(0)
  const prevWordWrapRef = useRef(wordWrapEnabled)

  useEffect(() => {
    if (prevWordWrapRef.current !== wordWrapEnabled) {
      pageCacheRef.current.clear()
      setGridKey(k => k + 1)
    }
    prevWordWrapRef.current = wordWrapEnabled
  }, [wordWrapEnabled])


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

  // Compute effective row count (filtered or total)
  const effectiveRowCount = filteredRowCount ?? rowCount

  return (
    <div className="flex flex-col h-full w-full">
      {/* Filter Bar - always visible for easy filter access */}
      {tableId && columnTypes && (
        <FilterBar
          columns={columnTypes}
          filters={viewState?.filters ?? []}
          filteredCount={filteredRowCount}
          totalCount={rowCount}
          sortColumn={viewState?.sortColumn ?? null}
          sortDirection={viewState?.sortDirection ?? 'asc'}
          onSetFilter={handleSetFilter}
          onRemoveFilter={handleRemoveFilter}
          onClearAllFilters={handleClearAllFilters}
          onClearSort={handleClearSort}
        />
      )}

      <div ref={containerRef} className="flex-1 min-h-0 w-full gdg-container" data-testid="data-grid">
        {data.length > 0 && (
          <DataGridLib
            key={gridKey}
            ref={gridRef}
            columns={gridColumns}
            rows={effectiveRowCount}
            getCellContent={getCellContent}
            onVisibleRegionChanged={onVisibleRegionChanged}
            getRowThemeOverride={getRowThemeOverride}
            onCellClicked={
              onCellClick
                ? ([col, row]) => onCellClick(col, row)
                : undefined
            }
            onCellEdited={editable ? onCellEdited : undefined}
            // drawCell provides edit indicators (orange/green gutter bars, yellow highlights)
            // but conflicts with word wrap - glide-data-grid's draw() doesn't forward allowWrapping.
            // Trade-off: word wrap ON = no edit indicators, word wrap OFF = edit indicators work
            drawCell={editable && !wordWrapEnabled ? drawCell : undefined}
            // Fixed row height for word wrap (dynamic calculation too expensive for large datasets)
            rowHeight={wordWrapEnabled ? WORD_WRAP_ROW_HEIGHT : BASE_ROW_HEIGHT}
            // Column resize support
            onColumnResize={handleColumnResizeEnd}
            minColumnWidth={GLOBAL_MIN_COLUMN_WIDTH}
            maxColumnWidth={GLOBAL_MAX_COLUMN_WIDTH}
            maxColumnAutoWidth={MAX_COLUMN_AUTO_WIDTH}
            // Header click shows type tooltip
            onHeaderClicked={handleHeaderClicked}
            // Custom subtle header icons for column types
            headerIcons={customHeaderIcons}
            width={gridWidth}
            height={gridHeight}
            smoothScrollX
            smoothScrollY
            // Enable experimental hyperWrapping for proper text wrapping support
            experimental={{ hyperWrapping: true }}
            theme={gridTheme}
          />
        )}
      </div>

      {/* Column header popover - shown on header click, with filter/sort options */}
      {headerTooltip && tableId && (
        <ColumnHeaderMenu
          columnName={headerTooltip.column}
          columnType={columnTypeMap.get(headerTooltip.column) ?? 'VARCHAR'}
          currentFilter={getColumnFilter(headerTooltip.column)}
          currentSortColumn={viewState?.sortColumn ?? null}
          currentSortDirection={viewState?.sortDirection ?? 'asc'}
          onSetFilter={handleSetFilter}
          onRemoveFilter={() => handleRemoveFilter(headerTooltip.column)}
          onSetSort={(direction) => handleSetSort(headerTooltip.column, direction)}
          onClearSort={handleClearSort}
        >
          <div
            className="fixed z-50 px-3 py-2 text-xs bg-zinc-800 text-zinc-200 rounded-lg shadow-lg border border-zinc-600 cursor-pointer hover:bg-zinc-700 transition-colors"
            style={{
              left: headerTooltip.x,
              top: headerTooltip.y + 6,
              transform: 'translateX(-50%)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-medium text-zinc-100">
              {headerTooltip.column}
            </div>
            <div className="text-zinc-400 mt-0.5">
              Type: <span className="text-amber-400">{headerTooltip.type}</span>
            </div>
            <div className="text-zinc-500 mt-1 text-[10px]">
              {headerTooltip.description}
            </div>
          </div>
        </ColumnHeaderMenu>
      )}

      {/* Fallback tooltip for non-editable grids */}
      {headerTooltip && !tableId && (
        <div
          className="fixed z-50 px-3 py-2 text-xs bg-zinc-800 text-zinc-200 rounded-lg shadow-lg border border-zinc-600"
          style={{
            left: headerTooltip.x,
            top: headerTooltip.y + 6,
            transform: 'translateX(-50%)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="font-medium text-zinc-100">{headerTooltip.column}</div>
          <div className="text-zinc-400 mt-0.5">
            Type: <span className="text-amber-400">{headerTooltip.type}</span>
          </div>
          <div className="text-zinc-500 mt-1 text-[10px]">
            {headerTooltip.description}
          </div>
        </div>
      )}

      {/* Confirm Discard Undone Operations Dialog */}
      {editable && <ConfirmDiscardDialog {...confirmDialogProps} />}
    </div>
  )
}
