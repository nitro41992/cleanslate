import { useEffect, useCallback } from 'react'
import { Users, Play, Loader2, Check, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { CardStack } from './components/CardStack'
import { MatchStats } from './components/MatchStats'
import { useTableStore } from '@/stores/tableStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { findDuplicates, mergeDuplicates } from '@/lib/fuzzy-matcher'
import { toast } from '@/hooks/use-toast'

export function MatcherPage() {
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)

  const {
    tableId,
    tableName,
    matchColumn,
    blockingStrategy,
    threshold,
    pairs,
    currentPairIndex,
    isMatching,
    stats,
    setTable,
    setMatchColumn,
    setBlockingStrategy,
    setThreshold,
    setPairs,
    setIsMatching,
    markPairAsMerged,
    markPairAsKeptSeparate,
    nextPair,
    reset,
  } = useMatcherStore()

  const selectedTable = tables.find((t) => t.id === tableId)
  const currentPair = pairs[currentPairIndex]
  const hasReviewed = stats.merged + stats.keptSeparate > 0

  const handleTableSelect = (id: string) => {
    const table = tables.find((t) => t.id === id)
    setTable(id, table?.name || null)
    setMatchColumn(null)
    setPairs([])
  }

  const handleFindMatches = async () => {
    if (!tableName || !matchColumn) return

    setIsMatching(true)
    try {
      const matches = await findDuplicates(
        tableName,
        matchColumn,
        blockingStrategy,
        threshold
      )

      setPairs(matches)

      if (matches.length === 0) {
        toast({
          title: 'No Duplicates Found',
          description: 'No potential duplicates were found with the current settings.',
        })
      } else {
        toast({
          title: 'Duplicates Found',
          description: `Found ${matches.length} potential duplicate pairs to review.`,
        })
      }
    } catch (error) {
      console.error('Matching failed:', error)
      toast({
        title: 'Matching Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsMatching(false)
    }
  }

  const handleMerge = useCallback(() => {
    if (currentPair) {
      markPairAsMerged(currentPair.id)
      nextPair()
    }
  }, [currentPair, markPairAsMerged, nextPair])

  const handleKeepSeparate = useCallback(() => {
    if (currentPair) {
      markPairAsKeptSeparate(currentPair.id)
      nextPair()
    }
  }, [currentPair, markPairAsKeptSeparate, nextPair])

  const handleApplyMerges = async () => {
    if (!tableName || !matchColumn) return

    try {
      const deletedCount = await mergeDuplicates(tableName, pairs, matchColumn)

      if (deletedCount > 0 && tableId) {
        // Update table row count
        const newRowCount = (selectedTable?.rowCount || 0) - deletedCount
        updateTable(tableId, { rowCount: newRowCount })
      }

      toast({
        title: 'Merges Applied',
        description: `Removed ${deletedCount} duplicate rows.`,
      })

      reset()
    } catch (error) {
      console.error('Apply merges failed:', error)
      toast({
        title: 'Apply Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pairs.length === 0 || !currentPair || currentPair.status !== 'pending') return

      if (e.key === 'ArrowRight' || e.key === 'm') {
        handleMerge()
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        handleKeepSeparate()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pairs, currentPair, handleMerge, handleKeepSeparate])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-6 border-b border-border/50 bg-card/30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-semibold">Fuzzy Matcher</h1>
            <p className="text-xs text-muted-foreground">
              Find and merge duplicate records
            </p>
          </div>
        </div>

        {hasReviewed && (
          <Button onClick={handleApplyMerges}>
            <Check className="w-4 h-4 mr-2" />
            Apply Merges ({stats.merged})
          </Button>
        )}
      </header>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 p-4 gap-4">
        {/* Configuration Panel */}
        <Card className="w-80 flex flex-col">
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col space-y-4">
            {tables.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
                <p className="text-sm">
                  Load a table in the Laundromat to find duplicates
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>Table</Label>
                  <Select value={tableId || ''} onValueChange={handleTableSelect}>
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

                {selectedTable && (
                  <>
                    <div className="space-y-2">
                      <Label>Match Column</Label>
                      <Select
                        value={matchColumn || ''}
                        onValueChange={setMatchColumn}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select column" />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedTable.columns.map((col) => (
                            <SelectItem key={col.name} value={col.name}>
                              {col.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Blocking Strategy</Label>
                      <Select
                        value={blockingStrategy}
                        onValueChange={(v) =>
                          setBlockingStrategy(v as typeof blockingStrategy)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="first_letter">
                            First Letter
                          </SelectItem>
                          <SelectItem value="soundex">
                            Phonetic (Soundex-like)
                          </SelectItem>
                          <SelectItem value="exact">
                            No Blocking (Slow)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Blocking prevents O(n²) comparisons
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>
                        Similarity Threshold: {threshold} (lower = stricter)
                      </Label>
                      <Slider
                        value={[threshold]}
                        onValueChange={([v]) => setThreshold(v)}
                        min={1}
                        max={10}
                        step={1}
                      />
                    </div>
                  </>
                )}

                <div className="pt-4 mt-auto">
                  <Button
                    className="w-full"
                    onClick={handleFindMatches}
                    disabled={!tableId || !matchColumn || isMatching}
                  >
                    {isMatching ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Finding Matches...
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 mr-2" />
                        Find Duplicates
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Review Area */}
        <div className="flex-1 flex flex-col min-w-0 gap-4">
          {pairs.length > 0 && <MatchStats stats={stats} />}

          <div className="flex-1 flex items-center justify-center">
            {pairs.length === 0 ? (
              <div className="text-center text-muted-foreground">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Configure settings and click "Find Duplicates"</p>
                <p className="text-xs mt-2">
                  Results will appear here for review
                </p>
              </div>
            ) : stats.pending === 0 ? (
              <div className="text-center">
                <Check className="w-12 h-12 mx-auto mb-4 text-green-500" />
                <p className="font-semibold">All pairs reviewed!</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Click "Apply Merges" to remove duplicates
                </p>
              </div>
            ) : currentPair ? (
              <CardStack
                pair={currentPair}
                onMerge={handleMerge}
                onKeepSeparate={handleKeepSeparate}
                matchColumn={matchColumn || ''}
              />
            ) : null}
          </div>

          {pairs.length > 0 && stats.pending > 0 && (
            <div className="flex items-center justify-center gap-4 pb-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <X className="w-4 h-4" />
                <span>← Keep Separate (K)</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Merge (M) →</span>
                <Check className="w-4 h-4" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
