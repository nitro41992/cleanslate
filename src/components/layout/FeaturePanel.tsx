import { ReactNode } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { usePreviewStore, type PanelType } from '@/stores/previewStore'
import { Wand2, Users, Merge, GitCompare, BookOpen, X, PanelLeft } from 'lucide-react'

// Panel metadata (including recipe for secondary panel display)
const panelMeta: Record<NonNullable<PanelType>, { title: string; shortTitle: string; description: string; icon: typeof Wand2; color: string }> = {
  clean: {
    title: 'Transform',
    shortTitle: 'Transform',
    description: 'Apply transformations to your data',
    icon: Wand2,
    color: 'text-emerald-500',
  },
  match: {
    title: 'Smart Dedupe',
    shortTitle: 'Smart Dedupe',
    description: 'Detect and merge duplicate records',
    icon: Users,
    color: 'text-blue-500',
  },
  combine: {
    title: 'Combine Tables',
    shortTitle: 'Combine',
    description: 'Stack (UNION) or join tables together',
    icon: Merge,
    color: 'text-violet-500',
  },
  diff: {
    title: 'Compare Tables',
    shortTitle: 'Diff',
    description: 'Find differences between two tables',
    icon: GitCompare,
    color: 'text-amber-500',
  },
  recipe: {
    title: 'Recipe',
    shortTitle: 'Recipe',
    description: 'Save and apply transformation recipes',
    icon: BookOpen,
    color: 'text-sky-500',
  },
}

interface FeaturePanelProps {
  children?: ReactNode
  secondaryContent?: ReactNode
}

export function FeaturePanel({ children, secondaryContent }: FeaturePanelProps) {
  const activePanel = usePreviewStore((s) => s.activePanel)
  const secondaryPanel = usePreviewStore((s) => s.secondaryPanel)
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const closeSecondaryPanel = usePreviewStore((s) => s.closeSecondaryPanel)

  const isOpen = activePanel !== null
  const meta = activePanel ? panelMeta[activePanel] : null
  const Icon = meta?.icon || Wand2

  // Secondary panel metadata
  const secondaryMeta = secondaryPanel ? panelMeta[secondaryPanel] : null

  // Determine total width based on dual vs single panel mode
  const hasDualPanels = secondaryPanel !== null && secondaryContent !== null
  const getPanelWidth = () => {
    // max-w-none overrides Sheet's default sm:max-w-md constraint
    if (hasDualPanels) {
      // Dual panel: 340px (secondary) + 880px (primary) = 1220px
      return 'w-[1220px] max-w-none'
    }
    // Single panel: Recipe gets full 880px as primary panel for recipe management
    if (['clean', 'combine', 'recipe'].includes(activePanel || '')) {
      return 'w-[880px] max-w-none'
    }
    return 'w-[400px] max-w-none'
  }

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && setActivePanel(null)}>
      <SheetContent
        side="right"
        className={cn(
          getPanelWidth(),
          'p-0 flex flex-col',
          'transition-[width] duration-300 ease-out'
        )}
        aria-describedby="feature-panel-description"
      >
        {meta && (
          <>
            {/* Header */}
            <SheetHeader className="px-4 py-3 border-b border-border/40 shrink-0 bg-card/50">
              <div className="flex items-center gap-3">
                {/* Primary panel info */}
                <div className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center',
                  'bg-gradient-to-br from-primary/20 to-primary/5',
                  'ring-1 ring-primary/20'
                )}>
                  <Icon className={cn('w-4.5 h-4.5', meta.color)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <SheetTitle className="text-base">{meta.title}</SheetTitle>
                    {hasDualPanels && secondaryMeta && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0 h-5 bg-muted/50 hover:bg-muted/70 cursor-default"
                      >
                        <PanelLeft className="w-3 h-3 mr-1 opacity-60" />
                        {secondaryMeta.shortTitle}
                      </Badge>
                    )}
                  </div>
                  <SheetDescription id="feature-panel-description" className="text-xs mt-0.5">
                    {meta.description}
                  </SheetDescription>
                </div>

                {/* Close secondary panel button (when in dual mode) */}
                {hasDualPanels && secondaryMeta && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 shrink-0"
                    onClick={closeSecondaryPanel}
                  >
                    <secondaryMeta.icon className="w-4 h-4" />
                    Close {secondaryMeta.shortTitle}
                  </Button>
                )}

                {/* Close entire panel button */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0"
                      onClick={() => setActivePanel(null)}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    Close panel
                  </TooltipContent>
                </Tooltip>
              </div>
            </SheetHeader>

            {/* Content area */}
            <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
              {/* Secondary panel content (left, narrower) */}
              {hasDualPanels && (
                <div
                  className={cn(
                    'w-[340px] shrink-0 flex flex-col',
                    'border-r border-border/40',
                    'animate-in slide-in-from-left-2 fade-in duration-200'
                  )}
                  data-testid={`panel-${secondaryPanel}`}
                >
                  <div className="flex-1 min-h-0 w-full max-w-full overflow-hidden">
                    {secondaryContent}
                  </div>
                </div>
              )}

              {/* Primary panel content (right, fills remaining space) */}
              <div
                className="flex-1 min-w-0 overflow-hidden"
                data-testid={`panel-${activePanel}`}
              >
                {children}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
