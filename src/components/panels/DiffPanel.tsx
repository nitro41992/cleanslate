import { GitCompare, Play, Loader2, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DiffSummary } from '@/features/diff/components/DiffSummary'
import { useTableStore } from '@/stores/tableStore'
import { useDiffStore } from '@/stores/diffStore'
import { runDiff } from '@/lib/diff-engine'
import { toast } from 'sonner'

export function DiffPanel() {
  const tables = useTableStore((s) => s.tables)

  const {
    tableA,
    tableB,
    keyColumns,
    results,
    summary,
    isComparing,
    blindMode,
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

  const commonColumns =
    tableAInfo && tableBInfo
      ? tableAInfo.columns
          .map((c) => c.name)
          .filter((c) => tableBInfo.columns.some((bc) => bc.name === c))
      : []

  const handleToggleKeyColumn = (column: string) => {
    if (keyColumns.includes(column)) {
      setKeyColumns(keyColumns.filter((c) => c !== column))
    } else {
      setKeyColumns([...keyColumns, column])
    }
  }

  const handleRunDiff = async () => {
    if (!tableAInfo || !tableBInfo || keyColumns.length === 0) return

    setIsComparing(true)
    try {
      const { results, summary } = await runDiff(
        tableAInfo.name,
        tableBInfo.name,
        keyColumns
      )
      setResults(results)
      setSummary(summary)

      toast.success('Diff Complete', {
        description: `Found ${summary.added} added, ${summary.removed} removed, ${summary.modified} modified rows`,
      })
    } catch (error) {
      console.error('Diff failed:', error)
      toast.error('Diff Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsComparing(false)
    }
  }

  const handleReset = () => {
    reset()
  }

  if (tables.length < 2) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <GitCompare className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="font-medium">Load at least 2 tables</p>
          <p className="text-sm mt-1">Import tables first to compare them</p>
        </div>
      </div>
    )
  }

  // If results exist, show them
  if (results.length > 0 && summary) {
    return (
      <div className="flex flex-col h-full">
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {/* Summary */}
            <DiffSummary summary={summary} />

            {/* Legend */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="success" className="rounded">Added</Badge>
              <Badge variant="destructive" className="rounded">Removed</Badge>
              <Badge variant="warning" className="rounded">Modified</Badge>
            </div>

            {/* Blind Mode Toggle */}
            <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
              <div className="flex items-center gap-2">
                <EyeOff className="w-4 h-4 text-muted-foreground" />
                <Label htmlFor="blind-mode" className="cursor-pointer">
                  Blind Mode
                </Label>
              </div>
              <Switch
                id="blind-mode"
                checked={blindMode}
                onCheckedChange={setBlindMode}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Hide row status for unbiased review. View results in the main grid.
            </p>

            {/* Results info */}
            <div className="text-sm text-muted-foreground">
              <p>Showing {results.length} differences in the main preview grid.</p>
              <p className="text-xs mt-1">
                Tables compared: {tableAInfo?.name} vs {tableBInfo?.name}
              </p>
            </div>
          </div>
        </ScrollArea>

        <Separator />

        <div className="p-4">
          <Button variant="outline" className="w-full" onClick={handleReset}>
            New Comparison
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Compare two tables to find added, removed, and modified rows.
          </p>

          {/* Table A */}
          <div className="space-y-2">
            <Label>Table A (Original)</Label>
            <Select value={tableA || ''} onValueChange={setTableA}>
              <SelectTrigger>
                <SelectValue placeholder="Select table" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.rowCount} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Table B */}
          <div className="space-y-2">
            <Label>Table B (New)</Label>
            <Select value={tableB || ''} onValueChange={setTableB}>
              <SelectTrigger>
                <SelectValue placeholder="Select table" />
              </SelectTrigger>
              <SelectContent>
                {tables
                  .filter((t) => t.id !== tableA)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.rowCount} rows)
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* Key Columns */}
          {commonColumns.length > 0 && (
            <div className="space-y-2">
              <Label>Key Columns (for matching rows)</Label>
              <div className="border rounded-lg p-3 max-h-40 overflow-auto">
                <div className="space-y-2">
                  {commonColumns.map((col) => (
                    <div key={col} className="flex items-center space-x-2">
                      <Checkbox
                        id={col}
                        checked={keyColumns.includes(col)}
                        onCheckedChange={() => handleToggleKeyColumn(col)}
                      />
                      <label htmlFor={col} className="text-sm cursor-pointer">
                        {col}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tableA && tableB && commonColumns.length === 0 && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              No common columns found between the selected tables.
            </div>
          )}
        </div>
      </ScrollArea>

      <Separator />

      <div className="p-4">
        <Button
          className="w-full"
          onClick={handleRunDiff}
          disabled={!tableA || !tableB || keyColumns.length === 0 || isComparing}
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
