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
import { DiffResultsGrid } from './DiffResultsGrid'
import { DiffSummaryPills } from './DiffSummaryPills'
import { DiffExportMenu } from './DiffExportMenu'
import { useTableStore } from '@/stores/tableStore'
import { useDiffStore } from '@/stores/diffStore'
import { runDiff } from '@/lib/diff-engine'
import { getOriginalSnapshotName } from '@/lib/duckdb'
import { toast } from 'sonner'

interface DiffViewProps {
  open: boolean
  onClose: () => void
}

export function DiffView({ open, onClose }: DiffViewProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)

  const {
    mode,
    tableA,
    tableB,
    keyColumns,
    results,
    summary,
    isComparing,
    blindMode,
    setMode,
    setTableA,
    setTableB,
    setKeyColumns,
    setResults,
    setSummary,
    setIsComparing,
    setBlindMode,
    reset,
  } = useDiffStore()

  const tableAInfo = tables.find((t) => t.id === tableA)
  const tableBInfo = tables.find((t) => t.id === tableB)
  const activeTableInfo = tables.find((t) => t.id === activeTableId)

  // Get columns for the current comparison context
  const getComparisonColumns = (): string[] => {
    if (mode === 'compare-preview' && activeTableInfo) {
      return activeTableInfo.columns.map((c) => c.name)
    }
    if (mode === 'compare-tables' && tableAInfo && tableBInfo) {
      return tableAInfo.columns
        .map((c) => c.name)
        .filter((c) => tableBInfo.columns.some((bc) => bc.name === c))
    }
    return []
  }

  const comparisonColumns = getComparisonColumns()

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

  const handleRunDiff = useCallback(async () => {
    if (keyColumns.length === 0) return

    setIsComparing(true)
    try {
      let sourceTableName: string
      let targetTableName: string

      if (mode === 'compare-preview') {
        // Compare original snapshot with current table
        if (!activeTableInfo) {
          throw new Error('No active table selected')
        }
        sourceTableName = getOriginalSnapshotName(activeTableInfo.name)
        targetTableName = activeTableInfo.name
      } else {
        // Compare two selected tables
        if (!tableAInfo || !tableBInfo) {
          throw new Error('Please select both tables')
        }
        sourceTableName = tableAInfo.name
        targetTableName = tableBInfo.name
      }

      const { results: diffResults, summary: diffSummary } = await runDiff(
        sourceTableName,
        targetTableName,
        keyColumns
      )
      setResults(diffResults)
      setSummary(diffSummary)

      toast.success('Comparison Complete', {
        description: `Found ${diffSummary.added} added, ${diffSummary.removed} removed, ${diffSummary.modified} modified rows`,
      })
    } catch (error) {
      console.error('Diff failed:', error)
      toast.error('Comparison Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsComparing(false)
    }
  }, [mode, activeTableInfo, tableAInfo, tableBInfo, keyColumns, setIsComparing, setResults, setSummary])

  const handleNewComparison = () => {
    reset()
  }

  const handleClose = () => {
    onClose()
  }

  if (!open) return null

  const hasResults = results.length > 0 && summary

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
                results={results}
                summary={summary}
                columns={comparisonColumns}
                keyColumns={keyColumns}
                tableAName={tableAInfo?.name || ''}
                tableBName={tableBInfo?.name || ''}
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

              {/* Results Grid */}
              <div className="flex-1 min-h-0">
                <DiffResultsGrid
                  results={results}
                  columns={comparisonColumns}
                  keyColumns={keyColumns}
                  blindMode={blindMode}
                />
              </div>

              {/* Warning Footer */}
              <div className="px-4 py-2 border-t border-border/50 bg-amber-500/5 flex items-center gap-2 text-amber-500">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span className="text-xs">
                  This is a comparison view. Results cannot be saved as a table.
                </span>
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
