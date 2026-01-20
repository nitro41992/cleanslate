import { GitCompare, Play, Loader2, EyeOff } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DiffGrid } from './components/DiffGrid'
import { DiffSummary } from './components/DiffSummary'
import { useTableStore } from '@/stores/tableStore'
import { useDiffStore } from '@/stores/diffStore'
import { runDiff } from '@/lib/diff-engine'
import { toast } from '@/hooks/use-toast'

export function DiffPage() {
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

  // Get common columns
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

      toast({
        title: 'Diff Complete',
        description: `Found ${summary.added} added, ${summary.removed} removed, ${summary.modified} modified rows`,
      })
    } catch (error) {
      console.error('Diff failed:', error)
      toast({
        title: 'Diff Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsComparing(false)
    }
  }

  const handleReset = () => {
    reset()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-6 border-b border-border/50 bg-card/30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <GitCompare className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-semibold">Visual Diff</h1>
            <p className="text-xs text-muted-foreground">
              Compare two tables side by side
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {results.length > 0 && (
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
                      Blind Mode
                    </Label>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Hide row status for unbiased review</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {results.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleReset}>
              New Comparison
            </Button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 p-4 gap-4">
        {/* Configuration Panel */}
        {results.length === 0 && (
          <Card className="w-80 flex flex-col">
            <CardHeader>
              <CardTitle className="text-base">Configure Comparison</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col space-y-4">
              {tables.length < 2 ? (
                <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
                  <p className="text-sm">
                    Load at least 2 tables in the Laundromat to compare them
                  </p>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Table A (Original)</Label>
                    <Select value={tableA || ''} onValueChange={setTableA}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select table" />
                      </SelectTrigger>
                      <SelectContent>
                        {tables.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

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
                              {t.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {commonColumns.length > 0 && (
                    <div className="space-y-2">
                      <Label>Key Columns (for matching rows)</Label>
                      <ScrollArea className="h-40 border rounded-lg p-2">
                        <div className="space-y-2">
                          {commonColumns.map((col) => (
                            <div
                              key={col}
                              className="flex items-center space-x-2"
                            >
                              <Checkbox
                                id={col}
                                checked={keyColumns.includes(col)}
                                onCheckedChange={() =>
                                  handleToggleKeyColumn(col)
                                }
                              />
                              <label
                                htmlFor={col}
                                className="text-sm cursor-pointer"
                              >
                                {col}
                              </label>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}

                  <div className="pt-4 mt-auto">
                    <Button
                      className="w-full"
                      onClick={handleRunDiff}
                      disabled={
                        !tableA ||
                        !tableB ||
                        keyColumns.length === 0 ||
                        isComparing
                      }
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
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Results Area */}
        <div className="flex-1 flex flex-col min-w-0 gap-4">
          {summary && <DiffSummary summary={summary} />}

          {results.length > 0 && (
            <Card className="flex-1 flex flex-col min-h-0">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-4">
                  <span>Diff Results</span>
                  <div className="flex items-center gap-2 text-xs font-normal">
                    <Badge variant="success" className="rounded">
                      Added
                    </Badge>
                    <Badge variant="destructive" className="rounded">
                      Removed
                    </Badge>
                    <Badge variant="warning" className="rounded">
                      Modified
                    </Badge>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 p-0 min-h-0">
                <DiffGrid
                  results={results}
                  columns={commonColumns}
                  keyColumns={keyColumns}
                  blindMode={blindMode}
                />
              </CardContent>
            </Card>
          )}

          {results.length === 0 && !isComparing && tables.length >= 2 && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <GitCompare className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Configure your comparison on the left and click "Run Comparison"</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
