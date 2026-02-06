import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOperationStore, type OperationSource } from '@/stores/operationStore'
import { useUIStore } from '@/stores/uiStore'
import { usePreviewStore, type PanelType } from '@/stores/previewStore'

const SOURCE_TO_PANEL: Record<OperationSource, PanelType> = {
  clean: 'clean',
  recipe: 'recipe',
  combine: 'combine',
  match: 'match',
  standardize: null,
}

interface GridOperationBannerProps {
  tableId: string
}

export function GridOperationBanner({ tableId }: GridOperationBannerProps) {
  const operations = useOperationStore((s) => s.getActiveOperations())
  const isTransforming = useUIStore((s) => s.transformingTables.has(tableId))
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)

  // Only show when this table has active work
  if (!isTransforming && operations.length === 0) return null

  // Find the first operation to determine the source panel
  const firstOp = operations[0]

  const handleView = () => {
    if (firstOp) {
      const panel = SOURCE_TO_PANEL[firstOp.source]
      if (panel) {
        setActivePanel(panel)
      }
    }
  }

  const label = firstOp?.label || 'Transform in progress'

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-xs">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 min-w-0">
        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
        <span className="truncate">
          Edits paused — {label}
        </span>
      </div>
      {firstOp && (
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-2 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-500 shrink-0"
          onClick={handleView}
        >
          View
        </Button>
      )}
    </div>
  )
}
