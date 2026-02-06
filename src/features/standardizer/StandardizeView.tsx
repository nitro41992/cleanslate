import { useCallback, useEffect } from 'react'
import { X, ArrowLeft, Check, RotateCcw, ChevronsLeft, ChevronsRight } from 'lucide-react'
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
import { RecordPreviewDrawer } from './components/RecordPreviewDrawer'
import { useTableStore } from '@/stores/tableStore'
import { useStandardizerStore } from '@/stores/standardizerStore'
import { useStandardizer } from '@/hooks/useStandardizer'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useState } from 'react'

interface StandardizeViewProps {
  open: boolean
  onClose: () => void
}

export function StandardizeView({ open, onClose }: StandardizeViewProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const updateTable = useTableStore((s) => s.updateTable)

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
    previewClusterId,
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
    selectAllClusters,
    deselectAllClusters,
    setCustomReplacement,
    setPreviewCluster,
    closePreview,
    getSelectedMappings,
    clearClusters,
    reset,
  } = useStandardizerStore()

  const { startClustering, cancelClustering } = useStandardizer()

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  // Sync panel table with activeTableId when view opens or active table changes
  useEffect(() => {
    if (open && activeTableId && tableId !== activeTableId) {
      const activeTable = tables.find((t) => t.id === activeTableId)
      if (activeTable) {
        setTable(activeTableId, activeTable.name)
      }
    }
  }, [open, activeTableId, tableId, tables, setTable])

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [configCollapsed, setConfigCollapsed] = useState(false)

  const hasResults = clusters.length > 0
  const hasSelectedChanges = stats.selectedValues > 0

  // Close preview drawer when switching tabs
  const handleFilterChange = useCallback((f: typeof filter) => {
    closePreview()
    setFilter(f)
  }, [closePreview, setFilter])

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }

      // Keyboard shortcuts for filtering (use letters to avoid conflict with global nav)
      // Skip shortcuts when user is typing in an input field
      const target = e.target as HTMLElement
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (clusters.length > 0 && !e.ctrlKey && !e.metaKey && !isTyping) {
        switch (e.key) {
          case 'a':
          case 'A':
            handleFilterChange('all')
            break
          case 't':
          case 'T':
            handleFilterChange('actionable')
            break
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, clusters.length, handleFilterChange])

  // Auto-collapse sidebar when clusters are found
  useEffect(() => {
    if (clusters.length > 0 && !isAnalyzing) {
      setConfigCollapsed(true)
    }
  }, [clusters.length, isAnalyzing])

  const handleNewAnalysis = () => {
    if (hasSelectedChanges) {
      setShowDiscardConfirm(true)
    } else {
      clearClusters()
      setConfigCollapsed(false)
    }
  }

  const handleConfirmDiscard = () => {
    clearClusters()
    setShowDiscardConfirm(false)
    setConfigCollapsed(false)
  }

  const handleApply = useCallback(async () => {
    const mappings = getSelectedMappings()
    if (mappings.length === 0) {
      toast.info('No Changes Selected', {
        description: 'Select values to replace before applying.',
      })
      return
    }

    if (!tableId || !tableName || !columnName) {
      toast.error('Invalid State', {
        description: 'No table or column selected.',
      })
      return
    }

    try {
      const executor = getCommandExecutor()

      // Partition mappings by type:
      // - Distinct (isUnique: true) → transform:replace (recipe-compatible)
      // - Clusters (isUnique: false) → standardize:apply (NOT recipe-compatible, uses fuzzy matching)
      const uniqueMappings = mappings.filter(m => m.isUnique)
      const actionableMappings = mappings.filter(m => !m.isUnique)

      let totalRowsAffected = 0
      let totalReplacements = 0
      let confirmedFirst = false

      // Execute unique mappings as transform:replace (recipe-compatible)
      for (let i = 0; i < uniqueMappings.length; i++) {
        const mapping = uniqueMappings[i]
        const command = createCommand('transform:replace', {
          tableId,
          column: columnName,
          find: mapping.fromValue,
          replace: mapping.toValue,
          caseSensitive: true,
          matchType: 'exact' as const,
        })

        // First command needs confirmation if discarding redo states
        if (!confirmedFirst) {
          const result = await executeWithConfirmation(command, tableId)
          if (!result) {
            return // User cancelled
          }
          if (!result.success) {
            toast.error('Smart Replace Failed', {
              description: result.error || 'An error occurred',
            })
            return
          }
          totalRowsAffected += result.executionResult?.affected || 0
          totalReplacements++
          confirmedFirst = true
        } else {
          const result = await executor.execute(command)
          if (result.success) {
            totalRowsAffected += result.executionResult?.affected || 0
            totalReplacements++
          } else {
            console.warn(`Find & Replace failed for "${mapping.fromValue}":`, result.error)
          }
        }
      }

      // Execute actionable mappings as standardize:apply (NOT recipe-compatible)
      // These use fuzzy matching logic and should not be part of recipes
      if (actionableMappings.length > 0) {
        const command = createCommand('standardize:apply', {
          tableId,
          column: columnName,
          algorithm,  // From standardizerStore - tracks which fuzzy algorithm was used
          mappings: actionableMappings.map(m => ({
            fromValue: m.fromValue,
            toValue: m.toValue,
            rowCount: m.rowCount,
          })),
        })

        // First command needs confirmation if discarding redo states
        if (!confirmedFirst) {
          const result = await executeWithConfirmation(command, tableId)
          if (!result) {
            return // User cancelled
          }
          if (!result.success) {
            toast.error('Smart Replace Failed', {
              description: result.error || 'An error occurred',
            })
            return
          }
          totalRowsAffected += result.executionResult?.affected || 0
          totalReplacements += actionableMappings.length
        } else {
          const result = await executor.execute(command)
          if (result.success) {
            totalRowsAffected += result.executionResult?.affected || 0
            totalReplacements += actionableMappings.length
          } else {
            console.warn('Standardize apply failed:', result.error)
          }
        }
      }

      // Update tableStore to trigger grid refresh (dataVersion auto-increments)
      updateTable(tableId, {})

      toast.success('Smart Replace Complete', {
        description: `Applied ${totalReplacements} replacements, updated ${totalRowsAffected.toLocaleString()} rows.`,
      })

      reset()
      onClose()
    } catch (error) {
      console.error('Apply failed:', error)
      toast.error('Apply Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    }
  }, [
    getSelectedMappings,
    tableId,
    tableName,
    columnName,
    algorithm,  // Added dependency - needed for standardize:apply command
    executeWithConfirmation,
    updateTable,
    reset,
    onClose,
  ])

  const handleClose = () => {
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-background animate-in fade-in-0 duration-200"
      data-testid="standardize-view"
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
            Smart Replace
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
        {/* Left Config Panel (collapsible) */}
        <div className={cn(
          'border-r border-border bg-card shrink-0 transition-all duration-200',
          configCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-80'
        )}>
          {!configCollapsed && (
            <ScrollArea className="h-full">
              <StandardizeConfigPanel
                tables={tables}
                tableId={tableId}
                tableName={tableName}
                columnName={columnName}
                algorithm={algorithm}
                isAnalyzing={isAnalyzing}
                hasClusters={hasResults}
                validationError={validationError}
                uniqueValueCount={uniqueValueCount}
                onColumnChange={setColumn}
                onAlgorithmChange={setAlgorithm}
                onAnalyze={startClustering}
              />
            </ScrollArea>
          )}
        </div>

        {/* Sidebar toggle button */}
        <button
          className="z-10 self-center flex items-center justify-center shrink-0
            w-6 h-12 rounded-r-md border border-l-0 border-border bg-card
            hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={() => setConfigCollapsed(c => !c)}
          title={configCollapsed ? 'Show config panel' : 'Hide config panel'}
        >
          {configCollapsed ? <ChevronsRight className="w-3.5 h-3.5" /> : <ChevronsLeft className="w-3.5 h-3.5" />}
        </button>

        {/* Results Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {hasResults ? (
            <>
              {/* Cluster List */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <ClusterList
                  clusters={clusters}
                  filter={filter}
                  searchQuery={searchQuery}
                  expandedId={expandedId}
                  onFilterChange={handleFilterChange}
                  onSearchChange={setSearchQuery}
                  onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
                  onToggleValue={toggleValueSelection}
                  onSetMaster={setMasterValue}
                  onSelectAll={selectAllInCluster}
                  onDeselectAll={deselectAllInCluster}
                  onSelectAllClusters={selectAllClusters}
                  onDeselectAllClusters={deselectAllClusters}
                  onSetReplacement={setCustomReplacement}
                  onReviewClick={setPreviewCluster}
                />
              </div>

              {/* Record Preview Drawer */}
              <RecordPreviewDrawer
                open={!!previewClusterId}
                onClose={closePreview}
              />

              {/* Apply Bar */}
              {hasSelectedChanges && (
                <>
                  <Separator />
                  <div className="p-4 flex items-center gap-3 bg-accent">
                    <span className="text-sm">
                      Ready to replace {stats.selectedValues} value{stats.selectedValues !== 1 ? 's' : ''}
                    </span>
                    <div className="flex-1" />
                    <span className="text-xs text-muted-foreground mr-1">
                      Replacements will apply to all matching rows in the column
                    </span>
                    <Button onClick={handleApply} className="gap-2">
                      <Check className="w-4 h-4" />
                      Apply Replacements
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
                  <span className="text-4xl">🔗</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground mb-2">
                  Smart Replace
                </h2>
                <p className="text-sm">
                  Find similar values in a column and replace them with a single master value.
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

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />
    </div>
  )
}
