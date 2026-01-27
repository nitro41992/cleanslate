import { useCallback, useMemo } from 'react'
import { Undo2, Redo2, RotateCcw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTimelineStore, useTimelineNavigation } from '@/stores/timelineStore'
import { useTableStore } from '@/stores/tableStore'
import { useUIStore } from '@/stores/uiStore'
import { undoTimeline, redoTimeline, replayToPosition } from '@/lib/timeline-engine'
import { cn } from '@/lib/utils'

interface TimelineScrubberProps {
  tableId: string | null
  className?: string
  /** Compact mode shows only undo/redo buttons */
  compact?: boolean
}

/**
 * Visual timeline scrubber for navigating through transformation history.
 *
 * Shows:
 * - Undo/Redo buttons
 * - Visual step indicators (circles/diamonds)
 * - Current position marker
 * - Snapshot indicators (diamonds)
 * - Reset to original button
 *
 * Interactions:
 * - Click any step to jump to that position
 * - Hover shows tooltip with command label
 * - Keyboard: Ctrl+Z for undo, Ctrl+Y for redo
 */
export function TimelineScrubber({ tableId, className, compact = false }: TimelineScrubberProps) {
  const { canUndo, canRedo, position, total } = useTimelineNavigation(tableId)
  const timeline = useTimelineStore((s) => (tableId ? s.getTimeline(tableId) : null))
  const isReplaying = useTimelineStore((s) => s.isReplaying)
  const replayProgress = useTimelineStore((s) => s.replayProgress)
  const updateTable = useTableStore((s) => s.updateTable)
  const refreshMemory = useUIStore((s) => s.refreshMemory)
  const markTableDirty = useUIStore((s) => s.markTableDirty)

  const handleUndo = useCallback(async () => {
    if (!tableId || isReplaying) return
    markTableDirty(tableId)
    const result = await undoTimeline(tableId)
    if (result) {
      updateTable(tableId, { rowCount: result.rowCount, columns: result.columns })
    }
    refreshMemory()
  }, [tableId, isReplaying, updateTable, refreshMemory, markTableDirty])

  const handleRedo = useCallback(async () => {
    if (!tableId || isReplaying) return
    markTableDirty(tableId)
    const result = await redoTimeline(tableId)
    if (result) {
      updateTable(tableId, { rowCount: result.rowCount, columns: result.columns })
    }
    refreshMemory()
  }, [tableId, isReplaying, updateTable, refreshMemory, markTableDirty])

  const handleReset = useCallback(async () => {
    if (!tableId || isReplaying) return
    markTableDirty(tableId)
    const result = await replayToPosition(tableId, -1)
    if (result) {
      updateTable(tableId, { rowCount: result.rowCount, columns: result.columns })
    }
    refreshMemory()
  }, [tableId, isReplaying, updateTable, refreshMemory, markTableDirty])

  const handleStepClick = useCallback(async (stepIndex: number) => {
    if (!tableId || isReplaying) return
    markTableDirty(tableId)
    const result = await replayToPosition(tableId, stepIndex)
    if (result) {
      updateTable(tableId, { rowCount: result.rowCount, columns: result.columns })
    }
    refreshMemory()
  }, [tableId, isReplaying, updateTable, refreshMemory, markTableDirty])

  // Get commands and snapshots for rendering
  const commands = useMemo(() => timeline?.commands ?? [], [timeline])
  const snapshots = useMemo(() => timeline?.snapshots ?? new Map(), [timeline])

  // No timeline or no commands - show minimal UI
  if (!tableId || !timeline) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled className="h-7 w-7" data-testid="undo-btn">
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Undo (Ctrl+Z)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled className="h-7 w-7" data-testid="redo-btn">
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Redo (Ctrl+Y)</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    )
  }

  // Compact mode: just undo/redo buttons
  if (compact) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleUndo}
                disabled={!canUndo || isReplaying}
                className="h-7 w-7"
                data-testid="undo-btn"
              >
                {isReplaying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Undo2 className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Undo (Ctrl+Z)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRedo}
                disabled={!canRedo || isReplaying}
                className="h-7 w-7"
                data-testid="redo-btn"
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Redo (Ctrl+Y)</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {total > 0 && (
          <span className="text-xs text-muted-foreground ml-1">
            {position + 1}/{total}
          </span>
        )}
      </div>
    )
  }

  // Full timeline view
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <TooltipProvider delayDuration={300}>
        {/* Reset to original */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleReset}
              disabled={position < 0 || isReplaying}
              className="h-7 w-7"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Reset to Original</p>
          </TooltipContent>
        </Tooltip>

        {/* Undo */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleUndo}
              disabled={!canUndo || isReplaying}
              className="h-7 w-7"
              data-testid="undo-btn"
            >
              {isReplaying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Undo2 className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Undo (Ctrl+Z)</p>
          </TooltipContent>
        </Tooltip>

        {/* Timeline steps */}
        {commands.length > 0 && (
          <div className="flex items-center gap-0.5 mx-1">
            {/* Original state indicator */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => handleStepClick(-1)}
                  disabled={isReplaying}
                  className={cn(
                    'w-2.5 h-2.5 rounded-full border-2 transition-all hover:scale-125',
                    position === -1
                      ? 'bg-primary border-primary'
                      : 'border-muted-foreground/50 hover:border-primary'
                  )}
                  aria-label="Original state"
                />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="font-medium">Original State</p>
              </TooltipContent>
            </Tooltip>

            {/* Connecting line */}
            <div className="w-2 h-0.5 bg-muted-foreground/30" />

            {/* Command steps */}
            {commands.map((cmd, index) => {
              const isCurrentStep = position === index
              const hasSnapshot = snapshots.has(index)
              const isPastStep = index <= position

              return (
                <div key={cmd.id} className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleStepClick(index)}
                        disabled={isReplaying}
                        className={cn(
                          'transition-all hover:scale-125 border-2',
                          // Shape: diamond for snapshot, circle for regular
                          hasSnapshot ? 'w-3 h-3 rotate-45' : 'w-2.5 h-2.5 rounded-full',
                          // Color: filled for current, outlined for others
                          isCurrentStep
                            ? 'bg-primary border-primary'
                            : isPastStep
                              ? 'border-primary/70 bg-primary/30'
                              : 'border-muted-foreground/50 hover:border-primary'
                        )}
                        aria-label={`Step ${index + 1}: ${cmd.label}`}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[200px]">
                      <p className="font-medium">{cmd.label}</p>
                      <p className="text-xs text-muted-foreground">
                        Step {index + 1}
                        {hasSnapshot && ' (snapshot)'}
                      </p>
                      {cmd.rowsAffected !== undefined && (
                        <p className="text-xs text-muted-foreground">
                          {cmd.rowsAffected.toLocaleString()} rows affected
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>

                  {/* Connecting line (except after last) */}
                  {index < commands.length - 1 && (
                    <div
                      className={cn(
                        'w-2 h-0.5',
                        isPastStep ? 'bg-primary/50' : 'bg-muted-foreground/30'
                      )}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Redo */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRedo}
              disabled={!canRedo || isReplaying}
              className="h-7 w-7"
              data-testid="redo-btn"
            >
              <Redo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Redo (Ctrl+Y)</p>
          </TooltipContent>
        </Tooltip>

        {/* Progress indicator during replay */}
        {isReplaying && replayProgress > 0 && (
          <span className="text-xs text-muted-foreground">
            {replayProgress}%
          </span>
        )}

        {/* Position indicator */}
        {!isReplaying && total > 0 && (
          <span className="text-xs text-muted-foreground">
            {position + 1}/{total}
          </span>
        )}
      </TooltipProvider>
    </div>
  )
}

/**
 * Keyboard shortcut handler for timeline navigation.
 * Should be added to a parent component that owns the timeline.
 */
export function useTimelineKeyboardShortcuts(tableId: string | null) {
  const markTableDirty = useUIStore((s) => s.markTableDirty)

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      if (!tableId) return

      // Undo: Ctrl+Z (not Cmd+Shift+Z for redo on Mac)
      if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        markTableDirty(tableId)
        await undoTimeline(tableId)
        return
      }

      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
        e.preventDefault()
        markTableDirty(tableId)
        await redoTimeline(tableId)
        return
      }
    },
    [tableId, markTableDirty]
  )

  return handleKeyDown
}
