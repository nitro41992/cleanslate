import { useState, useCallback, useMemo } from 'react'
import { ChevronRight, History, FileText, Eye, Download, X, Crosshair, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { useTableStore } from '@/stores/tableStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { useRecipeStore } from '@/stores/recipeStore'
import { getAuditEntriesForTable, getAllAuditEntries } from '@/lib/audit-from-timeline'
import { AuditDetailModal } from '@/components/common/AuditDetailModal'
import { extractRecipeSteps, extractRequiredColumns, isRecipeCompatibleCommand } from '@/lib/recipe/recipe-exporter'
import { toast } from 'sonner'
import type { AuditLogEntry } from '@/types'
import { cn } from '@/lib/utils'

export function AuditSidebar() {
  const auditSidebarOpen = usePreviewStore((s) => s.auditSidebarOpen)
  const setAuditSidebarOpen = usePreviewStore((s) => s.setAuditSidebarOpen)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const exportLog = useAuditStore((s) => s.exportLog)

  // Subscribe to timeline changes for reactive updates
  const timelines = useTimelineStore((s) => s.timelines)

  // Derive audit entries from timeline (updates on undo/redo)
  const entries = useMemo(() => {
    if (activeTableId) {
      return getAuditEntriesForTable(activeTableId)
    }
    return getAllAuditEntries()
  }, [activeTableId, timelines])

  // Timeline integration for drill-down highlighting
  const getTimeline = useTimelineStore((s) => s.getTimeline)
  const setHighlightedCommand = useTimelineStore((s) => s.setHighlightedCommand)
  const highlightedCommandId = useTimelineStore((s) => s.highlight.commandId)
  const clearHighlight = useTimelineStore((s) => s.clearHighlight)

  // Timeline position for undo/redo visual feedback
  const timeline = activeTableId ? getTimeline(activeTableId) : null
  const currentPosition = timeline?.currentPosition ?? -1
  const commandCount = timeline?.commands.length ?? 0

  // Create lookup: auditEntryId -> command index
  const auditEntryToCommandIndex = useMemo(() => {
    const map = new Map<string, number>()
    timeline?.commands.forEach((cmd, idx) => {
      if (cmd.auditEntryId) map.set(cmd.auditEntryId, idx)
    })
    return map
  }, [timeline?.commands])

  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null)

  // Export as Recipe dialog state
  const [showRecipeDialog, setShowRecipeDialog] = useState(false)
  const [recipeName, setRecipeName] = useState('')
  const [recipeDescription, setRecipeDescription] = useState('')
  const addRecipe = useRecipeStore((s) => s.addRecipe)
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)

  // Find timeline command linked to an audit entry
  const findTimelineCommand = useCallback(
    (auditEntryId: string | undefined) => {
      if (!auditEntryId || !activeTableId) return null
      const timeline = getTimeline(activeTableId)
      if (!timeline) return null
      return timeline.commands.find((cmd) => cmd.auditEntryId === auditEntryId) ?? null
    },
    [activeTableId, getTimeline]
  )

  // Toggle highlight for an entry
  const toggleHighlight = useCallback(
    (entry: AuditLogEntry, e: React.MouseEvent) => {
      e.stopPropagation() // Don't open modal when clicking highlight button
      const command = findTimelineCommand(entry.auditEntryId)
      if (command) {
        if (highlightedCommandId === command.id) {
          clearHighlight()
        } else {
          setHighlightedCommand(command.id)
        }
      }
    },
    [findTimelineCommand, highlightedCommandId, clearHighlight, setHighlightedCommand]
  )

  // Check if highlight button should be shown for an entry
  // Hide for full-table operations (stack, join, row deletions, metadata-only changes)
  const shouldShowHighlight = useCallback(
    (entry: AuditLogEntry): boolean => {
      const cmd = findTimelineCommand(entry.auditEntryId)
      if (!cmd) return false

      // Extract transform type from command params
      const params = cmd.params as unknown as Record<string, unknown> | undefined
      const cmdType = (params?.transformationType as string) || (params?.type as string) || ''

      // Skip full-table operations that don't have meaningful cell-level highlighting
      const skipTypes = new Set([
        'stack',           // Creates new table from stacking
        'join',            // Creates new table from join
        'remove_duplicates', // Deletes rows (nothing to highlight after)
        'filter_empty',    // Deletes rows
        'rename_column',   // Metadata-only change
      ])

      return !skipTypes.has(cmdType)
    },
    [findTimelineCommand]
  )

  // Filter entries for active table
  const tableEntries = entries.filter((e) => e.tableId === activeTableId)

  // Find the first untracked entry index (for determining "current" at position -1)
  const firstUntrackedEntryIndex = useMemo(() => {
    for (let i = 0; i < tableEntries.length; i++) {
      const entry = tableEntries[i]
      const cmdIndex = auditEntryToCommandIndex.get(entry.auditEntryId ?? '')
      if (cmdIndex === undefined) {
        return i
      }
    }
    return -1
  }, [tableEntries, auditEntryToCommandIndex])

  // Helper to determine entry state relative to timeline position
  type EntryState = 'past' | 'current' | 'future'
  const getEntryState = useCallback(
    (entry: AuditLogEntry, entryIndex: number): EntryState => {
      const cmdIndex = auditEntryToCommandIndex.get(entry.auditEntryId ?? '')

      // Entry is linked to a timeline command
      if (cmdIndex !== undefined) {
        if (cmdIndex === currentPosition) return 'current'
        if (cmdIndex < currentPosition) return 'past'
        return 'future'
      }

      // Entry is NOT linked to timeline (e.g., "File loaded")
      // These are actions that can't be undone, so treat as follows:
      // - If at position -1 (original state/all undone) and this is the first untracked entry,
      //   it represents the current state we've returned to
      // - Otherwise, it's "past" (already happened, can't be undone)
      if (currentPosition === -1 && entryIndex === firstUntrackedEntryIndex) {
        return 'current'
      }
      return 'past'
    },
    [auditEntryToCommandIndex, currentPosition, firstUntrackedEntryIndex]
  )

  const handleExportLog = async () => {
    const content = await exportLog()
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'audit_log.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Count recipe-compatible commands for the Export as Recipe button
  const recipeCompatibleCount = useMemo(() => {
    if (!timeline) return 0
    // Only count commands up to current position (not undone commands)
    const activeCommands = timeline.commands.slice(0, currentPosition + 1)
    return activeCommands.filter((cmd) => {
      const params = cmd.params as unknown as Record<string, unknown> | undefined
      // Reconstruct full command type from params (matches recipe-exporter.ts getCommandType)
      const cmdType =
        cmd.commandType === 'transform' && params?.transformationType
          ? `transform:${params.transformationType}`
          : cmd.commandType === 'scrub' && params?.method
            ? `scrub:${params.method}`
            : cmd.commandType === 'standardize'
              ? 'standardize:apply'
              : cmd.commandType
      return isRecipeCompatibleCommand(cmdType)
    }).length
  }, [timeline, currentPosition])

  // Handle Export as Recipe
  const handleExportAsRecipe = () => {
    if (!timeline || recipeCompatibleCount === 0) {
      toast.error('No recipe-compatible transforms to export')
      return
    }
    setRecipeName('')
    setRecipeDescription('')
    setShowRecipeDialog(true)
  }

  // Handle save recipe
  const handleSaveRecipe = () => {
    if (!recipeName.trim()) {
      toast.error('Please enter a recipe name')
      return
    }

    if (!timeline) return

    // Extract only commands up to current position (not undone)
    const activeCommands = timeline.commands.slice(0, currentPosition + 1)

    // Convert timeline commands to recipe steps
    const steps = extractRecipeSteps(activeCommands)

    if (steps.length === 0) {
      toast.error('No recipe-compatible transforms found')
      return
    }

    // Extract required columns
    const requiredColumns = extractRequiredColumns(steps)

    // Create the recipe
    addRecipe({
      name: recipeName.trim(),
      description: recipeDescription.trim(),
      version: '1.0',
      requiredColumns,
      steps,
    })

    setShowRecipeDialog(false)
    toast.success(`Recipe "${recipeName}" created with ${steps.length} steps`, {
      action: {
        label: 'View',
        onClick: () => setActivePanel('recipe'),
      },
    })
  }

  const formatTime = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return date.toLocaleDateString()
  }

  if (!auditSidebarOpen) {
    return null
  }

  return (
    <>
      <aside className="w-96 border-l border-border/50 bg-card/30 flex flex-col shrink-0" data-testid="audit-sidebar">
        {/* Header */}
        <div className="h-12 flex items-center justify-between px-3 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">Audit Log</span>
            {tableEntries.length > 0 && (
              <Badge variant="secondary" className="text-[10px] h-5">
                {tableEntries.length}
              </Badge>
            )}
            {/* Timeline position indicator */}
            {commandCount > 0 && (
              <Badge variant="outline" className="text-[10px] h-5 text-muted-foreground">
                {currentPosition + 1}/{commandCount}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {highlightedCommandId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-primary"
                    onClick={clearHighlight}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear highlights</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleExportAsRecipe}
                  disabled={recipeCompatibleCount === 0}
                  data-testid="export-as-recipe-btn"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Export as Recipe
                {recipeCompatibleCount > 0 && (
                  <span className="text-muted-foreground ml-1">
                    ({recipeCompatibleCount} transforms)
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleExportLog}
                  disabled={tableEntries.length === 0}
                  data-testid="audit-export-btn"
                >
                  <Download className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export audit log</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                clearHighlight() // Clear highlights when closing
                setAuditSidebarOpen(false)
              }}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Entries */}
        <ScrollArea className="flex-1">
          {tableEntries.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No changes yet.</p>
              <p className="text-xs mt-1">
                Apply transforms, matches, or other operations to see history here.
              </p>
            </div>
          ) : (
            <div className="p-2 px-3 space-y-1">
              {tableEntries.map((entry, index) => {
                const entryState = getEntryState(entry, index)
                const isFuture = entryState === 'future'
                const isCurrent = entryState === 'current'

                // Check if we need to show separator before this entry
                // Show separator before current entry if previous entry is future (undone)
                // This creates a visual divider between undone actions and current state
                const prevEntry = index > 0 ? tableEntries[index - 1] : null
                const prevState = prevEntry ? getEntryState(prevEntry, index - 1) : null
                const showSeparatorBefore = isCurrent && prevState === 'future'

                return (
                  <div key={entry.id}>
                    {/* Current State separator */}
                    {showSeparatorBefore && (
                      <div className="flex items-center gap-2 py-2 my-1">
                        <div className="flex-1 border-t border-primary/30" />
                        <span className="text-[10px] text-primary/70 font-medium px-1">
                          Current State
                        </span>
                        <div className="flex-1 border-t border-primary/30" />
                      </div>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'w-full text-left p-2 rounded-lg transition-colors group cursor-pointer',
                        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                        isFuture && 'opacity-40',
                        isCurrent && 'border-l-2 border-primary bg-primary/5',
                        !isFuture && 'hover:bg-muted/50'
                      )}
                      onClick={() => setSelectedEntry(entry)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedEntry(entry)
                        }
                      }}
                      data-testid={entry.hasRowDetails ? 'audit-entry-with-details' : undefined}
                    >
                      <div className="flex items-start justify-between gap-2 overflow-hidden">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{entry.action}</p>
                            {/* Undone badge for future entries */}
                            {isFuture && (
                              <Badge variant="outline" className="text-[10px] h-4 px-1 opacity-80 shrink-0">
                                Undone
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-3 break-all overflow-hidden">
                            {entry.details}
                          </p>
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge
                          variant={entry.entryType === 'A' ? 'default' : 'secondary'}
                          className="text-[10px] h-4 px-1.5"
                        >
                          {entry.entryType === 'A' ? 'Transform' : 'Edit'}
                        </Badge>
                        {entry.rowsAffected !== undefined && (
                          <span className="text-[10px] text-muted-foreground">
                            {entry.rowsAffected.toLocaleString()} rows
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {formatTime(entry.timestamp)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {entry.hasRowDetails && (
                          <div className="flex items-center gap-1 text-[10px] text-primary">
                            <Eye className="w-3 h-3" />
                            <span>View details</span>
                          </div>
                        )}
                        {/* Highlight in grid button - hidden for full-table operations */}
                        {shouldShowHighlight(entry) && (
                          <button
                            onClick={(e) => toggleHighlight(entry, e)}
                            className={cn(
                              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
                              highlightedCommandId === findTimelineCommand(entry.auditEntryId)?.id
                                ? 'bg-primary/20 text-primary'
                                : 'text-muted-foreground hover:text-primary hover:bg-primary/10'
                            )}
                            title="Highlight affected cells in grid"
                          >
                            <Crosshair className="w-3 h-3" />
                            <span>
                              {highlightedCommandId === findTimelineCommand(entry.auditEntryId)?.id
                                ? 'Clear'
                                : 'Highlight'}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </aside>

      {/* Detail Modal */}
      <AuditDetailModal
        entry={selectedEntry}
        open={selectedEntry !== null}
        onOpenChange={(open) => !open && setSelectedEntry(null)}
      />

      {/* Export as Recipe Dialog */}
      <Dialog open={showRecipeDialog} onOpenChange={setShowRecipeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export as Recipe</DialogTitle>
            <DialogDescription>
              Save {recipeCompatibleCount} transform{recipeCompatibleCount !== 1 ? 's' : ''} as a reusable recipe template.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="recipe-name">Recipe Name</Label>
              <Input
                id="recipe-name"
                value={recipeName}
                onChange={(e) => setRecipeName(e.target.value)}
                placeholder="e.g., Email Cleanup"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="recipe-desc">Description (optional)</Label>
              <Textarea
                id="recipe-desc"
                value={recipeDescription}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRecipeDescription(e.target.value)}
                placeholder="What does this recipe do?"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRecipeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveRecipe}>Create Recipe</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
