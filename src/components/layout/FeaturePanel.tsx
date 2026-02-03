import { ReactNode } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { usePreviewStore, type PanelType } from '@/stores/previewStore'
import { Sparkles, Users, Merge, Shield, GitCompare, BookOpen } from 'lucide-react'

const panelMeta: Record<NonNullable<PanelType>, { title: string; description: string; icon: typeof Sparkles }> = {
  clean: {
    title: 'Clean & Transform',
    description: 'Build a recipe of transformations to clean your data',
    icon: Sparkles,
  },
  match: {
    title: 'Find Duplicates',
    description: 'Detect and merge duplicate records',
    icon: Users,
  },
  combine: {
    title: 'Combine Tables',
    description: 'Stack (UNION) or join tables together',
    icon: Merge,
  },
  scrub: {
    title: 'Scrub Data',
    description: 'Obfuscate sensitive data with hashing, masking, or redaction',
    icon: Shield,
  },
  diff: {
    title: 'Compare Tables',
    description: 'Find differences between two tables',
    icon: GitCompare,
  },
  recipe: {
    title: 'Recipe Templates',
    description: 'Save, load, and apply multi-step transformation recipes',
    icon: BookOpen,
  },
}

interface FeaturePanelProps {
  children?: ReactNode
}

export function FeaturePanel({ children }: FeaturePanelProps) {
  const activePanel = usePreviewStore((s) => s.activePanel)
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)

  const isOpen = activePanel !== null
  const meta = activePanel ? panelMeta[activePanel] : null
  const Icon = meta?.icon || Sparkles

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && setActivePanel(null)}>
      <SheetContent
        side="right"
        className={`${['clean', 'combine', 'scrub', 'recipe'].includes(activePanel || '') ? 'w-[880px] sm:max-w-[880px]' : 'w-[400px] sm:max-w-[400px]'} p-0 flex flex-col`}
        aria-describedby="feature-panel-description"
      >
        {meta && (
          <>
            <SheetHeader className="p-4 border-b border-border/50 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <SheetTitle>{meta.title}</SheetTitle>
                  <SheetDescription id="feature-panel-description" className="text-xs">
                    {meta.description}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div className="flex-1 overflow-auto" data-testid={`panel-${activePanel}`}>
              {children}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
