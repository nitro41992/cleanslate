import { useCallback, useEffect, useMemo } from 'react'
import { X, ArrowLeft, RotateCcw, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { MatchConfigPanel } from './components/MatchConfigPanel'
import { SimilaritySpectrum } from './components/SimilaritySpectrum'
import { CategoryFilter } from './components/CategoryFilter'
import { MatchRow } from './components/MatchRow'
import { useTableStore } from '@/stores/tableStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { useAuditStore } from '@/stores/auditStore'
import { findDuplicates, mergeDuplicates } from '@/lib/fuzzy-matcher'
import { generateId } from '@/lib/utils'
import { toast } from 'sonner'

interface MatchViewProps {
  open: boolean
  onClose: () => void
}

export function MatchView({ open, onClose }: MatchViewProps) {
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)
  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const addTransformationEntry = useAuditStore((s) => s.addTransformationEntry)

  const {
    tableId,
    tableName,
    matchColumn,
    blockingStrategy,
    definiteThreshold,
    maybeThreshold,
    pairs,
    filter,
    isMatching,
    stats,
    selectedIds,
    expandedId,
    setTable,
    setMatchColumn,
    setBlockingStrategy,
    setThresholds,
    setPairs,
    setIsMatching,
    setFilter,
    toggleSelect,
    selectAll,
    clearSelection,
    setExpandedId,
    markPairAsMerged,
    markPairAsKeptSeparate,
    markSelectedAsMerged,
    markSelectedAsKeptSeparate,
    swapKeepRow,
    classifyPair,
    reset,
  } = useMatcherStore()

  const selectedTable = tables.find((t) => t.id === tableId)
  const hasResults = pairs.length > 0
  const hasReviewed = stats.merged + stats.keptSeparate > 0

  // Get filtered pairs - compute with proper dependencies
  const filteredPairs = useMemo(() => {
    return pairs.filter((pair) => {
      if (pair.status !== 'pending') return false
      if (filter === 'all') return true
      const classification = classifyPair(pair.similarity)
      return classification === filter
    })
  }, [pairs, filter, classifyPair])

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }

      // Keyboard shortcuts for filtering
      if (pairs.length > 0 && !e.ctrlKey && !e.metaKey) {
        switch (e.key) {
          case '1':
            setFilter('all')
            break
          case '2':
            setFilter('definite')
            break
          case '3':
            setFilter('maybe')
            break
          case '4':
            setFilter('not_match')
            break
        }

        // M/K for single selected pair
        if (selectedIds.size === 1) {
          const selectedId = Array.from(selectedIds)[0]
          const pair = pairs.find((p) => p.id === selectedId)
          if (pair && pair.status === 'pending') {
            if (e.key === 'm' || e.key === 'M') {
              markPairAsMerged(selectedId)
            } else if (e.key === 'k' || e.key === 'K') {
              markPairAsKeptSeparate(selectedId)
            }
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, pairs, selectedIds, setFilter, markPairAsMerged, markPairAsKeptSeparate])

  const handleFindDuplicates = useCallback(async () => {
    if (!tableName || !matchColumn) return

    setIsMatching(true)
    try {
      const matches = await findDuplicates(
        tableName,
        matchColumn,
        blockingStrategy,
        definiteThreshold,
        maybeThreshold
      )
      setPairs(matches)

      // Add audit entry
      if (tableId) {
        addAuditEntry(
          tableId,
          tableName,
          'Find Duplicates',
          `Found ${matches.length} potential duplicates in '${matchColumn}' column using ${blockingStrategy} grouping`,
          'A'
        )
      }

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
  }, [tableName, matchColumn, blockingStrategy, definiteThreshold, maybeThreshold, tableId, setIsMatching, setPairs, addAuditEntry])

  const handleApplyMerges = useCallback(async () => {
    if (!tableName || !matchColumn) return

    try {
      // Generate audit entry ID before merge to link details
      const auditEntryId = generateId()
      const deletedCount = await mergeDuplicates(tableName, pairs, matchColumn, auditEntryId)

      if (deletedCount > 0 && tableId) {
        const newRowCount = (selectedTable?.rowCount || 0) - deletedCount
        updateTable(tableId, { rowCount: newRowCount })

        // Add audit entry with row details flag
        addTransformationEntry({
          tableId,
          tableName,
          action: 'Apply Merges',
          details: `Removed ${deletedCount} duplicate rows from table`,
          rowsAffected: deletedCount,
          hasRowDetails: true,
          auditEntryId,
        })
      }

      toast.success('Merges Applied', {
        description: `Removed ${deletedCount} duplicate rows.`,
      })

      reset()
      onClose()
    } catch (error) {
      console.error('Apply merges failed:', error)
      toast.error('Apply Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    }
  }, [tableName, matchColumn, pairs, tableId, selectedTable, updateTable, addTransformationEntry, reset, onClose])

  const handleNewSearch = () => {
    reset()
  }

  const handleClose = () => {
    onClose()
  }

  const handleThresholdsChange = (maybe: number, definite: number) => {
    setThresholds(definite, maybe)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPairs.length && filteredPairs.length > 0) {
      clearSelection()
    } else {
      selectAll(filteredPairs.map((p) => p.id))
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm animate-in fade-in-0 duration-200"
      data-testid="match-view"
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
            DUPLICATE FINDER
          </h1>

          {hasResults && (
            <>
              <div className="h-6 w-px bg-border" />
              <span className="text-sm text-muted-foreground">
                {tableName} - {matchColumn}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {hasResults && (
            <>
              {/* Stats */}
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{stats.pending} pending</span>
                <span className="text-green-400">{stats.merged} merged</span>
                <span className="text-red-400">{stats.keptSeparate} kept</span>
              </div>

              <div className="h-6 w-px bg-border" />

              {/* New Search Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewSearch}
                className="gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                New Search
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
        {/* Left Config Panel */}
        <div className="w-80 border-r border-border/50 bg-card/30 shrink-0">
          <ScrollArea className="h-full">
            <MatchConfigPanel
              tables={tables}
              tableId={tableId}
              matchColumn={matchColumn}
              blockingStrategy={blockingStrategy}
              isMatching={isMatching}
              hasPairs={hasResults}
              onTableChange={setTable}
              onMatchColumnChange={setMatchColumn}
              onBlockingStrategyChange={setBlockingStrategy}
              onFindDuplicates={handleFindDuplicates}
            />
          </ScrollArea>
        </div>

        {/* Results Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {hasResults ? (
            <>
              {/* Similarity Spectrum */}
              <div className="p-4 border-b border-border/50 bg-card/30">
                <SimilaritySpectrum
                  pairs={pairs}
                  maybeThreshold={maybeThreshold}
                  definiteThreshold={definiteThreshold}
                  onThresholdsChange={handleThresholdsChange}
                  disabled={isMatching}
                />
              </div>

              {/* Category Filter */}
              <div className="px-4 py-3 border-b border-border/50">
                <CategoryFilter
                  currentFilter={filter}
                  onFilterChange={setFilter}
                  counts={{
                    all: stats.pending,
                    definite: stats.definiteCount,
                    maybe: stats.maybeCount,
                    notMatch: stats.notMatchCount,
                  }}
                />
              </div>

              {/* Select All */}
              {filteredPairs.length > 0 && (
                <div className="px-4 py-2 flex items-center gap-2 border-b border-border/50 bg-muted/30">
                  <Checkbox
                    checked={selectedIds.size === filteredPairs.length && filteredPairs.length > 0}
                    onCheckedChange={toggleSelectAll}
                  />
                  <span className="text-sm text-muted-foreground">
                    Select all ({filteredPairs.length} pairs)
                  </span>
                  <span className="text-xs text-muted-foreground ml-2">
                    Keyboard: 1=All, 2=Definite, 3=Maybe, 4=Not Match, M=Merge, K=Keep
                  </span>
                </div>
              )}

              {/* Pairs List */}
              <ScrollArea className="flex-1">
                <div className="p-4 space-y-2">
                  {filteredPairs.map((pair) => (
                    <MatchRow
                      key={pair.id}
                      pair={pair}
                      matchColumn={matchColumn || ''}
                      classification={classifyPair(pair.similarity)}
                      isSelected={selectedIds.has(pair.id)}
                      isExpanded={expandedId === pair.id}
                      onToggleSelect={() => toggleSelect(pair.id)}
                      onToggleExpand={() => setExpandedId(expandedId === pair.id ? null : pair.id)}
                      onMerge={() => markPairAsMerged(pair.id)}
                      onKeepSeparate={() => markPairAsKeptSeparate(pair.id)}
                      onSwapKeepRow={() => swapKeepRow(pair.id)}
                    />
                  ))}

                  {filteredPairs.length === 0 && (
                    <div className="text-center text-muted-foreground py-8">
                      No pairs match the current filter
                    </div>
                  )}
                </div>
              </ScrollArea>

              {/* Bulk Actions Bar */}
              {selectedIds.size > 0 && (
                <>
                  <Separator />
                  <div className="p-4 flex items-center gap-3 bg-muted/30">
                    <span className="text-sm font-medium">
                      {selectedIds.size} selected
                    </span>
                    <div className="flex-1" />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => markSelectedAsKeptSeparate()}
                      className="gap-2"
                    >
                      <X className="w-4 h-4 text-red-500" />
                      Keep Separate
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => markSelectedAsMerged()}
                      className="gap-2"
                    >
                      <Check className="w-4 h-4" />
                      Merge Selected
                    </Button>
                  </div>
                </>
              )}

              {/* Apply Merges Bar */}
              {hasReviewed && selectedIds.size === 0 && (
                <>
                  <Separator />
                  <div className="p-4 flex items-center gap-3 bg-green-500/5">
                    <span className="text-sm">
                      Ready to apply {stats.merged} merge{stats.merged !== 1 ? 's' : ''}
                    </span>
                    <div className="flex-1" />
                    <Button onClick={handleApplyMerges} className="gap-2">
                      <Check className="w-4 h-4" />
                      Apply Merges
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            /* Empty State */
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center max-w-md">
                <div className="w-20 h-20 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-6">
                  <span className="text-4xl">🔍</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground mb-2">
                  Find Duplicate Records
                </h2>
                <p className="text-sm">
                  Select a table and column to find similar records.
                  Configure the grouping strategy for best results with your data.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
