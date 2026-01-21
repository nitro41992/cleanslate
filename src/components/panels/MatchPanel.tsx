import { useEffect, useCallback, useState } from 'react'
import { Users, Play, Loader2, Check, X, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTableStore } from '@/stores/tableStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { usePreviewStore } from '@/stores/previewStore'
import { findDuplicates, mergeDuplicates } from '@/lib/fuzzy-matcher'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { MatchPair } from '@/types'

type MatchClassification = 'definite' | 'maybe' | 'not_match'

function classifyMatch(score: number, threshold: number): MatchClassification {
  if (score === 0) return 'definite'
  if (score <= threshold * 0.4) return 'definite'
  if (score <= threshold) return 'maybe'
  return 'not_match'
}

interface MatchRowProps {
  pair: MatchPair
  matchColumn: string
  classification: MatchClassification
  isSelected: boolean
  isExpanded: boolean
  onToggleSelect: () => void
  onToggleExpand: () => void
  onMerge: () => void
  onKeepSeparate: () => void
}

function MatchRow({
  pair,
  matchColumn,
  classification,
  isSelected,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
  onMerge,
  onKeepSeparate,
}: MatchRowProps) {
  const classColors = {
    definite: 'bg-green-500/10 border-green-500/20',
    maybe: 'bg-yellow-500/10 border-yellow-500/20',
    not_match: 'bg-red-500/10 border-red-500/20',
  }

  const classLabels = {
    definite: 'Definite',
    maybe: 'Maybe',
    not_match: 'Not Match',
  }

  return (
    <div className={cn('border rounded-lg', classColors[classification])}>
      {/* Summary Row */}
      <div className="flex items-center gap-2 p-2">
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} />
        <button
          className="flex-1 flex items-center gap-2 text-left"
          onClick={onToggleExpand}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                {String(pair.rowA[matchColumn])}
              </span>
              <span className="text-muted-foreground">vs</span>
              <span className="text-sm font-medium truncate">
                {String(pair.rowB[matchColumn])}
              </span>
            </div>
          </div>
          <Badge variant="outline" className="text-xs">
            Score: {pair.score}
          </Badge>
          <Badge
            variant={
              classification === 'definite'
                ? 'default'
                : classification === 'maybe'
                ? 'secondary'
                : 'outline'
            }
            className="text-xs"
          >
            {classLabels[classification]}
          </Badge>
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onMerge}
            title="Merge (M)"
          >
            <Check className="w-4 h-4 text-green-500" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onKeepSeparate}
            title="Keep Separate (K)"
          >
            <X className="w-4 h-4 text-red-500" />
          </Button>
        </div>
      </div>

      {/* Expanded Detail */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/50">
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="font-medium text-muted-foreground mb-1">Record A</p>
              <div className="space-y-1">
                {Object.entries(pair.rowA).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted-foreground">{key}:</span>
                    <span className="truncate ml-2">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="font-medium text-muted-foreground mb-1">Record B</p>
              <div className="space-y-1">
                {Object.entries(pair.rowB).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted-foreground">{key}:</span>
                    <span className="truncate ml-2">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function MatchPanel() {
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)
  const closePanel = usePreviewStore((s) => s.closePanel)

  const {
    tableId,
    tableName,
    matchColumn,
    blockingStrategy,
    threshold,
    pairs,
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
    reset,
  } = useMatcherStore()

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | MatchClassification>('all')

  const selectedTable = tables.find((t) => t.id === tableId)
  const hasReviewed = stats.merged + stats.keptSeparate > 0

  // Classify pairs
  const classifiedPairs = pairs.map((pair) => ({
    ...pair,
    classification: classifyMatch(pair.score, threshold),
  }))

  // Filter pairs
  const filteredPairs = classifiedPairs.filter((pair) => {
    if (pair.status !== 'pending') return false
    if (filter === 'all') return true
    return pair.classification === filter
  })

  // Summary counts
  const definiteCount = classifiedPairs.filter((p) => p.status === 'pending' && p.classification === 'definite').length
  const maybeCount = classifiedPairs.filter((p) => p.status === 'pending' && p.classification === 'maybe').length
  const notMatchCount = classifiedPairs.filter((p) => p.status === 'pending' && p.classification === 'not_match').length

  const handleTableSelect = (id: string) => {
    const table = tables.find((t) => t.id === id)
    setTable(id, table?.name || null)
    setMatchColumn(null)
    setPairs([])
    setSelectedIds(new Set())
  }

  const handleFindMatches = async () => {
    if (!tableName || !matchColumn) return

    setIsMatching(true)
    setSelectedIds(new Set())
    try {
      const matches = await findDuplicates(tableName, matchColumn, blockingStrategy, threshold)
      setPairs(matches)

      if (matches.length === 0) {
        toast.info('No Duplicates Found', {
          description: 'No potential duplicates were found with the current settings.',
        })
      } else {
        toast.success('Duplicates Found', {
          description: `Found ${matches.length} potential duplicate pairs to review.`,
        })
      }
    } catch (error) {
      console.error('Matching failed:', error)
      toast.error('Matching Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsMatching(false)
    }
  }

  const handleMerge = useCallback((pairId: string) => {
    markPairAsMerged(pairId)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(pairId)
      return next
    })
  }, [markPairAsMerged])

  const handleKeepSeparate = useCallback((pairId: string) => {
    markPairAsKeptSeparate(pairId)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(pairId)
      return next
    })
  }, [markPairAsKeptSeparate])

  const handleBulkMerge = () => {
    selectedIds.forEach((id) => markPairAsMerged(id))
    setSelectedIds(new Set())
  }

  const handleBulkKeepSeparate = () => {
    selectedIds.forEach((id) => markPairAsKeptSeparate(id))
    setSelectedIds(new Set())
  }

  const handleApplyMerges = async () => {
    if (!tableName || !matchColumn) return

    try {
      const deletedCount = await mergeDuplicates(tableName, pairs, matchColumn)

      if (deletedCount > 0 && tableId) {
        const newRowCount = (selectedTable?.rowCount || 0) - deletedCount
        updateTable(tableId, { rowCount: newRowCount })
      }

      toast.success('Merges Applied', {
        description: `Removed ${deletedCount} duplicate rows.`,
      })

      reset()
      closePanel()
    } catch (error) {
      console.error('Apply merges failed:', error)
      toast.error('Apply Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPairs.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredPairs.map((p) => p.id)))
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pairs.length === 0 || selectedIds.size !== 1) return
      const selectedId = Array.from(selectedIds)[0]
      const pair = pairs.find((p) => p.id === selectedId)
      if (!pair || pair.status !== 'pending') return

      if (e.key === 'm' || e.key === 'M') {
        handleMerge(selectedId)
      } else if (e.key === 'k' || e.key === 'K') {
        handleKeepSeparate(selectedId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pairs, selectedIds, handleMerge, handleKeepSeparate])

  if (tables.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="font-medium">No tables loaded</p>
          <p className="text-sm mt-1">Import a table first to find duplicates</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Configuration */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Table</Label>
              <Select value={tableId || ''} onValueChange={handleTableSelect}>
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

            {selectedTable && (
              <>
                <div className="space-y-2">
                  <Label>Match Column</Label>
                  <Select value={matchColumn || ''} onValueChange={setMatchColumn}>
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
                    onValueChange={(v) => setBlockingStrategy(v as typeof blockingStrategy)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="first_letter">First Letter</SelectItem>
                      <SelectItem value="soundex">Phonetic (Soundex-like)</SelectItem>
                      <SelectItem value="exact">No Blocking (Slow)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Threshold: {threshold} (lower = stricter)</Label>
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

            {pairs.length === 0 && (
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
            )}
          </div>

          {/* Results */}
          {pairs.length > 0 && (
            <>
              <Separator />

              {/* Summary */}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant={filter === 'all' ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => setFilter('all')}
                >
                  All ({stats.pending})
                </Badge>
                <Badge
                  variant={filter === 'definite' ? 'default' : 'outline'}
                  className="cursor-pointer bg-green-500/20"
                  onClick={() => setFilter('definite')}
                >
                  Definite ({definiteCount})
                </Badge>
                <Badge
                  variant={filter === 'maybe' ? 'default' : 'outline'}
                  className="cursor-pointer bg-yellow-500/20"
                  onClick={() => setFilter('maybe')}
                >
                  Maybe ({maybeCount})
                </Badge>
                <Badge
                  variant={filter === 'not_match' ? 'default' : 'outline'}
                  className="cursor-pointer bg-red-500/20"
                  onClick={() => setFilter('not_match')}
                >
                  Not Match ({notMatchCount})
                </Badge>
              </div>

              {/* Select All */}
              {filteredPairs.length > 0 && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={selectedIds.size === filteredPairs.length && filteredPairs.length > 0}
                    onCheckedChange={toggleSelectAll}
                  />
                  <span className="text-sm text-muted-foreground">
                    Select all ({filteredPairs.length} pairs)
                  </span>
                </div>
              )}

              {/* Pairs List */}
              <div className="space-y-2">
                {filteredPairs.map((pair) => (
                  <MatchRow
                    key={pair.id}
                    pair={pair}
                    matchColumn={matchColumn || ''}
                    classification={pair.classification}
                    isSelected={selectedIds.has(pair.id)}
                    isExpanded={expandedId === pair.id}
                    onToggleSelect={() => toggleSelect(pair.id)}
                    onToggleExpand={() => setExpandedId(expandedId === pair.id ? null : pair.id)}
                    onMerge={() => handleMerge(pair.id)}
                    onKeepSeparate={() => handleKeepSeparate(pair.id)}
                  />
                ))}
              </div>

              {filteredPairs.length === 0 && (
                <div className="text-center text-muted-foreground py-4">
                  No pairs match the current filter
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <>
          <Separator />
          <div className="p-4 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {selectedIds.size} selected
            </span>
            <div className="flex-1" />
            <Button variant="outline" size="sm" onClick={handleBulkKeepSeparate}>
              <X className="w-4 h-4 mr-1" />
              Keep Separate
            </Button>
            <Button size="sm" onClick={handleBulkMerge}>
              <Check className="w-4 h-4 mr-1" />
              Merge
            </Button>
          </div>
        </>
      )}

      {/* Apply Merges */}
      {hasReviewed && selectedIds.size === 0 && (
        <>
          <Separator />
          <div className="p-4">
            <Button className="w-full" onClick={handleApplyMerges}>
              <Check className="w-4 h-4 mr-2" />
              Apply Merges ({stats.merged})
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
