import { X, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePreviewStore } from '@/stores/previewStore'
import { MemoryIndicator } from '@/components/common/MemoryIndicator'

export function StatusBar() {
  const pendingOperations = usePreviewStore((s) => s.pendingOperations)
  const isPreviewDirty = usePreviewStore((s) => s.isPreviewDirty)
  const changesSummary = usePreviewStore((s) => s.changesSummary)
  const isLargeFile = usePreviewStore((s) => s.isLargeFile)
  const estimatedSizeMB = usePreviewStore((s) => s.estimatedSizeMB)
  const clearPendingOperations = usePreviewStore((s) => s.clearPendingOperations)

  const pendingCount = pendingOperations.length
  const hasPendingChanges = pendingCount > 0 || isPreviewDirty

  // Build summary text
  const getSummaryText = () => {
    const parts: string[] = []
    if (changesSummary) {
      if (changesSummary.transformsApplied > 0) {
        parts.push(`${changesSummary.transformsApplied} transform${changesSummary.transformsApplied > 1 ? 's' : ''}`)
      }
      if (changesSummary.rowsMerged > 0) {
        parts.push(`${changesSummary.rowsMerged} merge${changesSummary.rowsMerged > 1 ? 's' : ''}`)
      }
      if (changesSummary.rowsCombined > 0) {
        parts.push(`${changesSummary.rowsCombined} row${changesSummary.rowsCombined > 1 ? 's' : ''} combined`)
      }
      if (changesSummary.columnsObfuscated > 0) {
        parts.push(`${changesSummary.columnsObfuscated} column${changesSummary.columnsObfuscated > 1 ? 's' : ''} scrubbed`)
      }
    }
    if (parts.length === 0 && pendingCount > 0) {
      return `${pendingCount} pending operation${pendingCount > 1 ? 's' : ''}`
    }
    return parts.join(', ')
  }

  return (
    <footer className="h-10 flex items-center justify-between px-4 border-t border-border/50 bg-card/30 shrink-0">
      {/* Left: Memory indicator and file size warning */}
      <div className="flex items-center gap-4">
        <MemoryIndicator compact />
        {isLargeFile && (
          <div className="flex items-center gap-1 text-xs text-amber-500">
            <AlertCircle className="w-3 h-3" />
            <span>Large file ({Math.round(estimatedSizeMB)}MB) - using lazy preview</span>
          </div>
        )}
      </div>

      {/* Center: Pending changes summary */}
      <div className="flex items-center gap-3">
        {hasPendingChanges && (
          <>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                Pending Changes
              </Badge>
              <span className="text-sm text-muted-foreground">
                {getSummaryText() || 'No changes yet'}
              </span>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={clearPendingOperations}
                >
                  <X className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Discard all pending changes</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Right: Empty placeholder for layout balance */}
      <div className="flex items-center gap-2" />
    </footer>
  )
}
