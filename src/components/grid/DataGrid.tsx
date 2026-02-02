import { useCallback, useMemo, useEffect, useLayoutEffect, useState, useRef } from 'react'
import DataGridLib, {
  GridColumn,
  GridCellKind,
  Item,
  GetRowThemeCallback,
  EditableGridCell,
  DrawCellCallback,
  DataEditorRef,
  Highlight,
  Rectangle,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { Table as ArrowTable } from 'apache-arrow'
import { useDuckDB } from '@/hooks/useDuckDB'
import { Skeleton } from '@/components/ui/skeleton'
import { useEditStore } from '@/stores/editStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { useUIStore } from '@/stores/uiStore'
import { useTableStore } from '@/stores/tableStore'
import { useEditBatchStore, type PendingEdit, isBatchingEnabled } from '@/stores/editBatchStore'
import { updateCell, estimateCsIdForRow } from '@/lib/duckdb'
import { recordCommand, initializeTimeline } from '@/lib/timeline-engine'
import { createCommand } from '@/lib/commands'
import { registerMemoryCleanup, unregisterMemoryCleanup } from '@/lib/memory-manager'
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
import { RowMenu } from '@/components/grid/RowMenu'
import { AddColumnDialog } from '@/components/grid/AddColumnDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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

/**
 * Format a value for display based on its column type.
 * DuckDB returns DATE as days since epoch and TIMESTAMP as microseconds since epoch
 * via Arrow format - this function converts them to human-readable strings.
 */
function formatValueByType(value: unknown, columnType: string | undefined): string {
  if (value === null || value === undefined) return ''

  const baseType = columnType?.toUpperCase().replace(/\(.*\)/, '') ?? ''

  // Handle DATE type
  // DuckDB may return dates as:
  // - Days since epoch (small numbers like 19000-20000 for recent dates)
  // - Milliseconds since epoch (13 digits like 1706659200000)
  // - Microseconds since epoch (16 digits)
  if (baseType === 'DATE') {
    if (typeof value === 'number' || typeof value === 'bigint') {
      try {
        const numValue = Number(value)
        let ms: number

        // Detect the unit based on magnitude
        if (Math.abs(numValue) >= 1e15) {
          // Microseconds range (16+ digits) - divide by 1000
          ms = numValue / 1000
        } else if (Math.abs(numValue) >= 1e12) {
          // Milliseconds range (13-15 digits) - use directly
          ms = numValue
        } else if (Math.abs(numValue) >= 1e9) {
          // Seconds range (10-12 digits) - multiply by 1000
          ms = numValue * 1000
        } else if (Math.abs(numValue) >= -25567 && Math.abs(numValue) <= 100000) {
          // Days since epoch range - convert to milliseconds
          ms = numValue * 86400000
        } else {
          // Unknown format - return as string
          return String(value)
        }

        // Validate: ms should be within JS Date range (roughly 1900 to 2200)
        if (ms >= -2208988800000 && ms <= 7289654400000) {
          const date = new Date(ms)
          if (!isNaN(date.getTime())) {
            // Format as YYYY-MM-DD (date only, no time)
            return date.toISOString().split('T')[0]
          }
        }
      } catch {
        // Fall through to String(value)
      }
    }
    return String(value)
  }

  // Handle TIMESTAMP types (DuckDB returns microseconds since Unix epoch via Arrow)
  // However, depending on how the TIMESTAMP was created, it may come as milliseconds
  if (baseType.includes('TIMESTAMP')) {
    if (typeof value === 'number' || typeof value === 'bigint') {
      try {
        const numValue = Number(value)

        // Detect the unit based on magnitude:
        // - Milliseconds for 2020: ~1,600,000,000,000 (13 digits)
        // - Microseconds for 2020: ~1,600,000,000,000,000 (16 digits)
        // - Nanoseconds for 2020: ~1,600,000,000,000,000,000 (19 digits)
        let ms: number
        if (Math.abs(numValue) >= 1e15) {
          // Microseconds range (16+ digits) - divide by 1000
          ms = numValue / 1000
        } else if (Math.abs(numValue) >= 1e12) {
          // Milliseconds range (13-15 digits) - use directly
          ms = numValue
        } else if (Math.abs(numValue) >= 1e9) {
          // Seconds range (10-12 digits) - multiply by 1000
          ms = numValue * 1000
        } else {
          // Very small number - likely days or invalid
          ms = numValue
        }

        // Validate: ms should be within JS Date range (roughly 1900 to 2200)
        if (ms >= -2208988800000 && ms <= 7289654400000) {
          const date = new Date(ms)
          if (!isNaN(date.getTime())) {
            // Format as YYYY-MM-DD HH:MM:SS
            return date.toISOString().replace('T', ' ').slice(0, 19)
          }
        }
      } catch {
        // Fall through to String(value)
      }
    }
    return String(value)
  }

  return String(value)
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
 * Now stores Arrow Table for O(1) columnar access instead of JSON arrays.
 */
interface CachedArrowPage {
  startRow: number
  /** Arrow Table with columnar data - use getChildAt(col).get(row) for O(1) access */
  arrowTable: ArrowTable
  /** Column names in order (excluding internal columns) */
  columns: string[]
  /** Map of row index (within page) to _cs_id for timeline highlighting */
  rowIndexToCsId: Map<number, string>
  firstCsId: string | null
  lastCsId: string | null
  /** Row count in this page (may be less than PAGE_SIZE for last page) */
  rowCount: number
  timestamp: number          // For LRU eviction
}

/**
 * Legacy JSON-based cache entry (kept for fallback compatibility)
 */
interface CachedPage {
  startRow: number
  rows: { csId: string; data: Record<string, unknown> }[]
  firstCsId: string | null
  lastCsId: string | null
  timestamp: number
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
  const { getData, getDataWithRowIds, getDataWithKeyset, getDataArrowWithKeyset, getFilteredCount } = useDuckDB()

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

  // ===== ARROW-BASED DATA STORAGE (Phase 2: Zero-Copy Transport) =====
  // Arrow Tables provide O(1) columnar access via vector.get(index)
  // This eliminates JSON serialization overhead for large datasets

  // Arrow page cache for O(1) cell access (keyed by start row)
  const arrowPageCacheRef = useRef<Map<number, CachedArrowPage>>(new Map())
  // Currently loaded Arrow pages for the visible range
  const loadedArrowPagesRef = useRef<CachedArrowPage[]>([])
  // Column name to index mapping for Arrow vector access
  const [arrowColumnIndexMap, setArrowColumnIndexMap] = useState<Map<string, number>>(new Map())

  // Legacy JSON data state (fallback for edits and compatibility)
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
  // "Stable" scroll position - only updated for meaningful scroll events, not grid resets
  // This survives the grid reset to {0,0} that happens during re-render
  const stableScrollRef = useRef<{ col: number; row: number } | null>(null)
  // Track the actual visible region from the grid's onVisibleRegionChanged callback.
  // CRITICAL: This is used by invalidateVisibleCells to know which rows to refresh.
  // Unlike loadedRange (which can be the entire table), this reflects what's on screen.
  // Without this, edit indicators (orange→green) won't update after scrolling.
  const visibleRegionRef = useRef<{ y: number; height: number }>({ y: 0, height: 50 })
  // Lock to prevent onVisibleRegionChanged from overwriting scroll position during reload
  const isReloadingRef = useRef(false)
  // Track previous dataVersion to detect reload triggers
  const prevDataVersionRef = useRef(dataVersion)
  // Track previous rowCount to detect row-only changes (no reload needed)
  const prevRowCountRef = useRef(rowCount)
  // Flag to skip next reload after local row injection
  const skipNextReloadRef = useRef(false)

  // Legacy LRU page cache for fallback (JSON-based)
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
  // Pending row insertion from insert_row command - for local state injection
  const pendingRowInsertion = useUIStore((s) => s.pendingRowInsertion)
  // Use prop if provided, otherwise fall back to store
  const activeHighlight = timelineHighlight ?? (storeHighlight.commandId ? storeHighlight : null)

  // Edit store for tracking edits (legacy)
  const recordEdit = useEditStore((s) => s.recordEdit)

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  // Track CommandExecutor timeline version for triggering re-renders
  const [executorTimelineVersion, setExecutorTimelineVersion] = useState(0)

  // Subscribe to the timeline for undo/redo awareness (used by other parts of the component)
  const timeline = useTimelineStore((s) => tableId ? s.timelines.get(tableId) : undefined)

  // Last edit location for edit indicators
  const lastEdit = useUIStore((s) => s.lastEdit)

  // Compute highlight regions for last edited cell using native grid API
  // This is more reliable than custom drawCell canvas drawing
  const lastEditHighlightRegions = useMemo((): readonly Highlight[] => {
    if (!lastEdit || lastEdit.tableId !== tableId || !editable) return []

    // Find the row index for the last edit csId
    // For deleted rows, highlight the "successor" row (the row now at that position)
    // Clamp to valid range in case deleted row was the last row
    let rowIndex: number | undefined
    if (lastEdit.editType === 'row_delete' && lastEdit.deletedRowIndex !== undefined) {
      // Clamp to valid range: if deleted last row, highlight new last row
      rowIndex = Math.min(lastEdit.deletedRowIndex, Math.max(0, rowCount - 1))
    } else {
      rowIndex = csIdToRowIndex.get(lastEdit.csId)
    }
    if (rowIndex === undefined || rowCount === 0) return []

    // For row inserts/deletes, highlight the entire row
    if (lastEdit.columnName === '*') {
      const range: Rectangle = {
        x: 0,
        y: rowIndex,
        width: columns.length,
        height: 1,
      }
      return [{
        color: lastEdit.editType === 'row_delete' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.25)',
        range,
        style: 'solid-outline',
      }]
    }

    // For cell edits, highlight just that cell
    const colIndex = columns.indexOf(lastEdit.columnName)
    if (colIndex === -1) return []

    const range: Rectangle = {
      x: colIndex,
      y: rowIndex,
      width: 1,
      height: 1,
    }
    return [{
      color: 'rgba(34, 197, 94, 0.25)', // green for committed edit
      range,
      style: 'solid-outline',
    }]
  }, [lastEdit, tableId, editable, csIdToRowIndex, columns, rowCount])

  /**
   * Invalidate Arrow pages containing the specified rows.
   * Forces getCellContent to read from React state on next access.
   *
   * This fixes the "stale Arrow cache" bug where cell edits succeed in DuckDB
   * but the grid shows old values because getCellContent reads from cached Arrow pages.
   */
  const invalidateArrowPagesForRows = useCallback((affectedRows: number[]) => {
    if (affectedRows.length === 0) return

    const minRow = Math.min(...affectedRows)
    const maxRow = Math.max(...affectedRows)

    // Clear affected pages from cache ref
    for (const [pageStart, page] of arrowPageCacheRef.current) {
      const pageEnd = pageStart + page.rowCount
      if (!(maxRow < pageStart || minRow >= pageEnd)) {
        arrowPageCacheRef.current.delete(pageStart)
      }
    }

    // Clear from loaded pages array
    loadedArrowPagesRef.current = loadedArrowPagesRef.current.filter(page => {
      const pageEnd = page.startRow + page.rowCount
      return maxRow < page.startRow || minRow >= pageEnd
    })

    console.log(`[DataGrid] Invalidated Arrow cache for rows ${minRow}-${maxRow}`)
  }, [])

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

        // Execute with confirmation if there are undone states that would be discarded
        const result = await executeWithConfirmation(command, batchTableId)

        // User cancelled - edits are discarded (batch will be cleared by caller)
        if (!result) {
          console.log('[DATAGRID] Batch edit cancelled by user - discarding edits')
          return
        }

        if (result.success) {
          console.log(`[DATAGRID] Batch edit successful: ${edits.length} cells`)

          // Invalidate Arrow cache for edited rows (only for current table's DataGrid)
          // This fixes the "stale Arrow cache" bug where cell edits succeed but grid shows old values
          if (batchTableId === tableId) {
            const editedRowIndices: number[] = []
            for (const edit of edits) {
              for (const [csId, rowIdx] of csIdToRowIndex) {
                if (csId === edit.csId) {
                  editedRowIndices.push(rowIdx)
                  break
                }
              }
            }
            invalidateArrowPagesForRows(editedRowIndices)
          }

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

          // Set lastEdit to the most recent edit in the batch (for gutter indicator)
          const lastEditInBatch = edits[edits.length - 1]
          useUIStore.getState().setLastEdit({
            tableId: batchTableId,
            csId: lastEditInBatch.csId,
            columnName: lastEditInBatch.columnName,
            editType: 'cell',
            timestamp: Date.now(),
          })

          // Trigger re-render for dirty cell tracking
          setExecutorTimelineVersion((v) => v + 1)
        } else {
          console.error('[DATAGRID] Batch edit failed:', result.error)
        }
      } catch (error) {
        console.error('[DATAGRID] Failed to execute batch edit:', error)
      }
    })
  }, [tableId, tableName, executeWithConfirmation, invalidateArrowPagesForRows, csIdToRowIndex])

  // Register page cache for memory cleanup when memory is critical
  // This allows the memory manager to clear grid caches when JS heap is high
  useEffect(() => {
    if (!tableId) return

    const cleanupId = `datagrid-${tableId}`
    registerMemoryCleanup(cleanupId, () => {
      pageCacheRef.current.clear()
      console.log(`[DataGrid] Cleared page cache for ${tableId}`)
    })

    return () => {
      unregisterMemoryCleanup(cleanupId)
    }
  }, [tableId])

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

  // Column menu state - shows column options on header click (includes type info)
  const [columnMenu, setColumnMenu] = useState<{
    column: string
    type: string
    typeDisplay: string
    description: string
    x: number
    y: number
  } | null>(null)

  // Row menu state - shows row operations on row marker click
  const [rowMenu, setRowMenu] = useState<{
    rowNumber: number
    csId: string
    x: number
    y: number
  } | null>(null)

  // Pending delete row confirmation - lifted from RowMenu to persist after menu closes
  const [pendingDeleteRow, setPendingDeleteRow] = useState<{
    rowNumber: number
    csId: string
  } | null>(null)

  // Pending delete column confirmation - lifted from ColumnHeaderMenu to persist after menu closes
  const [pendingDeleteColumn, setPendingDeleteColumn] = useState<{
    columnName: string
  } | null>(null)

  // Track mouse position for row marker clicks
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  // Track hovered item to detect row marker clicks
  // glide-data-grid adjusts location by rowMarkerOffset, so row markers report as col 0
  // but we need to detect when the actual column is -1 (before first data column)
  const hoveredItemRef = useRef<{ col: number; row: number } | null>(null)
  // Track if mouse is in the row marker area (leftmost ~50px of grid)
  const inRowMarkerAreaRef = useRef(false)


  // Add column dialog state
  const [addColumnDialog, setAddColumnDialog] = useState<{
    open: boolean
    position: 'left' | 'right'
    referenceColumn: string
  }>({ open: false, position: 'right', referenceColumn: '' })

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

  // Column operation handlers
  const handleInsertColumnLeft = useCallback((columnName: string) => {
    setAddColumnDialog({ open: true, position: 'left', referenceColumn: columnName })
    setColumnMenu(null)
  }, [])

  const handleInsertColumnRight = useCallback((columnName: string) => {
    setAddColumnDialog({ open: true, position: 'right', referenceColumn: columnName })
    setColumnMenu(null)
  }, [])

  const handleDeleteColumn = useCallback(async (columnName: string) => {
    if (!tableId || !tableName) {
      console.log('[DataGrid] Delete column skipped: missing tableId or tableName')
      return
    }

    try {
      const command = createCommand('schema:delete_column', {
        tableId,
        tableName,
        columnName,
      })

      const result = await executeWithConfirmation(command, tableId)
      if (result?.success) {
        toast({ title: 'Column deleted', description: `Column "${columnName}" has been deleted.` })
      } else if (result?.error) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
      } else if (result === undefined) {
        // User cancelled the operation (e.g., dismissed ConfirmDiscardDialog)
        console.log('[DataGrid] Delete column cancelled by user')
      }
    } catch (error) {
      console.error('[DataGrid] Delete column error:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete column',
        variant: 'destructive',
      })
    }
    setColumnMenu(null)
  }, [tableId, tableName, executeWithConfirmation])

  const handleAddColumnConfirm = useCallback(async (newColumnName: string) => {
    if (!tableId || !tableName) return

    const { position, referenceColumn } = addColumnDialog

    try {
      // Calculate insertAfter based on position
      const colIndex = columns.indexOf(referenceColumn)
      let insertAfter: string | null = null

      if (position === 'left') {
        // Insert before referenceColumn = insert after the previous column
        insertAfter = colIndex > 0 ? columns[colIndex - 1] : null
      } else {
        // Insert after referenceColumn
        insertAfter = referenceColumn
      }

      const command = createCommand('schema:add_column', {
        tableId,
        tableName,
        columnName: newColumnName,
        columnType: 'VARCHAR',
        insertAfter,
      })

      const result = await executeWithConfirmation(command, tableId)
      if (result?.success) {
        toast({ title: 'Column added', description: `Column "${newColumnName}" has been added.` })
      } else if (result?.error) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add column',
        variant: 'destructive',
      })
    }
  }, [tableId, tableName, columns, addColumnDialog, executeWithConfirmation])

  // Row operation handlers
  const handleInsertRowAbove = useCallback(async (csId: string) => {
    if (!tableId || !tableName) return

    try {
      // insertAfterCsId should be the row BEFORE the clicked row
      // We need to find the previous row's csId
      const rowIndex = csIdToRowIndex.get(csId)
      let insertAfterCsId: string | null = null

      if (rowIndex !== undefined && rowIndex > 0) {
        // Find the csId of the previous row by reversing the map
        for (const [id, idx] of csIdToRowIndex.entries()) {
          if (idx === rowIndex - 1) {
            insertAfterCsId = id
            break
          }
        }
      }

      const command = createCommand('data:insert_row', {
        tableId,
        tableName,
        insertAfterCsId,
      })

      const result = await executeWithConfirmation(command, tableId)
      if (result?.success) {
        toast({ title: 'Row inserted', description: 'A new row has been inserted.' })
        // Set lastEdit to the inserted row for gutter indicator
        const insertedRow = result.executionResult?.insertedRow
        if (insertedRow) {
          useUIStore.getState().setLastEdit({
            tableId,
            csId: insertedRow.csId,
            columnName: '*', // Entire row
            editType: 'row_insert',
            timestamp: Date.now(),
          })
        }
      } else if (result?.error) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to insert row',
        variant: 'destructive',
      })
    }
    setRowMenu(null)
  }, [tableId, tableName, csIdToRowIndex, executeWithConfirmation])

  const handleInsertRowBelow = useCallback(async (csId: string) => {
    if (!tableId || !tableName) return

    try {
      const command = createCommand('data:insert_row', {
        tableId,
        tableName,
        insertAfterCsId: csId,
      })

      const result = await executeWithConfirmation(command, tableId)
      if (result?.success) {
        toast({ title: 'Row inserted', description: 'A new row has been inserted.' })
        // Set lastEdit to the inserted row for gutter indicator
        const insertedRow = result.executionResult?.insertedRow
        if (insertedRow) {
          useUIStore.getState().setLastEdit({
            tableId,
            csId: insertedRow.csId,
            columnName: '*', // Entire row
            editType: 'row_insert',
            timestamp: Date.now(),
          })
        }
      } else if (result?.error) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to insert row',
        variant: 'destructive',
      })
    }
    setRowMenu(null)
  }, [tableId, tableName, executeWithConfirmation])

  const handleDeleteRow = useCallback(async (csId: string) => {
    if (!tableId || !tableName) return

    try {
      // Capture row data BEFORE deletion for phantom display
      const { query } = await import('@/lib/duckdb')
      const deletedRows = await query<Record<string, unknown>>(
        `SELECT * FROM "${tableName}" WHERE "_cs_id" = '${csId}'`
      )
      const deletedRowData = deletedRows[0] ?? null
      const deletedRowIndex = csIdToRowIndex.get(csId) ?? 0

      const command = createCommand('data:delete_row', {
        tableId,
        tableName,
        csIds: [csId],
      })

      const result = await executeWithConfirmation(command, tableId)
      if (result?.success) {
        toast({ title: 'Row deleted', description: 'The row has been deleted.' })
        // Set lastEdit to show phantom row for the deleted row
        if (deletedRowData) {
          useUIStore.getState().setLastEdit({
            tableId,
            csId,
            columnName: '*', // Entire row
            editType: 'row_delete',
            timestamp: Date.now(),
            deletedRowData,
            deletedRowIndex,
          })
        }
      } else if (result?.error) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete row',
        variant: 'destructive',
      })
    }
    setRowMenu(null)
  }, [tableId, tableName, executeWithConfirmation, csIdToRowIndex])

  // Handle column reorder via drag-drop
  const handleColumnMoved = useCallback((startIndex: number, endIndex: number) => {
    if (!tableId || startIndex === endIndex) return

    // Get the current column order
    const newColumnOrder = [...columns]
    const [movedColumn] = newColumnOrder.splice(startIndex, 1)
    newColumnOrder.splice(endIndex, 0, movedColumn)

    // Update column order in tableStore
    useTableStore.getState().setColumnOrder(tableId, newColumnOrder)

    console.log(`[DataGrid] Column moved: ${movedColumn} from ${startIndex} to ${endIndex}`)
  }, [tableId, columns])

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

  // Capture scroll position BEFORE main effect runs when dataVersion changes
  // useLayoutEffect runs synchronously before paint, catching the position before grid resets
  useLayoutEffect(() => {
    if (dataVersion !== prevDataVersionRef.current) {
      // dataVersion changed - a reload is coming, capture scroll position NOW
      // Use stableScrollRef which has the last meaningful (non-reset) position
      console.log('[DATAGRID] dataVersion changed, locking scroll:', stableScrollRef.current)
      isReloadingRef.current = true
      prevDataVersionRef.current = dataVersion
    }
  }, [dataVersion])

  // Handle pending row insertion - inject row into local state without reload
  // This preserves scroll position perfectly (industry best practice: optimistic local update)
  useEffect(() => {
    if (!pendingRowInsertion || pendingRowInsertion.tableId !== tableId) {
      return
    }

    const { csId, rowIndex } = pendingRowInsertion
    console.log('[DATAGRID] Injecting row locally:', { csId, rowIndex, loadedRange })

    // Clear the pending insertion immediately to prevent re-runs
    useUIStore.getState().setPendingRowInsertion(null)

    // Note: Green gutter indicator is now derived from timeline via insertedRowCsIds useMemo
    // The timeline already records the newCsId in the data:insert_row command

    // Check if the inserted row is within our currently loaded range
    // If not, no need to update local state - grid will fetch when scrolled
    if (rowIndex < loadedRange.start || rowIndex > loadedRange.end) {
      console.log('[DATAGRID] Inserted row outside loaded range, will be fetched on scroll')
      // Just invalidate cache so next scroll fetches fresh data
      pageCacheRef.current.clear()
      arrowPageCacheRef.current.clear()
      loadedArrowPagesRef.current = []
      return
    }

    // Create empty row data for the new row (all columns are NULL)
    const newRowData: Record<string, unknown> = {}
    for (const col of columns) {
      newRowData[col] = null
    }

    // Calculate local index within our data array
    const localIndex = rowIndex - loadedRange.start

    // Insert the new row into local data at the correct position
    setData(prevData => {
      const newData = [...prevData]
      newData.splice(localIndex, 0, newRowData)
      return newData
    })

    // Update csId to row index mapping
    // CRITICAL: The database shifts _cs_id values for rows >= newCsId.
    // e.g., if inserting csId "5" at index 4, old row with csId "5" becomes csId "6".
    // We must update BOTH the csId keys AND the indices.
    setCsIdToRowIndex(prevMap => {
      const newMap = new Map<string, number>()
      const newCsIdNum = parseInt(csId, 10)

      prevMap.forEach((idx, existingCsId) => {
        const existingCsIdNum = parseInt(existingCsId, 10)

        // Rows with csId >= newCsId had their csId shifted up in the database
        const updatedCsIdNum = existingCsIdNum >= newCsIdNum
          ? existingCsIdNum + 1
          : existingCsIdNum

        // Rows at or after rowIndex had their index shifted up
        const updatedIdx = idx >= rowIndex ? idx + 1 : idx

        newMap.set(String(updatedCsIdNum), updatedIdx)
      })

      // Add the new row
      newMap.set(csId, rowIndex)
      return newMap
    })

    // Update loaded range
    setLoadedRange(prev => ({ ...prev, end: prev.end + 1 }))

    // Invalidate cache so future fetches get fresh data
    pageCacheRef.current.clear()
    arrowPageCacheRef.current.clear()
    loadedArrowPagesRef.current = []

    // Force grid to re-render the affected area
    if (gridRef.current) {
      gridRef.current.updateCells([{ cell: [0, localIndex] }])
    }

    // Set flag to skip the next reload triggered by rowCount change
    skipNextReloadRef.current = true

    console.log('[DATAGRID] Row injected successfully at index', rowIndex)
  }, [pendingRowInsertion, tableId, columns, loadedRange])

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

    // Skip reload after local row injection (industry best practice: no full refresh)
    if (skipNextReloadRef.current) {
      skipNextReloadRef.current = false
      prevRowCountRef.current = rowCount
      console.log('[DATAGRID] Skipping fetch - row was injected locally')
      return
    }

    // Track rowCount changes
    prevRowCountRef.current = rowCount

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

    // Lock should already be set by useLayoutEffect, but ensure it's set
    isReloadingRef.current = true

    // Use stableScrollRef which was captured by useLayoutEffect before grid reset
    const savedScrollPosition = stableScrollRef.current
    console.log('[DATAGRID] Using saved scroll position:', savedScrollPosition)

    setIsLoading(true)
    // DON'T clear data immediately - keep old data visible until new data arrives
    // This preserves scroll position and prevents the grid from resetting to top
    // setData([]) - REMOVED: clearing data causes scroll reset
    // setLoadedRange({ start: 0, end: 0 }) - REMOVED: will be set with new data
    // setCsIdToRowIndex(new Map()) - REMOVED: will be set with new data
    pageCacheRef.current.clear() // Clear legacy JSON cache
    arrowPageCacheRef.current.clear() // Clear Arrow cache
    loadedArrowPagesRef.current = [] // Clear loaded Arrow pages

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

    // Load initial data using Arrow-based keyset pagination (Phase 2: Zero-Copy Transport)
    const cursor = {
      direction: 'forward' as const,
      csId: null,
      whereClause,
      orderByClause,
    }

    getDataArrowWithKeyset(tableName, cursor, PAGE_SIZE, 0)
      .then((arrowResult) => {
        const arrowRowCount = Math.min(arrowResult.arrowTable.numRows, PAGE_SIZE)
        console.log('[DATAGRID] Arrow data fetched, row count:', arrowRowCount)

        // Build column index map for O(1) Arrow vector lookup
        const colIndexMap = new Map<string, number>()
        const allCols = arrowResult.arrowTable.schema.fields.map(f => f.name)
        allCols.forEach((name, idx) => colIndexMap.set(name, idx))
        setArrowColumnIndexMap(colIndexMap)

        // Cache this Arrow page
        const arrowPage: CachedArrowPage = {
          startRow: 0,
          arrowTable: arrowResult.arrowTable,
          columns: arrowResult.columns,
          rowIndexToCsId: arrowResult.rowIndexToCsId,
          firstCsId: arrowResult.firstCsId,
          lastCsId: arrowResult.lastCsId,
          rowCount: arrowRowCount,
          timestamp: Date.now(),
        }
        arrowPageCacheRef.current.set(0, arrowPage)
        loadedArrowPagesRef.current = [arrowPage]

        // Build csId -> global row index map for timeline highlighting
        const idMap = new Map<string, number>()
        arrowResult.rowIndexToCsId.forEach((csId, localIdx) => {
          idMap.set(csId, localIdx) // localIdx == globalIdx for first page
        })

        // Extract JSON data for cell editing compatibility
        // This is still needed because cell edits update local state
        const jsonRows: Record<string, unknown>[] = []
        for (let i = 0; i < arrowRowCount; i++) {
          const row: Record<string, unknown> = {}
          for (const colName of arrowResult.columns) {
            const colIdx = colIndexMap.get(colName)
            if (colIdx !== undefined) {
              const vector = arrowResult.arrowTable.getChildAt(colIdx)
              row[colName] = vector?.get(i)
            }
          }
          jsonRows.push(row)
        }

        setData(jsonRows)
        setCsIdToRowIndex(idMap)
        setLoadedRange({ start: 0, end: arrowRowCount })
        setIsLoading(false)

        console.log('[DATAGRID] Arrow + JSON data ready for rendering')

        // Restore scroll position after data loads
        // Use setTimeout to ensure React has fully re-rendered the grid with new data
        console.log('[DATAGRID] Scroll restore check:', { savedScrollPosition, hasGridRef: !!gridRef.current })
        if (savedScrollPosition) {
          // Wait for React to render AND for grid to stabilize, then scroll
          // RAF alone isn't enough - grid needs time to process new row count
          setTimeout(() => {
            if (gridRef.current) {
              const { col, row } = savedScrollPosition
              const clampedRow = Math.min(row, Math.max(0, rowCount - 1))
              console.log('[DATAGRID] Attempting scroll restore:', { col, clampedRow, rowCount })
              gridRef.current.scrollTo(col, clampedRow)
              console.log('[DATAGRID] Restored scroll position:', { col, row: clampedRow })
            } else {
              console.log('[DATAGRID] gridRef.current still null after timeout')
            }
            // Release scroll lock after grid settles
            setTimeout(() => {
              isReloadingRef.current = false
            }, 50)
          }, 100) // 100ms delay for grid to fully stabilize
        } else {
          // Release scroll lock even when no position to restore
          requestAnimationFrame(() => {
            isReloadingRef.current = false
          })
        }
      })
      .catch((err) => {
        console.error('[DATAGRID] Arrow fetch failed, falling back to JSON:', err)
        // Fallback to legacy JSON-based getData
        getDataWithKeyset(tableName, cursor, PAGE_SIZE)
          .then((pageResult) => {
            const idMap = new Map<string, number>()
            const rows = pageResult.rows.map((row, index) => {
              if (row.csId) {
                idMap.set(row.csId, index)
              }
              return row.data
            })

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

            // Restore scroll position after fallback data loads
            if (savedScrollPosition) {
              setTimeout(() => {
                if (gridRef.current) {
                  const { col, row } = savedScrollPosition
                  const clampedRow = Math.min(row, Math.max(0, rowCount - 1))
                  gridRef.current.scrollTo(col, clampedRow)
                  console.log('[DATAGRID] Restored scroll position (fallback):', { col, row: clampedRow })
                }
                setTimeout(() => {
                  isReloadingRef.current = false
                }, 50)
              }, 100)
            } else {
              requestAnimationFrame(() => {
                isReloadingRef.current = false
              })
            }
          })
          .catch((fallbackErr) => {
            console.error('Error loading fallback data:', fallbackErr)
            setIsLoading(false)
            // Release scroll lock even on error
            requestAnimationFrame(() => {
              isReloadingRef.current = false
            })
          })
      })
  }, [tableName, columns, getData, getDataWithRowIds, getDataWithKeyset, getDataArrowWithKeyset, getFilteredCount, rowCount, dataVersion, isReplaying, isBusy, viewState])

  // Track previous values to detect changes
  const prevHighlightCommandId = useRef<string | null | undefined>(undefined)
  const prevTimelinePosition = useRef<number>(-1)

  // Helper to invalidate visible cells in the grid
  // For full grid refresh (e.g., word wrap), set allColumns=true
  //
  // IMPORTANT: Uses visibleRegionRef to get the actual visible rows from the grid's
  // onVisibleRegionChanged callback, NOT loadedRange which represents all loaded data
  // (could be the entire table). This ensures we invalidate the correct rows after
  // scrolling - critical for edit indicator updates (orange→green) to work correctly.
  const columnsLengthRef = useRef(columns.length)
  columnsLengthRef.current = columns.length

  const invalidateVisibleCells = useCallback((allColumns = false) => {
    if (!gridRef.current) return
    const visible = visibleRegionRef.current
    const cellsToUpdate: { cell: [number, number] }[] = []
    const visibleStart = visible.y
    const visibleEnd = visible.y + visible.height + 5 // Add small buffer for partial rows
    const colCount = allColumns ? columnsLengthRef.current : 1
    for (let row = visibleStart; row < visibleEnd; row++) {
      for (let col = 0; col < colCount; col++) {
        cellsToUpdate.push({ cell: [col, row] })
      }
    }
    if (cellsToUpdate.length > 0) {
      gridRef.current.updateCells(cellsToUpdate)
    }
  }, []) // No dependencies - always reads from refs

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

  // Subscribe to edit batch store to invalidate cells when pending edits are cleared.
  //
  // WHY THIS IS NEEDED:
  // The batch flush flow has a timing issue: setExecutorTimelineVersion is called INSIDE
  // the flushCallback (before it returns), but clearBatch is called AFTER flushCallback
  // returns. Since flushCallback has async operations (changelog save), the effect that
  // listens to executorTimelineVersion can fire and invalidate cells BEFORE clearBatch
  // clears the pending edits. Result: drawCell still sees pending edits and draws orange.
  //
  // SOLUTION: Subscribe directly to the edit batch store. When pendingEdits transitions
  // from non-empty to empty (clearBatch was called), invalidate the visible cells.
  // This guarantees invalidation happens AFTER the batch is actually cleared.
  const prevPendingEditsCountRef = useRef(0)
  const invalidateVisibleCellsRef = useRef(invalidateVisibleCells)
  invalidateVisibleCellsRef.current = invalidateVisibleCells
  useEffect(() => {
    if (!tableId) return

    const unsubscribe = useEditBatchStore.subscribe((state) => {
      const currentCount = state.pendingEdits.get(tableId)?.length ?? 0
      const prevCount = prevPendingEditsCountRef.current

      // When pending edits go from non-zero to zero, the batch was just cleared
      if (prevCount > 0 && currentCount === 0) {
        // Use rAF to ensure the grid has processed any pending React updates
        requestAnimationFrame(() => {
          invalidateVisibleCellsRef.current(true)
        })
      }

      prevPendingEditsCountRef.current = currentCount
    })

    // Initialize the ref with current count
    prevPendingEditsCountRef.current = useEditBatchStore.getState().pendingEdits.get(tableId)?.length ?? 0

    return unsubscribe
  }, [tableId])

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
      // But NOT during reload - otherwise we overwrite the saved position with {0, 0}
      if (!isReloadingRef.current) {
        scrollPositionRef.current = { col: range.x, row: range.y }
        // Also update stable scroll ref - this persists across reload cycles
        // Only update if this is a meaningful position (not a grid reset to {0,0})
        // A position of {0,0} is valid if user intentionally scrolled to top
        stableScrollRef.current = { col: range.x, row: range.y }
        // Track visible region for cell invalidation (edit indicator updates)
        visibleRegionRef.current = { y: range.y, height: range.height }
      }

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

        // ===== PHASE 2: Check Arrow cache first =====
        const cachedArrowPages: CachedArrowPage[] = []
        const missingArrowPageIndices: number[] = []

        for (let pageIdx = firstPageIdx; pageIdx <= lastPageIdx; pageIdx++) {
          const pageStartRow = pageIdx * PAGE_SIZE
          const cached = arrowPageCacheRef.current.get(pageStartRow)
          if (cached && cached.rowCount > 0) {
            cached.timestamp = Date.now() // Update LRU timestamp
            cachedArrowPages.push(cached)
          } else {
            missingArrowPageIndices.push(pageIdx)
          }
        }

        // If we have all Arrow pages cached, use them
        if (missingArrowPageIndices.length === 0 && cachedArrowPages.length > 0) {
          cachedArrowPages.sort((a, b) => a.startRow - b.startRow)
          const rangeStart = cachedArrowPages[0].startRow

          // Update Arrow pages ref for getCellContent
          loadedArrowPagesRef.current = cachedArrowPages

          // Build csId -> global row index map
          const idMap = new Map<string, number>()
          let totalRows = 0
          for (const page of cachedArrowPages) {
            page.rowIndexToCsId.forEach((csId, localIdx) => {
              idMap.set(csId, page.startRow + localIdx)
            })
            totalRows += page.rowCount
          }

          // Extract JSON for compatibility (cell edits need it)
          const mergedRows: Record<string, unknown>[] = []
          for (const page of cachedArrowPages) {
            for (let i = 0; i < page.rowCount; i++) {
              const row: Record<string, unknown> = {}
              for (const colName of page.columns) {
                const colIdx = arrowColumnIndexMap.get(colName)
                if (colIdx !== undefined) {
                  const vector = page.arrowTable.getChildAt(colIdx)
                  row[colName] = vector?.get(i)
                }
              }
              mergedRows.push(row)
            }
          }

          const rangeEnd = rangeStart + totalRows
          console.log(`[DATAGRID] Arrow cache hit: ${cachedArrowPages.length} pages (rows ${rangeStart}-${rangeEnd})`)
          setData(mergedRows)
          setCsIdToRowIndex(idMap)
          setLoadedRange({ start: rangeStart, end: rangeEnd })

          pendingRangeRef.current = null
          return
        }

        // Fetch missing pages using Arrow-based keyset pagination
        try {
          for (const pageIdx of missingArrowPageIndices) {
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

            const cursor = { direction: 'forward' as const, csId: targetCsId, whereClause, orderByClause }

            // Use Arrow-based fetch (Phase 2)
            const arrowResult = await getDataArrowWithKeyset(tableName, cursor, PAGE_SIZE, pageStartRow)

            if (abortController.signal.aborted) {
              console.log('[DATAGRID] Fetch aborted after page load')
              return
            }

            const arrowRowCount = Math.min(arrowResult.arrowTable.numRows, PAGE_SIZE)

            // Add to Arrow cache
            const newArrowPage: CachedArrowPage = {
              startRow: pageStartRow,
              arrowTable: arrowResult.arrowTable,
              columns: arrowResult.columns,
              rowIndexToCsId: arrowResult.rowIndexToCsId,
              firstCsId: arrowResult.firstCsId,
              lastCsId: arrowResult.lastCsId,
              rowCount: arrowRowCount,
              timestamp: Date.now(),
            }
            arrowPageCacheRef.current.set(pageStartRow, newArrowPage)
            cachedArrowPages.push(newArrowPage)

            // Evict oldest Arrow pages if cache is full
            while (arrowPageCacheRef.current.size > MAX_CACHED_PAGES) {
              let oldestKey = -1
              let oldestTime = Infinity
              for (const [key, page] of arrowPageCacheRef.current.entries()) {
                if (page.timestamp < oldestTime) {
                  oldestTime = page.timestamp
                  oldestKey = key
                }
              }
              if (oldestKey >= 0) {
                arrowPageCacheRef.current.delete(oldestKey)
              } else {
                break
              }
            }
          }

          if (abortController.signal.aborted) {
            console.log('[DATAGRID] Fetch aborted before state update')
            return
          }

          // Merge all Arrow pages
          cachedArrowPages.sort((a, b) => a.startRow - b.startRow)
          const rangeStart = cachedArrowPages[0].startRow

          // Update Arrow pages ref for getCellContent
          loadedArrowPagesRef.current = cachedArrowPages

          // Build csId -> global row index map
          const idMap = new Map<string, number>()
          let totalRows = 0
          for (const page of cachedArrowPages) {
            page.rowIndexToCsId.forEach((csId, localIdx) => {
              idMap.set(csId, page.startRow + localIdx)
            })
            totalRows += page.rowCount
          }

          // Extract JSON for compatibility
          const mergedRows: Record<string, unknown>[] = []
          for (const page of cachedArrowPages) {
            for (let i = 0; i < page.rowCount; i++) {
              const row: Record<string, unknown> = {}
              for (const colName of page.columns) {
                const colIdx = arrowColumnIndexMap.get(colName)
                if (colIdx !== undefined) {
                  const vector = page.arrowTable.getChildAt(colIdx)
                  row[colName] = vector?.get(i)
                }
              }
              mergedRows.push(row)
            }
          }

          const rangeEnd = rangeStart + totalRows
          console.log(`[DATAGRID] Arrow fetch: ${missingArrowPageIndices.length} new pages, ${cachedArrowPages.length} total (rows ${rangeStart}-${rangeEnd})`)
          setData(mergedRows)
          setCsIdToRowIndex(idMap)
          setLoadedRange({ start: rangeStart, end: rangeEnd })

          pendingRangeRef.current = null
        } catch (err) {
          if (abortController.signal.aborted) {
            return
          }
          // Fallback to legacy JSON-based fetch if Arrow fails
          console.log('[DATAGRID] Arrow fetch failed, falling back to JSON:', err)
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
    [getData, getDataWithRowIds, getDataWithKeyset, getDataArrowWithKeyset, tableName, rowCount, loadedRange, viewState, arrowColumnIndexMap]
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

  // Handle cell clicks (regular cells only - row markers use selection)
  const handleCellClicked = useCallback(
    (
      cell: Item,
      _event: { bounds: { x: number; y: number; width: number; height: number } }
    ) => {
      const [col, row] = cell
      // Regular cell click - delegate to prop if provided
      if (onCellClick) {
        onCellClick(col, row)
      }
    },
    [onCellClick]
  )

  // Handle item hover - track when mouse is over cells (including row markers)
  const handleItemHovered = useCallback(
    (args: { kind: string; location: readonly [number, number] }) => {
      hoveredItemRef.current = { col: args.location[0], row: args.location[1] }
    },
    []
  )

  // Track mouse position on the grid container
  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    mousePositionRef.current = { x: event.clientX, y: event.clientY }

    // Track if mouse is in the row marker area (leftmost ~50px of the grid container)
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const relativeX = event.clientX - rect.left
    // Row markers are typically in the first 40-50 pixels
    inRowMarkerAreaRef.current = relativeX < 50
  }, [])

  // Handle click on the grid container to detect row marker clicks
  const handleGridClick = useCallback(
    (event: React.MouseEvent) => {
      // Only handle clicks in the row marker area
      if (!inRowMarkerAreaRef.current || !editable) return

      const hovered = hoveredItemRef.current
      if (!hovered) return

      // The hovered location is adjusted by glide-data-grid (row marker offset removed)
      // So col 0 when in row marker area is actually the row marker
      // We need to check if we're in the row marker area AND have a valid row
      const row = hovered.row
      if (row < 0) return // Header area

      const csId = rowIndexToCsId.get(row)
      if (!csId) return

      // Show row menu at the click position
      setRowMenu({
        rowNumber: row + 1, // 1-based for display
        csId,
        x: event.clientX,
        y: event.clientY,
      })

      // Prevent event from propagating to grid (avoids selection)
      event.stopPropagation()
    },
    [rowIndexToCsId, editable]
  )

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const adjustedRow = row - loadedRange.start
      const colName = columns[col]
      const colType = columnTypeMap.get(colName)

      // ===== PHASE 2: O(1) Arrow Vector Access =====
      // Try to get value from Arrow pages first (zero-copy path)
      // This eliminates JSON serialization overhead for read-only cells
      let value: unknown = undefined
      let foundInArrow = false

      // Find the Arrow page containing this row
      const arrowPages = loadedArrowPagesRef.current
      for (const page of arrowPages) {
        if (row >= page.startRow && row < page.startRow + page.rowCount) {
          const localRow = row - page.startRow
          const colIdx = arrowColumnIndexMap.get(colName)
          if (colIdx !== undefined) {
            const vector = page.arrowTable.getChildAt(colIdx)
            if (vector) {
              value = vector.get(localRow)
              foundInArrow = true
            }
          }
          break
        }
      }

      // Fall back to JSON data if Arrow not available (for edits, compatibility)
      if (!foundInArrow) {
        const rowData = data[adjustedRow]
        if (!rowData) {
          return {
            kind: GridCellKind.Loading as const,
            allowOverlay: false,
            allowWrapping: wordWrapEnabled,
          }
        }
        value = rowData[colName]
      }

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

      // Format value based on column type (handles DATE/TIMESTAMP from DuckDB Arrow format)
      const displayValue = formatValueByType(value, colType)

      return {
        kind: GridCellKind.Text as const,
        data: displayValue,
        displayData: displayValue,
        allowOverlay: true,
        readonly: !editable,
        allowWrapping: wordWrapEnabled,
      }
    },
    [data, columns, loadedRange.start, editable, rowIndexToCsId, tableId, wordWrapEnabled, columnTypeMap, arrowColumnIndexMap]
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

          // Execute with confirmation if there are undone states that would be discarded
          const result = await executeWithConfirmation(command, tableId)

          // User cancelled - edit is not applied
          if (!result) {
            console.log('[DATAGRID] Cell edit cancelled by user')
            return
          }

          if (result.success) {
            console.log('[DATAGRID] Cell edit successful via CommandExecutor')

            // Invalidate Arrow cache for edited row
            // This fixes the "stale Arrow cache" bug where cell edits succeed but grid shows old values
            invalidateArrowPagesForRows([row])

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
    [editable, tableId, tableName, columns, loadedRange.start, data, rowIndexToCsId, recordEdit, addEditToBatch, columnTypeMap, executeWithConfirmation, invalidateArrowPagesForRows]
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

      // Pending edit indicators (orange) - drawn in drawCell
      // Committed edit indicators (green) are now handled natively via:
      // - highlightRegions: cell-level green outline
      // - getRowThemeOverride: row-level subtle background tint

      // Check if ANY cell in this row has a pending edit (for orange gutter bar)
      let rowHasPendingEdit = false
      if (col === 0 && csId && tableId) {
        const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId)
        rowHasPendingEdit = pendingEdits.some(e => e.csId === csId)
      }

      // Draw orange gutter bar for pending edits only
      // Committed edits use native getRowThemeOverride for background tint
      if (editable && col === 0 && rowHasPendingEdit) {
        ctx.save()
        const barWidth = 3
        ctx.fillStyle = '#f97316' // orange for pending
        ctx.fillRect(rect.x, rect.y, barWidth, rect.height)
        ctx.restore()
      }

      // Draw orange dot for pending cell edits (col > 0)
      if (editable && col > 0 && hasPendingEdit) {
        ctx.save()
        ctx.beginPath()
        ctx.arc(rect.x + 6, rect.y + 6, 3, 0, Math.PI * 2)
        ctx.fillStyle = '#f97316' // orange for pending
        ctx.fill()
        ctx.restore()
      }
    },
    [editable, columns, rowIndexToCsId, activeHighlight, tableId]
  )

  const getRowThemeOverride: GetRowThemeCallback = useCallback(
    (row: number) => {
      // Check for traditional highlightedRows (diff view) - highest priority
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

      // Check for last edit row (subtle background for row-level indicator)
      if (editable && lastEdit && lastEdit.tableId === tableId) {
        // For deleted rows, match by position (successor row) since csId no longer exists
        if (lastEdit.editType === 'row_delete' && lastEdit.deletedRowIndex !== undefined) {
          const targetRow = Math.min(lastEdit.deletedRowIndex, Math.max(0, rowCount - 1))
          if (row === targetRow && rowCount > 0) {
            return { bgCell: 'rgba(239, 68, 68, 0.08)' } // subtle red for deleted position
          }
        } else {
          // For other edits, match by csId
          const csId = rowIndexToCsId.get(row)
          if (csId && csId === lastEdit.csId) {
            return { bgCell: 'rgba(34, 197, 94, 0.08)' } // subtle green for edit/insert
          }
        }
      }

      return undefined
    },
    [highlightedRows, activeHighlight, rowIndexToCsId, editable, lastEdit, tableId, rowCount]
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

  // Handle header click - show column menu with type info and options
  const handleHeaderClicked = useCallback(
    (col: number, event: { bounds: { x: number; y: number; width: number; height: number } }) => {
      const colName = columns[col]
      const colType = columnTypeMap.get(colName) ?? 'VARCHAR'
      const typeDisplay = getTypeDisplayName(colType)
      const typeDescription = getTypeDescription(colType)

      setColumnMenu({
        column: colName,
        type: colType,
        typeDisplay,
        description: typeDescription,
        x: event.bounds.x + event.bounds.width / 2,
        y: event.bounds.y + event.bounds.height,
      })
    },
    [columns, columnTypeMap]
  )

  // Column menu dismissal is handled by the Popover component via onOpenChange

  // Dismiss row menu on click outside or Escape key
  useEffect(() => {
    if (!rowMenu) return

    const handleClickOutside = () => {
      setRowMenu(null)
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRowMenu(null)
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
  }, [rowMenu])

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

      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full gdg-container"
        data-testid="data-grid"
        onMouseMove={handleMouseMove}
        onClickCapture={handleGridClick}
      >
        {data.length > 0 && (
          <DataGridLib
            key={gridKey}
            ref={gridRef}
            columns={gridColumns}
            rows={effectiveRowCount}
            getCellContent={getCellContent}
            onVisibleRegionChanged={onVisibleRegionChanged}
            getRowThemeOverride={getRowThemeOverride}
            onCellClicked={handleCellClicked}
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
            // Track hover state to detect row marker clicks
            onItemHovered={handleItemHovered}
            // Custom subtle header icons for column types
            headerIcons={customHeaderIcons}
            // Row markers - show row numbers (1-based)
            // Row marker clicks are detected via onItemHovered + container onClick
            rowMarkers={{ kind: 'number', startIndex: 1 }}
            // Disable row selection (we show menu instead of selecting)
            rowSelect="none"
            // Disable column selection (we show menu instead of selecting)
            columnSelect="none"
            // Column reorder via drag-drop
            onColumnMoved={editable ? handleColumnMoved : undefined}
            width={gridWidth}
            height={gridHeight}
            smoothScrollX
            smoothScrollY
            // Enable experimental hyperWrapping for proper text wrapping support
            experimental={{ hyperWrapping: true }}
            theme={gridTheme}
            // Native highlight regions for last edit cell (more reliable than drawCell)
            highlightRegions={lastEditHighlightRegions}
          />
        )}
      </div>

      {/* Column header menu - shown on header click with type info and options */}
      {columnMenu && tableId && (
        <ColumnHeaderMenu
          columnName={columnMenu.column}
          columnType={columnMenu.type}
          columnTypeDisplay={columnMenu.typeDisplay}
          columnTypeDescription={columnMenu.description}
          currentSortColumn={viewState?.sortColumn ?? null}
          currentSortDirection={viewState?.sortDirection ?? 'asc'}
          onSetSort={(direction) => handleSetSort(columnMenu.column, direction)}
          onClearSort={handleClearSort}
          columnOperationsEnabled={editable}
          onInsertColumnLeft={() => handleInsertColumnLeft(columnMenu.column)}
          onInsertColumnRight={() => handleInsertColumnRight(columnMenu.column)}
          onDeleteColumn={() => {
            // Set pending delete to show confirmation dialog (lifted to DataGrid)
            setPendingDeleteColumn({ columnName: columnMenu.column })
            setColumnMenu(null)
          }}
          open={true}
          onOpenChange={(open) => { if (!open) setColumnMenu(null) }}
          anchorPosition={{ x: columnMenu.x, y: columnMenu.y }}
        />
      )}

      {/* Fallback type tooltip for non-editable grids (no menu, just info) */}
      {columnMenu && !tableId && (
        <div
          className="fixed z-50 px-3 py-2 text-xs bg-zinc-800 text-zinc-200 rounded-lg shadow-lg border border-zinc-600"
          style={{
            left: columnMenu.x,
            top: columnMenu.y + 6,
            transform: 'translateX(-50%)',
          }}
          onClick={() => setColumnMenu(null)}
        >
          <div className="font-medium text-zinc-100">{columnMenu.column}</div>
          <div className="text-zinc-400 mt-0.5">
            Type: <span className="text-amber-400">{columnMenu.typeDisplay}</span>
          </div>
          <div className="text-zinc-500 mt-1 text-[10px]">
            {columnMenu.description}
          </div>
        </div>
      )}

      {/* Confirm Discard Undone Operations Dialog */}
      {editable && <ConfirmDiscardDialog {...confirmDialogProps} />}

      {/* Row Menu - shown on row marker click */}
      {rowMenu && editable && (
        <RowMenu
          rowNumber={rowMenu.rowNumber}
          csId={rowMenu.csId}
          onInsertAbove={() => handleInsertRowAbove(rowMenu.csId)}
          onInsertBelow={() => handleInsertRowBelow(rowMenu.csId)}
          onDelete={() => {
            // Set pending delete to show confirmation dialog (lifted to DataGrid)
            setPendingDeleteRow({ rowNumber: rowMenu.rowNumber, csId: rowMenu.csId })
            setRowMenu(null)
          }}
          open={true}
          onOpenChange={(open) => { if (!open) setRowMenu(null) }}
          anchorPosition={{ x: rowMenu.x, y: rowMenu.y }}
        />
      )}

      {/* Add Column Dialog */}
      <AddColumnDialog
        open={addColumnDialog.open}
        onOpenChange={(open) => setAddColumnDialog(prev => ({ ...prev, open }))}
        position={addColumnDialog.position}
        referenceColumn={addColumnDialog.referenceColumn}
        onConfirm={handleAddColumnConfirm}
      />

      {/* Delete Row Confirmation Dialog - lifted from RowMenu to persist after menu closes */}
      <AlertDialog
        open={pendingDeleteRow !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteRow(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Row</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete row {pendingDeleteRow?.rowNumber}? This action can be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteRow) {
                  handleDeleteRow(pendingDeleteRow.csId)
                }
                setPendingDeleteRow(null)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Column Confirmation Dialog - lifted from ColumnHeaderMenu to persist after menu closes */}
      <AlertDialog
        open={pendingDeleteColumn !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteColumn(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Column</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the column "{pendingDeleteColumn?.columnName}"? This will remove all data in this column. This action can be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteColumn) {
                  handleDeleteColumn(pendingDeleteColumn.columnName)
                }
                setPendingDeleteColumn(null)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
