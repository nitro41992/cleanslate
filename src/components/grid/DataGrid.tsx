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
import { useEditBatchStore, type PendingEdit, isBatchingEnabled } from '@/stores/editBatchStore'
import { updateCell, estimateCsIdForRow } from '@/lib/duckdb'
import { recordCommand, initializeTimeline } from '@/lib/timeline-engine'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
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
  highlightedRows,
  highlightedCells: _highlightedCells,
  onCellClick,
  editable = false,
  tableId,
  timelineHighlight,
  ghostRows: _ghostRows = [],
  dataVersion,
}: DataGridProps) {
  const { getData, getDataWithRowIds, getDataWithKeyset } = useDuckDB()
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
  useEffect(() => {
    if (!tableId || !tableName) return

    useEditBatchStore.getState()._setFlushCallback(async (batchTableId: string, edits: PendingEdit[]) => {
      // Only process if this is our table
      if (batchTableId !== tableId) return
      if (edits.length === 0) return

      console.log(`[DATAGRID] Flushing batch of ${edits.length} edits for ${tableName}`)

      try {
        // Create batch command with all accumulated edits
        const command = createCommand('edit:batch', {
          tableId,
          tableName,
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

    // Load initial data using keyset pagination for O(1) performance
    getDataWithKeyset(tableName, { direction: 'forward', csId: null }, PAGE_SIZE)
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
  }, [tableName, columns, getData, getDataWithRowIds, getDataWithKeyset, rowCount, dataVersion, isReplaying, isBusy])

  // Track previous values to detect changes
  const prevHighlightCommandId = useRef<string | null | undefined>(undefined)
  const prevTimelinePosition = useRef<number>(-1)

  // Helper to invalidate visible cells in the grid
  const invalidateVisibleCells = useCallback(() => {
    if (!gridRef.current) return
    const cellsToUpdate: { cell: [number, number] }[] = []
    const visibleStart = loadedRange.start
    const visibleEnd = Math.min(loadedRange.end, loadedRange.start + 50) // Limit to 50 cells for performance
    for (let row = visibleStart; row < visibleEnd; row++) {
      cellsToUpdate.push({ cell: [0, row] })
    }
    if (cellsToUpdate.length > 0) {
      gridRef.current.updateCells(cellsToUpdate)
    }
  }, [loadedRange])

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
  const timelinePosition = timeline?.currentPosition ?? -1
  useEffect(() => {
    if (prevTimelinePosition.current !== timelinePosition) {
      invalidateVisibleCells()
    }
    prevTimelinePosition.current = timelinePosition
  }, [timelinePosition, invalidateVisibleCells])

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

            const pageResult = await getDataWithKeyset(
              tableName,
              { direction: 'forward', csId: targetCsId },
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
    [getData, getDataWithRowIds, getDataWithKeyset, tableName, rowCount, loadedRange]
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

  // Compute reverse map: row index -> csId for the loaded range
  const rowIndexToCsId = useMemo(() => {
    const map = new Map<number, string>()
    for (const [csId, rowIndex] of csIdToRowIndex) {
      map.set(rowIndex, csId)
    }
    return map
  }, [csIdToRowIndex])

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
    [editable, tableId, tableName, columns, loadedRange.start, data, rowIndexToCsId, recordEdit, addEditToBatch]
  )

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
    <>
      <div ref={containerRef} className="h-full w-full gdg-container min-h-[400px]" data-testid="data-grid">
        {data.length > 0 && (
          <DataGridLib
            ref={gridRef}
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

      {/* Confirm Discard Undone Operations Dialog */}
      {editable && <ConfirmDiscardDialog {...confirmDialogProps} />}
    </>
  )
}
