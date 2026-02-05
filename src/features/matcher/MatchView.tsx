import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { X, ArrowLeft, RotateCcw, Check, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MatchConfigPanel } from './components/MatchConfigPanel'
import { SimilaritySpectrum } from './components/SimilaritySpectrum'
import { CategoryFilter } from './components/CategoryFilter'
import { MatchRow } from './components/MatchRow'
import { useTableStore } from '@/stores/tableStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { useAuditStore } from '@/stores/auditStore'
import { useFuzzyMatcher } from '@/hooks/useFuzzyMatcher'
import { createCommand } from '@/lib/commands'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import { toast } from 'sonner'
import { stringifyJSON } from '@/lib/utils/json-serialization'

interface MatchViewProps {
  open: boolean
  onClose: () => void
}

export function MatchView({ open, onClose }: MatchViewProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
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
    progress,
    pairsFound,
    progressPhase,
    currentBlock,
    totalBlocks,
    currentBlockKey,
    oversizedBlocks,
    stats,
    selectedIds,
    expandedId,
    setTable,
    setMatchColumn,
    setBlockingStrategy,
    setThresholds,
    setPairs,
    setIsMatching,
    setDetailedProgress,
    resetProgress,
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
    clearPairs,
    reset,
  } = useMatcherStore()

  // Fuzzy matcher worker hook
  const { startMatching, cancelMatching } = useFuzzyMatcher()
  const cancelMatchingRef = useRef(cancelMatching)
  cancelMatchingRef.current = cancelMatching

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  // Confirmation dialog state
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  // Track if we've initialized to avoid re-setting on every render
  const hasInitialized = useRef(false)

  // Auto-initialize table from activeTableId when view opens
  useEffect(() => {
    if (open && !hasInitialized.current && activeTableId && !tableId) {
      const activeTable = tables.find((t) => t.id === activeTableId)
      if (activeTable) {
        setTable(activeTableId, activeTable.name)
        hasInitialized.current = true
      }
    }
    // Reset initialization flag when view closes
    if (!open) {
      hasInitialized.current = false
    }
  }, [open, activeTableId, tableId, tables, setTable])

  // Virtualizer scroll container ref
  const parentRef = useRef<HTMLDivElement>(null)

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

  // Virtualizer for efficient rendering of large lists
  const virtualizer = useVirtualizer({
    count: filteredPairs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80, // Estimated row height including gap
    paddingStart: 16,
    paddingEnd: 16,
    overscan: 5,
  })

  // Memoized callbacks for MatchRow to prevent unnecessary re-renders
  const handleToggleSelect = useCallback((pairId: string) => {
    toggleSelect(pairId)
  }, [toggleSelect])

  const handleToggleExpand = useCallback((pairId: string) => {
    setExpandedId(expandedId === pairId ? null : pairId)
  }, [setExpandedId, expandedId])

  const handleMerge = useCallback((pairId: string) => {
    markPairAsMerged(pairId)
  }, [markPairAsMerged])

  const handleKeepSeparate = useCallback((pairId: string) => {
    markPairAsKeptSeparate(pairId)
  }, [markPairAsKeptSeparate])

  const handleSwapKeepRow = useCallback((pairId: string) => {
    swapKeepRow(pairId)
  }, [swapKeepRow])

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }

      // Keyboard shortcuts for filtering (use letters to avoid conflict with global nav)
      if (pairs.length > 0 && !e.ctrlKey && !e.metaKey) {
        switch (e.key) {
          case 'a':
          case 'A':
            setFilter('all')
            break
          case 'd':
          case 'D':
            setFilter('definite')
            break
          case 'y':
          case 'Y':
            setFilter('maybe')
            break
          case 'n':
          case 'N':
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
    resetProgress()

    try {
      // Use chunked multi-pass processing for scalability
      // Processes data block-by-block with progress reporting
      const result = await startMatching(
        tableName,
        matchColumn,
        blockingStrategy,
        definiteThreshold,
        maybeThreshold,
        (progressInfo) => {
          setDetailedProgress(
            progressInfo.phase,
            progressInfo.currentBlock,
            progressInfo.totalBlocks,
            progressInfo.pairsFound,
            progressInfo.maybeCount,
            progressInfo.definiteCount,
            progressInfo.currentBlockKey ?? null,
            progressInfo.oversizedBlocks
          )
        }
      )
      const pairs = result.pairs
      const totalFound = result.totalFound

      setPairs(pairs)
      resetProgress()

      // Add audit entry with block processing details
      if (tableId) {
        const oversizedNote = result.oversizedBlocksCount > 0
          ? ` (${result.oversizedBlocksCount} large blocks sampled)`
          : ''
        addAuditEntry(
          tableId,
          tableName,
          'Smart Dedupe',
          `Found ${totalFound.toLocaleString()} potential duplicates in '${matchColumn}' column using ${blockingStrategy} grouping, processed ${result.blocksProcessed} blocks${oversizedNote}`,
          'A'
        )
      }

      if (pairs.length === 0) {
        toast.info('No Duplicates Found', {
          description: 'No potential duplicates were found with the current settings.',
        })
      } else {
        const oversizedNote = result.oversizedBlocksCount > 0
          ? ` (${result.oversizedBlocksCount} large blocks sampled)`
          : ''
        toast.success('Duplicates Found', {
          description: `Found ${pairs.length.toLocaleString()} potential duplicate pairs from ${result.blocksProcessed} blocks.${oversizedNote}`,
        })
      }
    } catch (error) {
      console.error('Matching failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'An error occurred'
      if (errorMessage !== 'Matching cancelled') {
        toast.error('Matching Failed', {
          description: errorMessage,
        })
      }
    } finally {
      setIsMatching(false)
      resetProgress()
    }
  }, [tableName, matchColumn, blockingStrategy, definiteThreshold, maybeThreshold, tableId, setIsMatching, setPairs, addAuditEntry, startMatching, setDetailedProgress, resetProgress])

  const handleCancelMatching = useCallback(() => {
    cancelMatchingRef.current()
    setIsMatching(false)
    resetProgress()
    toast.info('Matching Cancelled', {
      description: 'The duplicate search was cancelled.',
    })
  }, [setIsMatching, resetProgress])

  const handleApplyMerges = useCallback(async () => {
    if (!tableName || !matchColumn || !tableId) return

    try {
      // Create the merge command
      const command = createCommand('match:merge', {
        tableId,
        matchColumn,
        pairs,
      })

      // Execute via CommandExecutor with confirmation if discarding redo states
      // Executor handles: snapshot creation, execution, audit logging, timeline recording
      const result = await executeWithConfirmation(command, tableId)

      // User cancelled the confirmation dialog
      if (!result) {
        return
      }

      if (result.success) {
        const deletedCount = result.executionResult?.affected || 0

        if (deletedCount > 0) {
          const newRowCount = (selectedTable?.rowCount || 0) - deletedCount
          updateTable(tableId, { rowCount: newRowCount })

          // Add audit entry (executor creates audit info, but we still need to add to store)
          if (result.auditInfo) {
            addTransformationEntry({
              tableId,
              tableName,
              action: result.auditInfo.action,
              details: stringifyJSON(result.auditInfo.details), // Stringify with BigInt support
              rowsAffected: result.auditInfo.rowsAffected,
              hasRowDetails: result.auditInfo.hasRowDetails,
              auditEntryId: result.auditInfo.auditEntryId,
            })
          }
        }

        toast.success('Merges Applied', {
          description: `Removed ${deletedCount} duplicate rows.`,
        })

        reset()
        onClose()
      } else {
        toast.error('Apply Failed', {
          description: result.error || 'An error occurred',
        })
      }
    } catch (error) {
      console.error('Apply merges failed:', error)
      toast.error('Apply Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    }
  }, [tableName, matchColumn, pairs, tableId, selectedTable, updateTable, addTransformationEntry, reset, onClose])

  const handleNewSearch = () => {
    const hasDecisions = stats.merged > 0 || stats.keptSeparate > 0
    if (hasDecisions) {
      setShowDiscardConfirm(true)
    } else {
      clearPairs()
    }
  }

  const handleConfirmDiscard = () => {
    clearPairs()
    setShowDiscardConfirm(false)
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
      className="fixed inset-0 z-50 bg-background animate-in fade-in-0 duration-200"
      data-testid="match-view"
    >
      {/* Header */}
      <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4">
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
            Merge
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
          {/* Progress bar when matching */}
          {isMatching && (
            <>
              <div className="flex flex-col items-end gap-1 min-w-[280px]">
                <div className="flex items-center gap-3 w-full">
                  <div className="flex-1">
                    <Progress value={progress} className="h-2" />
                  </div>
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {progress}%
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {progressPhase === 'analyzing' && 'Analyzing data distribution...'}
                  {progressPhase === 'processing' && (
                    <>
                      Block {currentBlock}/{totalBlocks}
                      {currentBlockKey && ` ("${currentBlockKey}")`}
                      {pairsFound > 0 && ` • ${pairsFound.toLocaleString()} pairs`}
                    </>
                  )}
                  {oversizedBlocks > 0 && ` • ${oversizedBlocks} large blocks`}
                </span>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={handleCancelMatching}
                className="gap-2"
              >
                <Square className="w-3 h-3" />
                Cancel
              </Button>

              <div className="h-6 w-px bg-border" />
            </>
          )}

          {hasResults && !isMatching && (
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
        <div className="w-80 border-r border-border bg-card shrink-0">
          <ScrollArea className="h-full">
            <MatchConfigPanel
              tables={tables}
              tableId={tableId}
              tableName={tableName}
              matchColumn={matchColumn}
              blockingStrategy={blockingStrategy}
              isMatching={isMatching}
              hasPairs={hasResults}
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
              <div className="p-4 border-b border-border bg-card">
                <SimilaritySpectrum
                  pairs={pairs}
                  maybeThreshold={maybeThreshold}
                  definiteThreshold={definiteThreshold}
                  onThresholdsChange={handleThresholdsChange}
                  disabled={isMatching}
                />
              </div>

              {/* Category Filter */}
              <div className="px-4 py-3 border-b border-border">
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
                <div className="px-4 py-2 flex items-center gap-2 border-b border-border bg-muted">
                  <Checkbox
                    checked={selectedIds.size === filteredPairs.length && filteredPairs.length > 0}
                    onCheckedChange={toggleSelectAll}
                  />
                  <span className="text-sm text-muted-foreground">
                    Select all ({filteredPairs.length} pairs)
                  </span>
                  <span className="text-xs text-muted-foreground ml-2">
                    Keyboard: A=All, D=Definite, Y=Maybe, N=Not Match, M=Merge, K=Keep
                  </span>
                </div>
              )}

              {/* Pairs List - Virtualized */}
              <div
                ref={parentRef}
                className="flex-1 overflow-auto"
              >
                {filteredPairs.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    No pairs match the current filter
                  </div>
                ) : (
                  <div className="px-4">
                    <div
                      style={{
                        height: virtualizer.getTotalSize(),
                        width: '100%',
                        position: 'relative',
                      }}
                    >
                      {virtualizer.getVirtualItems().map((virtualRow) => {
                        const pair = filteredPairs[virtualRow.index]
                        return (
                          <div
                            key={pair.id}
                            data-index={virtualRow.index}
                            ref={virtualizer.measureElement}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              right: 0,
                              transform: `translateY(${virtualRow.start}px)`,
                              paddingBottom: 8,
                            }}
                          >
                          <MatchRow
                            pair={pair}
                            matchColumn={matchColumn || ''}
                            classification={classifyPair(pair.similarity)}
                            isSelected={selectedIds.has(pair.id)}
                            isExpanded={expandedId === pair.id}
                            onToggleSelect={() => handleToggleSelect(pair.id)}
                            onToggleExpand={() => handleToggleExpand(pair.id)}
                            onMerge={() => handleMerge(pair.id)}
                            onKeepSeparate={() => handleKeepSeparate(pair.id)}
                            onSwapKeepRow={() => handleSwapKeepRow(pair.id)}
                          />
                        </div>
                      )
                    })}
                    </div>
                  </div>
                )}
              </div>

              {/* Bulk Actions Bar */}
              {selectedIds.size > 0 && (
                <>
                  <Separator />
                  <div className="p-4 flex items-center gap-3 bg-muted">
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
                  <div className="p-4 flex items-center gap-3 bg-green-950/30">
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
                <div className="w-20 h-20 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-6">
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

      {/* Discard Confirmation Dialog */}
      <AlertDialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard merge decisions?</AlertDialogTitle>
            <AlertDialogDescription>
              You have {stats.merged + stats.keptSeparate} reviewed pairs.
              Starting a new search will discard these decisions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDiscard}>
              Discard & Search
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />
    </div>
  )
}
