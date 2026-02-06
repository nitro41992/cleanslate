import { Loader2 } from 'lucide-react'
import { useOperationStore, type OperationSource } from '@/stores/operationStore'
import { usePreviewStore, type PanelType } from '@/stores/previewStore'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const SOURCE_TO_PANEL: Record<OperationSource, PanelType> = {
  clean: 'clean',
  recipe: 'recipe',
  combine: 'combine',
  match: 'match',
  standardize: null,
}

export function OperationIndicator() {
  const operations = useOperationStore((s) => s.getActiveOperations())
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)

  if (operations.length === 0) return null

  const handleClick = (source: OperationSource) => {
    const panel = SOURCE_TO_PANEL[source]
    if (panel) {
      setActivePanel(panel)
    }
  }

  if (operations.length === 1) {
    const op = operations[0]
    const progressText = op.progress >= 0 ? ` ${Math.round(op.progress)}%` : ''

    return (
      <button
        onClick={() => handleClick(op.source)}
        className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-500 transition-colors cursor-pointer"
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="max-w-[180px] truncate">{op.label}</span>
        {progressText && <span className="tabular-nums">{progressText}</span>}
      </button>
    )
  }

  // Multiple operations
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => handleClick(operations[0].source)}
            className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-500 transition-colors cursor-pointer"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{operations.length} operations</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px]">
          <div className="space-y-1.5">
            {operations.map((op) => (
              <div key={op.id} className="flex items-center gap-2 text-xs">
                <Loader2 className="w-3 h-3 animate-spin text-amber-500 shrink-0" />
                <span className="truncate">{op.label}</span>
                {op.progress >= 0 && (
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    {Math.round(op.progress)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
