import { useCallback, useEffect } from 'react'
import { X, ArrowLeft, Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { StandardizeConfigPanel } from './components/StandardizeConfigPanel'
import { ClusterList } from './components/ClusterList'
import { ClusterProgress } from './components/ClusterProgress'
import { useTableStore } from '@/stores/tableStore'
import { useStandardizerStore } from '@/stores/standardizerStore'
import { useAuditStore } from '@/stores/auditStore'
import { useStandardizer } from '@/hooks/useStandardizer'
import { toast } from 'sonner'
import { useState } from 'react'

interface StandardizeViewProps {
  open: boolean
  onClose: () => void
}

export function StandardizeView({ open, onClose }: StandardizeViewProps) {
  const tables = useTableStore((s) => s.tables)
  const addTransformationEntry = useAuditStore((s) => s.addTransformationEntry)

  const {
    tableId,
    tableName,
    columnName,
    algorithm,
    clusters,
    filter,
    searchQuery,
    expandedId,
    isAnalyzing,
    progress,
    progressPhase,
    currentChunk,
    totalChunks,
    validationError,
    uniqueValueCount,
    stats,
    setTable,
    setColumn,
    setAlgorithm,
    setFilter,
    setSearchQuery,
    setExpandedId,
    toggleValueSelection,
    selectAllInCluster,
    deselectAllInCluster,
    setMasterValue,
    getSelectedMappings,
    clearClusters,
    reset,
  } = useStandardizerStore()

  const { startClustering, cancelClustering, applyChanges } = useStandardizer()

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  const hasResults = clusters.length > 0
  const hasSelectedChanges = stats.selectedValues > 0

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }

      // Keyboard shortcuts for filtering
      if (clusters.length > 0 && !e.ctrlKey && !e.metaKey) {
        switch (e.key) {
          case '1':
            setFilter('all')
            break
          case '2':
            setFilter('actionable')
            break
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, clusters.length, setFilter])

  const handleNewAnalysis = () => {
    if (hasSelectedChanges) {
      setShowDiscardConfirm(true)
    } else {
      clearClusters()
    }
  }

  const handleConfirmDiscard = () => {
    clearClusters()
    setShowDiscardConfirm(false)
  }

  const handleApply = useCallback(async () => {
    const mappings = getSelectedMappings()
    if (mappings.length === 0) {
      toast.info('No Changes Selected', {
        description: 'Select values to standardize before applying.',
      })
      return
    }

    try {
      const result = await applyChanges()

      if (result.success) {
        // Add audit entry
        if (tableId && tableName) {
          addTransformationEntry({
            tableId,
            tableName,
            action: 'Standardize Values',
            details: `Standardized ${mappings.length} value${mappings.length !== 1 ? 's' : ''} in '${columnName}' column using ${algorithm} algorithm`,
            rowsAffected: result.rowsAffected,
            hasRowDetails: result.hasRowDetails,
            auditEntryId: result.auditEntryId || undefined,
          })
        }

        toast.success('Values Standardized', {
          description: `Updated ${result.rowsAffected.toLocaleString()} rows.`,
        })

        reset()
        onClose()
      } else {
        toast.error('Standardization Failed', {
          description: result.error || 'An error occurred',
        })
      }
    } catch (error) {
      console.error('Apply failed:', error)
      toast.error('Apply Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    }
  }, [
    getSelectedMappings,
    applyChanges,
    tableId,
    tableName,
    columnName,
    algorithm,
    addTransformationEntry,
    reset,
    onClose,
  ])

  const handleClose = () => {
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm animate-in fade-in-0 duration-200"
      data-testid="standardize-view"
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
            VALUE STANDARDIZER
          </h1>

          {hasResults && (
            <>
              <div className="h-6 w-px bg-border" />
              <span className="text-sm text-muted-foreground">
                {tableName} - {columnName}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Progress */}
          {isAnalyzing && (
            <>
              <ClusterProgress
                phase={progressPhase}
                progress={progress}
                currentChunk={currentChunk}
                totalChunks={totalChunks}
              />

              <Button
                variant="outline"
                size="sm"
                onClick={cancelClustering}
                className="gap-2"
              >
                Cancel
              </Button>

              <div className="h-6 w-px bg-border" />
            </>
          )}

          {hasResults && !isAnalyzing && (
            <>
              {/* Stats */}
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{stats.totalClusters} clusters</span>
                <span>{stats.actionableClusters} actionable</span>
                {stats.selectedValues > 0 && (
                  <span className="text-primary">{stats.selectedValues} selected</span>
                )}
              </div>

              <div className="h-6 w-px bg-border" />

              {/* New Analysis Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewAnalysis}
                className="gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                New Analysis
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
            <StandardizeConfigPanel
              tables={tables}
              tableId={tableId}
              columnName={columnName}
              algorithm={algorithm}
              isAnalyzing={isAnalyzing}
              hasClusters={hasResults}
              validationError={validationError}
              uniqueValueCount={uniqueValueCount}
              onTableChange={setTable}
              onColumnChange={setColumn}
              onAlgorithmChange={setAlgorithm}
              onAnalyze={startClustering}
            />
          </ScrollArea>
        </div>

        {/* Results Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {hasResults ? (
            <>
              {/* Cluster List */}
              <div className="flex-1 min-h-0">
                <ClusterList
                  clusters={clusters}
                  filter={filter}
                  searchQuery={searchQuery}
                  expandedId={expandedId}
                  onFilterChange={setFilter}
                  onSearchChange={setSearchQuery}
                  onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
                  onToggleValue={toggleValueSelection}
                  onSetMaster={setMasterValue}
                  onSelectAll={selectAllInCluster}
                  onDeselectAll={deselectAllInCluster}
                />
              </div>

              {/* Apply Bar */}
              {hasSelectedChanges && (
                <>
                  <Separator />
                  <div className="p-4 flex items-center gap-3 bg-primary/5">
                    <span className="text-sm">
                      Ready to standardize {stats.selectedValues} value{stats.selectedValues !== 1 ? 's' : ''}
                    </span>
                    <div className="flex-1" />
                    <Button onClick={handleApply} className="gap-2">
                      <Check className="w-4 h-4" />
                      Apply Standardization
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
                  <span className="text-4xl">🔗</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground mb-2">
                  Standardize Values
                </h2>
                <p className="text-sm">
                  Cluster similar values in a column and standardize them to a single master value.
                  Great for cleaning up inconsistent data entry.
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
            <AlertDialogTitle>Discard selected changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have {stats.selectedValues} selected values.
              Starting a new analysis will discard these selections.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDiscard}>
              Discard & Analyze
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
