import { useCallback, useEffect, useRef, useState } from 'react'
import { X, ArrowLeft, EyeOff, AlertTriangle, RotateCcw, WrapText, XCircle, Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { DiffConfigPanel } from './DiffConfigPanel'
import { VirtualizedDiffGrid } from './VirtualizedDiffGrid'
import { DiffSummaryPills } from './DiffSummaryPills'
import { DiffExportMenu } from './DiffExportMenu'
import { useTableStore } from '@/stores/tableStore'
import { useDiffStore } from '@/stores/diffStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { useUIStore } from '@/stores/uiStore'
import { runDiff, cleanupDiffTable, cleanupDiffSourceFiles, clearDiffCaches, materializeDiffForPagination, cleanupMaterializedDiffView } from '@/lib/diff-engine'
import { getOriginalSnapshotName, hasOriginalSnapshot, tableExists } from '@/lib/duckdb'
import { toast } from 'sonner'

/**
 * Searchable column filter combobox for the diff view
 */
interface ColumnFilterComboboxProps {
  columns: string[]
  value: string | null
  onValueChange: (value: string | null) => void
}

function ColumnFilterCombobox({ columns, value, onValueChange }: ColumnFilterComboboxProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-48 h-8 justify-between text-xs"
        >
          {value ?? 'All columns'}
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0">
        <Command>
          <CommandInput placeholder="Search columns..." className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty>No column found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all"
                onSelect={() => {
                  onValueChange(null)
                  setOpen(false)
                }}
              >
                <Check
                  className={cn(
                    'mr-2 h-4 w-4',
                    value === null ? 'opacity-100' : 'opacity-0'
                  )}
                />
                All columns
              </CommandItem>
              {columns.map((col) => (
                <CommandItem
                  key={col}
                  value={col}
                  onSelect={() => {
                    onValueChange(col)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === col ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {col}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface DiffViewProps {
  open: boolean
  onClose: () => void
}

export function DiffView({ open, onClose }: DiffViewProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const getTimeline = useTimelineStore((s) => s.getTimeline)

  const {
    mode,
    tableA,
    tableB,
    keyColumns,
    diffTableName,
    sourceTableName,
    targetTableName,
    totalDiffRows,
    allColumns,
    keyOrderBy,
    summary,
    newColumns,
    removedColumns,
    storageType,
    isComparing,
    blindMode,
    wordWrapEnabled,
    statusFilter,
    columnFilter,
    setMode,
    setTableA,
    setTableB,
    setKeyColumns,
    setDiffConfig,
    setIsComparing,
    setBlindMode,
    toggleWordWrap,
    clearStatusFilter,
    setColumnFilter,
    reset,
    clearResults,
  } = useDiffStore()

  const tableAInfo = tables.find((t) => t.id === tableA)
  const tableBInfo = tables.find((t) => t.id === tableB)
  const activeTableInfo = tables.find((t) => t.id === activeTableId)
  const decrementBusy = useUIStore((s) => s.decrementBusy)
  const setSkipNextGridReload = useUIStore((s) => s.setSkipNextGridReload)

  // Track latest values for cleanup (avoid stale closure in unmount)
  const diffTableNameRef = useRef(diffTableName)
  const sourceTableNameRef = useRef(sourceTableName)
  const storageTypeRef = useRef(storageType)

  // Update refs when values change
  useEffect(() => {
    diffTableNameRef.current = diffTableName
    sourceTableNameRef.current = sourceTableName
    storageTypeRef.current = storageType
  }, [diffTableName, sourceTableName, storageType])

  // Safety net: decrement busy counter on unmount in case operation was interrupted
  useEffect(() => {
    return () => decrementBusy()
  }, [decrementBusy])

  // Cleanup temp table and source files when component unmounts
  // CRITICAL: Empty deps array - only run on unmount, NOT when values change
  // If cleanup runs on dep change, it deletes Parquet files while grid is still reading them
  // Use refs to access latest values without triggering cleanup on change
  useEffect(() => {
    return () => {
      const currentDiffTableName = diffTableNameRef.current
      const currentSourceTableName = sourceTableNameRef.current
      const currentStorageType = storageTypeRef.current

      // Fire-and-forget cleanup (non-blocking) - runs AFTER component unmounts
      // This ensures UI closes instantly while cleanup happens in background
      ;(async () => {
        try {
          if (currentDiffTableName) {
            // Cleanup materialized view first (if Parquet-backed)
            if (currentStorageType === 'parquet') {
              await cleanupMaterializedDiffView(currentDiffTableName)
            }
            await cleanupDiffTable(currentDiffTableName, currentStorageType || 'memory')
            // VACUUM to reclaim RAM from dropped diff table (non-blocking)
            if (currentStorageType === 'memory') {
              try {
                const { execute } = await import('@/lib/duckdb')
                await execute('VACUUM')
              } catch (err) {
                console.warn('[DiffView] VACUUM failed (non-fatal):', err)
              }
            }
          }
          if (currentSourceTableName) {
            await cleanupDiffSourceFiles(currentSourceTableName)
          }
          // Clear all diff caches to free memory
          clearDiffCaches()
        } catch (err) {
          console.warn('[DiffView] Cleanup error:', err)
        }
      })()
    }
     
  }, [])

  const handleRunDiff = useCallback(async () => {
    // Only require key columns for two-tables mode (preview uses _cs_id internally)
    if (mode === 'compare-tables' && keyColumns.length === 0) return

    // Clean up any existing diff table BEFORE creating a new one
    // This prevents orphaned diff tables from accumulating
    if (diffTableName) {
      console.log(`[Diff] Cleaning up previous diff table: ${diffTableName}`)
      // Fire-and-forget cleanup (non-blocking to keep UI responsive)
      // Cleanup materialized view first (if Parquet-backed)
      if (storageType === 'parquet') {
        cleanupMaterializedDiffView(diffTableName).catch(err => {
          console.warn('[Diff] Previous materialized view cleanup failed (non-fatal):', err)
        })
      }
      cleanupDiffTable(diffTableName, storageType || 'memory').catch(err => {
        console.warn('[Diff] Previous diff cleanup failed (non-fatal):', err)
      })
      // Also cleanup source files if Parquet-backed
      if (sourceTableName) {
        cleanupDiffSourceFiles(sourceTableName).catch(err => {
          console.warn('[Diff] Previous source cleanup failed (non-fatal):', err)
        })
      }
    }

    setIsComparing(true)
    try {
      let sourceTableName: string
      let targetTableName: string

      if (mode === 'compare-preview') {
        // Compare original snapshot with current table
        if (!activeTableInfo) {
          throw new Error('No active table selected')
        }

        // Check for old-style snapshot first
        const oldSnapshotName = getOriginalSnapshotName(activeTableInfo.name)
        const hasOldSnapshot = await hasOriginalSnapshot(activeTableInfo.name)

        if (hasOldSnapshot) {
          sourceTableName = oldSnapshotName
        } else {
          // Check for timeline-based snapshot
          const timeline = getTimeline(activeTableInfo.id)
          if (timeline?.originalSnapshotName) {
            const originalSnapshotName = timeline.originalSnapshotName

            // Use the Parquet path directly (don't create temp table)
            // fetchDiffPage will handle reading from Parquet on-demand
            if (originalSnapshotName.startsWith('parquet:')) {
              sourceTableName = originalSnapshotName
            } else {
              // Use in-memory snapshot directly
              const timelineSnapshotExists = await tableExists(originalSnapshotName)
              if (timelineSnapshotExists) {
                sourceTableName = originalSnapshotName
              } else {
                throw new Error('No original snapshot found for comparison')
              }
            }
          } else {
            throw new Error('No original snapshot found for comparison')
          }
        }
        targetTableName = activeTableInfo.name
      } else {
        // Compare two selected tables
        if (!tableAInfo || !tableBInfo) {
          throw new Error('Please select both tables')
        }
        sourceTableName = tableAInfo.name
        targetTableName = tableBInfo.name
      }

      // runDiff(tableA, tableB) where A=source/original, B=target/current
      // Semantic model:
      // - a.key IS NULL → 'added' (row in B only = new row in current)
      // - b.key IS NULL → 'removed' (row in A only = deleted from current)
      // - newColumns = columns in A but not B = columns REMOVED from current
      // - removedColumns = columns in B but not A = columns ADDED to current (user's "new columns")

      // DIAGNOSTIC: Log what we're comparing
      console.log('[Diff] Comparison details:', {
        sourceTableName,
        targetTableName,
        mode,
        keyColumns,
        timestamp: new Date().toISOString()
      })

      const config = await runDiff(
        sourceTableName,   // original snapshot (A) - may be "parquet:snapshot_abc"
        targetTableName,   // current table (B)
        keyColumns,
        mode === 'compare-preview' ? 'preview' : 'two-tables'  // Row-based for preview, key-based for two-tables
      )

      // For Parquet-backed diffs, materialize into temp table for fast keyset pagination
      // This converts O(n) OFFSET queries to O(1) keyset queries on scroll
      if (config.storageType === 'parquet' && config.totalDiffRows > 0) {
        console.log('[Diff] Materializing Parquet diff for fast pagination...')
        await materializeDiffForPagination(
          config.diffTableName,
          config.sourceTableName,
          config.targetTableName,
          config.allColumns,
          config.newColumns,
          config.removedColumns
        )
      }

      setDiffConfig({
        diffTableName: config.diffTableName,
        sourceTableName: config.sourceTableName,
        targetTableName: config.targetTableName,
        totalDiffRows: config.totalDiffRows,
        allColumns: config.allColumns,
        keyOrderBy: config.keyOrderBy,
        summary: config.summary,
        newColumns: config.newColumns,
        removedColumns: config.removedColumns,
        storageType: config.storageType,
      })

      toast.success('Comparison Complete', {
        description: `Found ${config.summary.added} added, ${config.summary.removed} removed, ${config.summary.modified} modified rows`,
      })
    } catch (error) {
      console.error('Diff failed:', error)
      toast.error('Comparison Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsComparing(false)
    }
  }, [mode, activeTableInfo, tableAInfo, tableBInfo, keyColumns, setIsComparing, setDiffConfig, getTimeline, diffTableName, sourceTableName, storageType])

  const handleNewComparison = useCallback(async () => {
    // Save old values for cleanup
    const oldDiffTableName = diffTableName
    const oldSourceTableName = sourceTableName
    const oldStorageType = storageType

    // Clear results and reset UI
    clearResults()
    setKeyColumns([])

    // Cleanup old files in background (after grid unmounts from clearResults)
    // Use setTimeout to ensure React has processed the clearResults state update
    setTimeout(async () => {
      if (oldDiffTableName) {
        // Cleanup materialized view first (if Parquet-backed)
        if (oldStorageType === 'parquet') {
          await cleanupMaterializedDiffView(oldDiffTableName)
        }
        await cleanupDiffTable(oldDiffTableName, oldStorageType || 'memory')

        // VACUUM to reclaim RAM from dropped diff table
        // Without this, dead rows stay in memory (can be 100s of MB for large diffs)
        if (oldStorageType === 'memory') {
          try {
            const { execute } = await import('@/lib/duckdb')
            const vacuumStart = performance.now()
            await execute('VACUUM')
            const vacuumTime = performance.now() - vacuumStart
            console.log(`[Diff] VACUUM after cleanup completed in ${vacuumTime.toFixed(0)}ms`)
          } catch (err) {
            console.warn('[Diff] VACUUM failed (non-fatal):', err)
          }
        }
      }
      if (oldSourceTableName) {
        await cleanupDiffSourceFiles(oldSourceTableName)
      }
    }, 0)
  }, [diffTableName, sourceTableName, storageType, clearResults, setKeyColumns])

  const handleClose = useCallback(() => {
    // Set flag to prevent DataGrid from reloading when busyCount changes
    setSkipNextGridReload(true)
    // Cleanup happens in useEffect unmount - just close UI immediately
    reset()
    onClose()
  }, [reset, onClose, setSkipNextGridReload])

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleClose])

  if (!open) return null

  const hasResults = diffTableName && summary

  return (
    <div
      className="fixed inset-0 z-50 bg-background/95 animate-in fade-in-0 duration-200"
      data-testid="diff-view"
    >
      {/* Header */}
      <header className="h-14 border-b border-border/50 bg-card/50 flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Tables
          </Button>

          <div className="h-6 w-px bg-border" />

          <h1 className="font-semibold tracking-tight">
            DELTA INSPECTOR
          </h1>

          {hasResults && (
            <>
              <div className="h-6 w-px bg-border" />
              <span className="text-sm text-muted-foreground">
                {mode === 'compare-preview'
                  ? `${activeTableInfo?.name} (Original vs Current)`
                  : `${tableAInfo?.name} vs ${tableBInfo?.name}`}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {hasResults && (
            <>
              {/* Blind Mode Toggle */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="blind-mode"
                        checked={blindMode}
                        onCheckedChange={setBlindMode}
                      />
                      <Label
                        htmlFor="blind-mode"
                        className="text-sm cursor-pointer flex items-center gap-1.5"
                      >
                        <EyeOff className="w-4 h-4" />
                        <span className="hidden sm:inline">Blind Mode</span>
                      </Label>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Hide status indicators for unbiased review</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              {/* Export Menu */}
              <DiffExportMenu
                diffTableName={diffTableName}
                sourceTableName={sourceTableName}
                targetTableName={targetTableName}
                keyOrderBy={keyOrderBy}
                summary={summary}
                allColumns={allColumns}
                keyColumns={keyColumns}
                newColumns={newColumns}
                removedColumns={removedColumns}
                tableAName={mode === 'compare-preview' ? activeTableInfo?.name || '' : tableAInfo?.name || ''}
                tableBName={mode === 'compare-preview' ? activeTableInfo?.name || '' : tableBInfo?.name || ''}
                totalRows={totalDiffRows}
                storageType={storageType || 'memory'}
              />

              {/* New Comparison Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewComparison}
                className="gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                New Comparison
              </Button>
            </>
          )}

          {/* Close Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="h-8 w-8"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex h-[calc(100vh-3.5rem)]">
        {/* Left Config Panel - Show only when no results */}
        {!hasResults && (
          <div className="w-80 border-r border-border/50 bg-card/30">
            <DiffConfigPanel
              tables={tables}
              mode={mode}
              onModeChange={setMode}
              tableA={tableA}
              tableB={tableB}
              onTableAChange={setTableA}
              onTableBChange={setTableB}
              activeTableId={activeTableId}
              activeTableName={activeTableInfo?.name || null}
              activeTableDataVersion={activeTableInfo?.dataVersion || null}
              keyColumns={keyColumns}
              isComparing={isComparing}
              onKeyColumnsChange={setKeyColumns}
              onRunDiff={handleRunDiff}
            />
          </div>
        )}

        {/* Results Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {hasResults ? (
            <>
              {/* Schema Changes Banner - shown when columns were added/removed */}
              {(removedColumns.length > 0 || newColumns.length > 0) && (
                <div className="px-4 py-3 border-b border-border/50 bg-emerald-500/10 flex items-center gap-3 flex-wrap">
                  {/* removedColumns = columns in B (current) not in A (original) = USER's NEW columns */}
                  {removedColumns.length > 0 && (
                    <div className="flex items-center gap-2 text-emerald-400">
                      <span className="text-xs font-medium uppercase tracking-wider">
                        {removedColumns.length} column{removedColumns.length !== 1 ? 's' : ''} added:
                      </span>
                      <span className="font-mono text-sm">
                        {removedColumns.join(', ')}
                      </span>
                    </div>
                  )}
                  {/* newColumns = columns in A (original) not in B (current) = USER's REMOVED columns */}
                  {newColumns.length > 0 && (
                    <div className="flex items-center gap-2 text-red-400">
                      <span className="text-xs font-medium uppercase tracking-wider">
                        {newColumns.length} column{newColumns.length !== 1 ? 's' : ''} removed:
                      </span>
                      <span className="font-mono text-sm line-through">
                        {newColumns.join(', ')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Summary Pills (clickable for filtering) */}
              <div className="p-4 border-b border-border/50 bg-card/30">
                <DiffSummaryPills summary={summary} />
              </div>

              {/* Controls Row */}
              <div className="px-4 py-2 border-b border-border/50 bg-card/20 flex items-center gap-3">
                {/* Column Filter Dropdown - Searchable */}
                <ColumnFilterCombobox
                  columns={allColumns
                    .filter(col => !keyColumns.includes(col))  // Exclude key columns
                    .filter(col => !newColumns.includes(col))  // Exclude columns only in original (removed)
                    .filter(col => !removedColumns.includes(col))  // Exclude columns only in current (new)
                  }
                  value={columnFilter}
                  onValueChange={setColumnFilter}
                />

                <div className="h-4 w-px bg-border" />

                {/* Word Wrap Toggle */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleWordWrap}
                        className={`h-8 px-3 gap-2 ${wordWrapEnabled ? 'bg-amber-500/20 text-amber-400' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        <WrapText className="w-4 h-4" />
                        <span className="text-xs">Wrap</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {wordWrapEnabled ? 'Disable word wrap' : 'Enable word wrap'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Clear Filters (only shown when filters active) */}
                {(statusFilter || columnFilter) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      clearStatusFilter()
                      setColumnFilter(null)
                    }}
                    className="h-8 px-3 gap-2 text-muted-foreground hover:text-foreground"
                  >
                    <XCircle className="w-4 h-4" />
                    <span className="text-xs">Clear Filters</span>
                  </Button>
                )}
              </div>

              {/* Virtualized Results Grid */}
              <div className="flex-1 min-h-0">
                <VirtualizedDiffGrid
                  diffTableName={diffTableName}
                  sourceTableName={sourceTableName}
                  targetTableName={targetTableName}
                  totalRows={totalDiffRows}
                  allColumns={allColumns}
                  keyColumns={keyColumns}
                  keyOrderBy={keyOrderBy}
                  blindMode={blindMode}
                  newColumns={newColumns}
                  removedColumns={removedColumns}
                  storageType={storageType || 'memory'}
                />
              </div>

              {/* Footer with row count */}
              <div className="px-4 py-2 border-t border-border/50 bg-card/30 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {(statusFilter || columnFilter) ? (
                    <>
                      Filtered view
                      {statusFilter && ` (${statusFilter.map(s => s === 'modified' ? 'changed' : s).join(', ')})`}
                      {columnFilter && ` - column: ${columnFilter}`}
                    </>
                  ) : (
                    <>
                      {totalDiffRows.toLocaleString()} differences
                      {summary.unchanged > 0 && ` (${summary.unchanged.toLocaleString()} unchanged rows hidden)`}
                    </>
                  )}
                </span>
                <div className="flex items-center gap-2 text-amber-500">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>
                    This is a comparison view. Results cannot be saved as a table.
                  </span>
                </div>
              </div>
            </>
          ) : (
            /* Empty State - Configure Instructions */
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center max-w-md">
                <div className="w-20 h-20 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-6">
                  <span className="text-4xl">⚡</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground mb-2">
                  Configure Your Comparison
                </h2>
                <p className="text-sm">
                  Select two tables and choose key columns to match rows between them.
                  The comparison will identify added, removed, and modified rows.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
