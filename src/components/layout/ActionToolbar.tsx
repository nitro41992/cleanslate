import { Wand2, Users, Merge, GitCompare, Link2, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePreviewStore, type PanelType } from '@/stores/previewStore'
import { useDiffStore } from '@/stores/diffStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { useStandardizerStore } from '@/stores/standardizerStore'
import { cn } from '@/lib/utils'

export type ActionId = PanelType | 'standardize'

export const actions: { id: ActionId; label: string; icon: typeof Wand2; description: string; shortcut: string }[] = [
  {
    id: 'clean',
    label: 'Transform',
    icon: Wand2,
    description: 'Transform and clean data',
    shortcut: 'T',
  },
  {
    id: 'standardize',
    label: 'Smart Replace',
    icon: Link2,
    description: 'Find and fix similar values',
    shortcut: 'S',
  },
  {
    id: 'match',
    label: 'Merge',
    icon: Users,
    description: 'Find and merge duplicate records',
    shortcut: 'M',
  },
  {
    id: 'combine',
    label: 'Combine',
    icon: Merge,
    description: 'Stack or join tables',
    shortcut: 'C',
  },
  {
    id: 'diff',
    label: 'Diff',
    icon: GitCompare,
    description: 'Compare tables',
    shortcut: 'D',
  },
  {
    id: 'recipe',
    label: 'Recipes',
    icon: BookOpen,
    description: 'Build and apply transformation recipes',
    shortcut: 'R',
  },
]

interface ActionToolbarProps {
  disabled?: boolean
}

export function ActionToolbar({ disabled = false }: ActionToolbarProps) {
  const activePanel = usePreviewStore((s) => s.activePanel)
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const closeSecondaryPanel = usePreviewStore((s) => s.closeSecondaryPanel)
  const openDiffView = useDiffStore((s) => s.openView)
  const isDiffViewOpen = useDiffStore((s) => s.isViewOpen)
  const openMatchView = useMatcherStore((s) => s.openView)
  const isMatchViewOpen = useMatcherStore((s) => s.isViewOpen)
  const openStandardizeView = useStandardizerStore((s) => s.openView)
  const isStandardizeViewOpen = useStandardizerStore((s) => s.isViewOpen)

  const handleClick = (panelId: ActionId) => {
    // Diff, Match, and Standardize open as full-screen overlays instead of side panels
    if (panelId === 'diff') {
      openDiffView()
      return
    }

    if (panelId === 'match') {
      openMatchView()
      return
    }

    if (panelId === 'standardize') {
      openStandardizeView()
      return
    }

    if (panelId === 'clean') {
      if (activePanel === 'clean') {
        // Toggle off clean (also closes secondary recipe panel)
        setActivePanel(null)
        closeSecondaryPanel()
      } else {
        // Open clean as primary
        setActivePanel('clean')
      }
      return
    }

    if (activePanel === panelId) {
      // Toggle off if already active
      setActivePanel(null)
    } else {
      setActivePanel(panelId)
    }
  }

  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label="Data operations">
      {actions.map((action) => {
        // Diff, Match, and Standardize use overlay state, others use panel state
        let isActive = false
        if (action.id === 'diff') {
          isActive = isDiffViewOpen
        } else if (action.id === 'match') {
          isActive = isMatchViewOpen
        } else if (action.id === 'standardize') {
          isActive = isStandardizeViewOpen
        } else {
          isActive = activePanel === action.id
        }
        const Icon = action.icon

        return (
          <Tooltip key={action.id}>
            <TooltipTrigger asChild>
              <Button
                variant={isActive ? 'default' : 'ghost'}
                size="sm"
                onClick={() => handleClick(action.id)}
                disabled={disabled}
                className={cn(
                  'gap-2 transition-all relative',
                  isActive && 'shadow-md'
                )}
                aria-pressed={isActive}
                data-testid={`toolbar-${action.id}`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{action.label}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{action.label}</p>
              <p className="text-xs text-muted-foreground">
                {action.description}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Press <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">{action.shortcut}</kbd> to toggle
              </p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
