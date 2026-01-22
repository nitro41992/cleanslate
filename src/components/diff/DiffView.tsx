import { useCallback, useEffect } from 'react'
import { X, ArrowLeft, EyeOff, AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DiffConfigPanel } from './DiffConfigPanel'
import { VirtualizedDiffGrid } from './VirtualizedDiffGrid'
import { DiffSummaryPills } from './DiffSummaryPills'
import { DiffExportMenu } from './DiffExportMenu'
import { useTableStore } from '@/stores/tableStore'
import { useDiffStore } from '@/stores/diffStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { useUIStore } from '@/stores/uiStore'
import { runDiff, cleanupDiffTable } from '@/lib/diff-engine'
import { getOriginalSnapshotName, hasOriginalSnapshot, tableExists } from '@/lib/duckdb'
import { toast } from 'sonner'

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
    totalDiffRows,
    allColumns,
    keyOrderBy,
    summary,
    newColumns,
    removedColumns,
    isComparing,
    blindMode,
    setMode,
    setTableA,
    setTableB,
    setKeyColumns,
    setDiffConfig,
    setIsComparing,
    setBlindMode,
    reset,
    clearResults,
  } = useDiffStore()

  const tableAInfo = tables.find((t) => t.id === tableA)
  const tableBInfo = tables.find((t) => t.id === tableB)
  const activeTableInfo = tables.find((t) => t.id === activeTableId)
  const decrementBusy = useUIStore((s) => s.decrementBusy)

  // Safety net: decrement busy counter on unmount in case operation was interrupted
  useEffect(() => {
    return () => decrementBusy()
  }, [decrementBusy])

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  // Cleanup temp table when component unmounts or when starting new comparison
  useEffect(() => {
    return () => {
      if (diffTableName) {
        cleanupDiffTable(diffTableName)
      }
    }
  }, [diffTableName])

  const handleRunDiff = useCallback(async () => {
    if (keyColumns.length === 0) return

    // Cleanup previous temp table if exists
    if (diffTableName) {
      await cleanupDiffTable(diffTableName)
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
            const timelineSnapshotExists = await tableExists(timeline.originalSnapshotName)
            if (timelineSnapshotExists) {
              sourceTableName = timeline.originalSnapshotName
            } else {
              throw new Error('No original snapshot found for comparison')
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

      const config = await runDiff(
        sourceTableName,
        targetTableName,
        keyColumns
      )

      setDiffConfig({
        diffTableName: config.diffTableName,
        totalDiffRows: config.totalDiffRows,
        allColumns: config.allColumns,
        keyOrderBy: config.keyOrderBy,
        summary: config.summary,
        newColumns: config.newColumns,
        removedColumns: config.removedColumns,
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
  }, [mode, activeTableInfo, tableAInfo, tableBInfo, keyColumns, diffTableName, setIsComparing, setDiffConfig, getTimeline])

  const handleNewComparison = useCallback(async () => {
    // Cleanup current temp table
    if (diffTableName) {
      await cleanupDiffTable(diffTableName)
    }
    clearResults()
    setKeyColumns([])
  }, [diffTableName, clearResults, setKeyColumns])

  const handleClose = useCallback(async () => {
    // Cleanup temp table on close
    if (diffTableName) {
      await cleanupDiffTable(diffTableName)
    }
    reset()
    onClose()
  }, [diffTableName, reset, onClose])

  if (!open) return null

  const hasResults = diffTableName && summary

  return (
    <div
      className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm animate-in fade-in-0 duration-200"
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
                keyOrderBy={keyOrderBy}
                summary={summary}
                allColumns={allColumns}
                keyColumns={keyColumns}
                tableAName={mode === 'compare-preview' ? activeTableInfo?.name || '' : tableAInfo?.name || ''}
                tableBName={mode === 'compare-preview' ? activeTableInfo?.name || '' : tableBInfo?.name || ''}
                totalRows={totalDiffRows}
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
              {/* Summary Pills */}
              <div className="p-4 border-b border-border/50 bg-card/30">
                <DiffSummaryPills summary={summary} />
              </div>

              {/* Virtualized Results Grid */}
              <div className="flex-1 min-h-0">
                <VirtualizedDiffGrid
                  diffTableName={diffTableName}
                  totalRows={totalDiffRows}
                  allColumns={allColumns}
                  keyColumns={keyColumns}
                  keyOrderBy={keyOrderBy}
                  blindMode={blindMode}
                  newColumns={newColumns}
                  removedColumns={removedColumns}
                />
              </div>

              {/* Footer with row count */}
              <div className="px-4 py-2 border-t border-border/50 bg-card/30 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {totalDiffRows.toLocaleString()} differences
                  {summary.unchanged > 0 && ` (${summary.unchanged.toLocaleString()} unchanged rows hidden)`}
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
