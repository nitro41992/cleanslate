import { useState, useCallback, useMemo } from 'react'
import { History, FileText, Eye, Download, X, Crosshair, BookOpen, Layers, PenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
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

/**
 * Feature flag: Audit entry highlight functionality
 *
 * Disabled because:
 * 1. The Diff feature provides similar functionality with more detail
 * 2. Reduces UI complexity in the audit sidebar
 *
 * To re-enable: Set to `true`
 */
const ENABLE_AUDIT_HIGHLIGHT = false

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

  // Check if an entry's command is recipe-compatible
  const isRecipeEligible = useCallback(
    (entry: AuditLogEntry): boolean => {
      const cmd = findTimelineCommand(entry.auditEntryId)
      if (!cmd) return false

      // Reconstruct full command type from params (matches recipe-exporter.ts getCommandType)
      const params = cmd.params as unknown as Record<string, unknown> | undefined
      const cmdType =
        cmd.commandType === 'transform' && params?.transformationType
          ? `transform:${params.transformationType}`
          : cmd.commandType === 'scrub' && params?.transformationType
            ? `scrub:${params.transformationType}`
            : cmd.commandType === 'scrub' && params?.method
              ? `scrub:${params.method}`
              : cmd.commandType === 'standardize'
                ? 'standardize:apply'
                : cmd.commandType

      return isRecipeCompatibleCommand(cmdType)
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
      <aside className="w-[420px] border-l border-border/40 bg-gradient-to-b from-card/50 to-card/30 flex flex-col shrink-0" data-testid="audit-sidebar">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/40 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <History className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h2 className="font-semibold text-sm tracking-tight">Audit Log</h2>
                <p className="text-xs text-muted-foreground">
                  {tableEntries.length} {tableEntries.length === 1 ? 'change' : 'changes'}
                  {commandCount > 0 && (
                    <span className="ml-1.5 text-muted-foreground/60">
                      · {currentPosition + 1}/{commandCount}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {ENABLE_AUDIT_HIGHLIGHT && highlightedCommandId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-primary hover:bg-primary/10"
                      onClick={clearHighlight}
                    >
                      <Crosshair className="w-4 h-4" />
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
                    className="h-8 w-8 hover:bg-muted/60"
                    onClick={handleExportAsRecipe}
                    disabled={recipeCompatibleCount === 0}
                    data-testid="export-as-recipe-btn"
                  >
                    <BookOpen className="w-4 h-4" />
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
                    className="h-8 w-8 hover:bg-muted/60"
                    onClick={handleExportLog}
                    disabled={tableEntries.length === 0}
                    data-testid="audit-export-btn"
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Export audit log</TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-muted/60"
                onClick={() => {
                  if (ENABLE_AUDIT_HIGHLIGHT) clearHighlight()
                  setAuditSidebarOpen(false)
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Entries */}
        <ScrollArea className="flex-1">
          {tableEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <div className="p-4 rounded-2xl bg-muted/30 mb-4">
                <FileText className="w-10 h-10 text-muted-foreground/50" />
              </div>
              <p className="font-medium text-sm text-muted-foreground">No changes yet</p>
              <p className="text-xs text-muted-foreground/70 mt-1 max-w-[200px]">
                Apply transforms or edit data to see your change history here.
              </p>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {tableEntries.map((entry, index) => {
                const entryState = getEntryState(entry, index)
                const isFuture = entryState === 'future'
                const isCurrent = entryState === 'current'
                const isTransform = entry.entryType === 'A'

                const prevEntry = index > 0 ? tableEntries[index - 1] : null
                const prevState = prevEntry ? getEntryState(prevEntry, index - 1) : null
                const showSeparatorBefore = isCurrent && prevState === 'future'

                return (
                  <div
                    key={entry.id}
                    className="animate-in"
                    style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
                  >
                    {/* Current State separator */}
                    {showSeparatorBefore && (
                      <div className="flex items-center gap-3 py-3 mb-3">
                        <Separator className="flex-1 bg-primary/20" />
                        <span className="text-[11px] font-medium text-primary/80 uppercase tracking-wider">
                          Current State
                        </span>
                        <Separator className="flex-1 bg-primary/20" />
                      </div>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'group relative w-full text-left rounded-xl transition-all duration-200 cursor-pointer',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                        isFuture && 'opacity-50',
                        isCurrent
                          ? 'bg-primary/8 border border-primary/20 shadow-sm shadow-primary/5'
                          : 'bg-card/60 border border-border/30 hover:bg-card/80 hover:border-border/50 hover:shadow-sm'
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
                      {/* Current indicator bar */}
                      {isCurrent && (
                        <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-primary" />
                      )}

                      <div className="p-4">
                        {/* Top row: Type icon + Action + Undone badge */}
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            'shrink-0 p-2 rounded-lg transition-colors',
                            isTransform
                              ? 'bg-primary/10 text-primary'
                              : 'bg-amber-500/10 text-amber-500'
                          )}>
                            {isTransform ? (
                              <Layers className="w-4 h-4" />
                            ) : (
                              <PenLine className="w-4 h-4" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-sm text-foreground truncate">
                                {entry.action}
                              </h3>
                              {isFuture && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-5 px-1.5 bg-muted/50 text-muted-foreground border-muted-foreground/20 shrink-0"
                                >
                                  Undone
                                </Badge>
                              )}
                            </div>
                            {entry.details && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                                {entry.details}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Bottom row: Metadata */}
                        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/30">
                          <Badge
                            variant={isTransform ? 'default' : 'secondary'}
                            className={cn(
                              'text-[10px] h-5 px-2 font-medium',
                              isTransform
                                ? 'bg-primary/15 text-primary hover:bg-primary/20 border-0'
                                : 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 border-0'
                            )}
                          >
                            {isTransform ? 'Transform' : 'Edit'}
                          </Badge>

                          {/* Recipe eligibility indicator */}
                          {!isFuture && isRecipeEligible(entry) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center gap-1 text-emerald-500">
                                  <BookOpen className="w-3.5 h-3.5" />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">
                                Can be added to recipe
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {entry.rowsAffected !== undefined && (
                            <span className="text-[11px] text-muted-foreground">
                              {entry.rowsAffected.toLocaleString()} rows
                            </span>
                          )}

                          <span className="text-[11px] text-muted-foreground/70 ml-auto">
                            {formatTime(entry.timestamp)}
                          </span>
                        </div>

                        {/* Hidden highlight controls (feature flagged) */}
                        {ENABLE_AUDIT_HIGHLIGHT && (entry.hasRowDetails || shouldShowHighlight(entry)) && (
                          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/30">
                            {entry.hasRowDetails && (
                              <div className="flex items-center gap-1.5 text-xs text-primary">
                                <Eye className="w-3.5 h-3.5" />
                                <span>View details</span>
                              </div>
                            )}
                            {shouldShowHighlight(entry) && (
                              <button
                                onClick={(e) => toggleHighlight(entry, e)}
                                className={cn(
                                  'flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors',
                                  highlightedCommandId === findTimelineCommand(entry.auditEntryId)?.id
                                    ? 'bg-primary/20 text-primary'
                                    : 'text-muted-foreground hover:text-primary hover:bg-primary/10'
                                )}
                                title="Highlight affected cells in grid"
                              >
                                <Crosshair className="w-3.5 h-3.5" />
                                <span>
                                  {highlightedCommandId === findTimelineCommand(entry.auditEntryId)?.id
                                    ? 'Clear'
                                    : 'Highlight'}
                                </span>
                              </button>
                            )}
                          </div>
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
