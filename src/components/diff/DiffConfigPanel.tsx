import { useState, useEffect } from 'react'
import { Play, Loader2, GitCompare, FileStack, Eye, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { hasOriginalSnapshot, tableExists } from '@/lib/duckdb'
import { useTimelineStore } from '@/stores/timelineStore'
import type { TableInfo } from '@/types'
import type { DiffMode } from '@/stores/diffStore'

interface DiffConfigPanelProps {
  tables: TableInfo[]
  // Mode
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  // Compare Tables mode
  tableA: string | null
  tableB: string | null
  onTableAChange: (tableId: string | null) => void
  onTableBChange: (tableId: string | null) => void
  // Compare Preview mode
  activeTableId: string | null
  activeTableName: string | null
  // Shared
  keyColumns: string[]
  isComparing: boolean
  onKeyColumnsChange: (columns: string[]) => void
  onRunDiff: () => void
}

export function DiffConfigPanel({
  tables,
  mode,
  onModeChange,
  tableA,
  tableB,
  onTableAChange,
  onTableBChange,
  activeTableId,
  activeTableName,
  keyColumns,
  isComparing,
  onKeyColumnsChange,
  onRunDiff,
}: DiffConfigPanelProps) {
  const [hasSnapshot, setHasSnapshot] = useState(false)
  const [checkingSnapshot, setCheckingSnapshot] = useState(false)

  // Get timeline for active table (if exists)
  const getTimeline = useTimelineStore((s) => s.getTimeline)

  // Check if active table has an original snapshot (either old-style or timeline-based)
  useEffect(() => {
    if (mode === 'compare-preview' && activeTableId && activeTableName) {
      setCheckingSnapshot(true)

      const checkSnapshots = async () => {
        // First check old-style snapshot (_original_${tableName})
        const hasOldSnapshot = await hasOriginalSnapshot(activeTableName)
        if (hasOldSnapshot) {
          return true
        }

        // Then check timeline-based snapshot (handles both in-memory and Parquet)
        const timeline = getTimeline(activeTableId)
        if (timeline?.originalSnapshotName) {
          // Parquet snapshots are always valid (stored in OPFS)
          if (timeline.originalSnapshotName.startsWith('parquet:')) {
            return true
          }
          // In-memory snapshots need table existence check
          const timelineSnapshotExists = await tableExists(timeline.originalSnapshotName)
          if (timelineSnapshotExists) {
            return true
          }
        }

        return false
      }

      checkSnapshots()
        .then(setHasSnapshot)
        .finally(() => setCheckingSnapshot(false))
    }
  }, [mode, activeTableId, activeTableName, getTimeline])

  // Get table info for selected tables
  const tableAInfo = tables.find((t) => t.id === tableA)
  const tableBInfo = tables.find((t) => t.id === tableB)
  const activeTableInfo = tables.find((t) => t.id === activeTableId)

  // Get columns for the active comparison
  const getColumns = (): string[] => {
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

  const columns = getColumns()

  const handleToggleKeyColumn = (column: string) => {
    if (keyColumns.includes(column)) {
      onKeyColumnsChange(keyColumns.filter((c) => c !== column))
    } else {
      onKeyColumnsChange([...keyColumns, column])
    }
  }

  // Determine if we can run the diff
  const canRunDiff = (() => {
    if (isComparing) return false

    if (mode === 'compare-preview') {
      // Preview mode uses _cs_id internally, so key columns are optional
      return activeTableId !== null && hasSnapshot
    }
    if (mode === 'compare-tables') {
      // Two-tables mode requires key columns for matching
      return tableA !== null && tableB !== null && columns.length > 0 && keyColumns.length > 0
    }
    return false
  })()

  // Empty state when no tables loaded
  if (tables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
          <GitCompare className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-lg mb-2">No tables loaded</h3>
        <p className="text-sm text-muted-foreground">
          Import a table first to use the diff tool.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border/50">
        <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
          Configure
        </h3>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Mode Selector */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Comparison Mode
            </Label>
            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={() => {
                  onModeChange('compare-preview')
                  // Clear key columns when switching to preview (they're not used)
                  if (mode !== 'compare-preview') {
                    onKeyColumnsChange([])
                  }
                }}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border text-left transition-all',
                  mode === 'compare-preview'
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/50 bg-muted/20 text-muted-foreground hover:bg-muted/40'
                )}
              >
                <Eye className="w-5 h-5 shrink-0" />
                <div>
                  <p className="font-medium text-sm">Compare with Preview</p>
                  <p className="text-xs opacity-70">Original vs current transformations</p>
                </div>
              </button>
              <button
                onClick={() => onModeChange('compare-tables')}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border text-left transition-all',
                  mode === 'compare-tables'
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/50 bg-muted/20 text-muted-foreground hover:bg-muted/40'
                )}
              >
                <FileStack className="w-5 h-5 shrink-0" />
                <div>
                  <p className="font-medium text-sm">Compare Two Tables</p>
                  <p className="text-xs opacity-70">Select any two tables to compare</p>
                </div>
              </button>
            </div>
          </div>

          {/* Compare Preview Mode */}
          {mode === 'compare-preview' && (
            <>
              {activeTableId ? (
                <div className="space-y-3">
                  <div className="p-3 bg-muted/30 rounded-lg">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                      Active Table
                    </p>
                    <p className="font-medium">{activeTableName}</p>
                    <p className="text-xs text-muted-foreground">
                      {activeTableInfo?.rowCount.toLocaleString()} rows
                    </p>
                  </div>

                  {checkingSnapshot ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Checking for original data...
                    </div>
                  ) : hasSnapshot ? (
                    <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                      <p className="text-sm text-green-400 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-400" />
                        Original snapshot available
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Rows are automatically matched by internal ID. No key selection needed.
                      </p>
                    </div>
                  ) : (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                      <p className="text-sm text-amber-400 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        No transformations applied yet
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Apply a transformation first. The original data will be preserved automatically.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 bg-muted/30 rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">
                    Select a table to compare with its original state.
                  </p>
                </div>
              )}
            </>
          )}

          {/* Compare Tables Mode */}
          {mode === 'compare-tables' && (
            <>
              {tables.length < 2 ? (
                <div className="p-3 bg-muted/30 rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">
                    Load at least 2 tables to compare them.
                  </p>
                </div>
              ) : (
                <>
                  {/* Table A Selection */}
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Table A (Original)
                    </Label>
                    <Select
                      value={tableA || ''}
                      onValueChange={(v) => onTableAChange(v || null)}
                    >
                      <SelectTrigger data-testid="diff-table-a-select">
                        <SelectValue placeholder="Select table" />
                      </SelectTrigger>
                      <SelectContent>
                        {tables.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <span className="flex items-center gap-2">
                              {t.name}
                              <span className="text-muted-foreground text-xs">
                                ({t.rowCount.toLocaleString()} rows)
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Table B Selection */}
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Table B (New)
                    </Label>
                    <Select
                      value={tableB || ''}
                      onValueChange={(v) => onTableBChange(v || null)}
                    >
                      <SelectTrigger data-testid="diff-table-b-select">
                        <SelectValue placeholder="Select table" />
                      </SelectTrigger>
                      <SelectContent>
                        {tables
                          .filter((t) => t.id !== tableA)
                          .map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              <span className="flex items-center gap-2">
                                {t.name}
                                <span className="text-muted-foreground text-xs">
                                  ({t.rowCount.toLocaleString()} rows)
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Warning for no common columns */}
                  {tableA && tableB && columns.length === 0 && (
                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                      <p className="text-sm text-destructive">
                        No common columns found between the selected tables.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Key Columns - only shown for two-tables mode */}
          {mode === 'compare-tables' && columns.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Key Columns (for matching rows)
              </Label>
              <div className="border border-border/50 rounded-lg bg-muted/20 max-h-48 overflow-auto">
                <div className="p-2 space-y-1">
                  {columns.map((col) => (
                    <label
                      key={col}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 cursor-pointer transition-colors"
                    >
                      <Checkbox
                        id={`key-${col}`}
                        checked={keyColumns.includes(col)}
                        onCheckedChange={() => handleToggleKeyColumn(col)}
                      />
                      <span className="text-sm font-mono">{col}</span>
                    </label>
                  ))}
                </div>
              </div>
              {keyColumns.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {keyColumns.length} key column{keyColumns.length !== 1 ? 's' : ''} selected
                </p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Run Button */}
      <div className="p-4 border-t border-border/50">
        <Button
          className="w-full"
          onClick={onRunDiff}
          disabled={!canRunDiff}
          data-testid="diff-compare-btn"
        >
          {isComparing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Comparing...
            </>
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" />
              Run Comparison
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
