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
import { Sparkles, Users, Merge, Shield, GitCompare, BookOpen, X, PanelLeft } from 'lucide-react'

// Panel metadata (including recipe for secondary panel display)
const panelMeta: Record<NonNullable<PanelType>, { title: string; shortTitle: string; description: string; icon: typeof Sparkles; color: string }> = {
  clean: {
    title: 'Clean & Transform',
    shortTitle: 'Clean',
    description: 'Transform and clean your data with powerful operations',
    icon: Sparkles,
    color: 'text-emerald-500',
  },
  match: {
    title: 'Find Duplicates',
    shortTitle: 'Match',
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
  scrub: {
    title: 'Scrub Data',
    shortTitle: 'Scrub',
    description: 'Obfuscate sensitive data with hashing, masking, or redaction',
    icon: Shield,
    color: 'text-rose-500',
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
  const Icon = meta?.icon || Sparkles

  // Secondary panel metadata
  const secondaryMeta = secondaryPanel ? panelMeta[secondaryPanel] : null
  const SecondaryIcon = secondaryMeta?.icon || BookOpen

  // Determine total width based on dual vs single panel mode
  const hasDualPanels = secondaryPanel !== null && secondaryContent !== null
  const getPanelWidth = () => {
    // max-w-none overrides Sheet's default sm:max-w-md constraint
    if (hasDualPanels) {
      // Dual panel: 340px (secondary) + 880px (primary) = 1220px
      return 'w-[1220px] max-w-none'
    }
    // Single panel: Recipe gets full 880px as primary panel for recipe management
    if (['clean', 'combine', 'scrub', 'recipe'].includes(activePanel || '')) {
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
                {hasDualPanels && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0"
                        onClick={closeSecondaryPanel}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Close {secondaryMeta?.shortTitle} panel
                    </TooltipContent>
                  </Tooltip>
                )}
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
                    'bg-muted/20',
                    'animate-in slide-in-from-left-2 fade-in duration-200'
                  )}
                  data-testid={`panel-${secondaryPanel}`}
                >
                  {/* Secondary panel header indicator */}
                  <div className="shrink-0 px-3 py-2 border-b border-border/30 bg-muted/40">
                    <div className="flex items-center gap-2">
                      <SecondaryIcon className={cn('w-3.5 h-3.5', secondaryMeta?.color)} />
                      <span className="text-xs font-medium text-muted-foreground">
                        {secondaryMeta?.shortTitle}
                      </span>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
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
