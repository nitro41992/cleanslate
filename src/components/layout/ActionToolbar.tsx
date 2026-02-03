import { Sparkles, Users, Merge, Shield, GitCompare, Link2, BookOpen } from 'lucide-react'
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
import { useRecipeStore } from '@/stores/recipeStore'
import { cn } from '@/lib/utils'

type ActionId = PanelType | 'standardize'

const actions: { id: ActionId; label: string; icon: typeof Sparkles; description: string; shortcut: string }[] = [
  {
    id: 'clean',
    label: 'Clean',
    icon: Sparkles,
    description: 'Transform and clean data',
    shortcut: '1',
  },
  {
    id: 'standardize',
    label: 'Standardize',
    icon: Link2,
    description: 'Cluster and standardize values',
    shortcut: '2',
  },
  {
    id: 'match',
    label: 'Match',
    icon: Users,
    description: 'Find duplicate records',
    shortcut: '3',
  },
  {
    id: 'combine',
    label: 'Combine',
    icon: Merge,
    description: 'Stack or join tables',
    shortcut: '4',
  },
  {
    id: 'scrub',
    label: 'Scrub',
    icon: Shield,
    description: 'Obfuscate sensitive data',
    shortcut: '5',
  },
  {
    id: 'diff',
    label: 'Diff',
    icon: GitCompare,
    description: 'Compare tables',
    shortcut: '6',
  },
  {
    id: 'recipe',
    label: 'Recipes',
    icon: BookOpen,
    description: 'Save and apply recipe templates',
    shortcut: '7',
  },
]

interface ActionToolbarProps {
  disabled?: boolean
}

export function ActionToolbar({ disabled = false }: ActionToolbarProps) {
  const activePanel = usePreviewStore((s) => s.activePanel)
  const secondaryPanel = usePreviewStore((s) => s.secondaryPanel)
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const setSecondaryPanel = usePreviewStore((s) => s.setSecondaryPanel)
  const closeSecondaryPanel = usePreviewStore((s) => s.closeSecondaryPanel)
  const openDiffView = useDiffStore((s) => s.openView)
  const isDiffViewOpen = useDiffStore((s) => s.isViewOpen)
  const openMatchView = useMatcherStore((s) => s.openView)
  const isMatchViewOpen = useMatcherStore((s) => s.isViewOpen)
  const openStandardizeView = useStandardizerStore((s) => s.openView)
  const isStandardizeViewOpen = useStandardizerStore((s) => s.isViewOpen)
  const recipeCount = useRecipeStore((s) => s.recipes.length)

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

    // Recipe + Clean dual panel logic
    if (panelId === 'recipe') {
      if (activePanel === 'recipe') {
        // Toggle off recipe
        setActivePanel(null)
      } else if (activePanel === 'clean') {
        // Clean is open - toggle recipe as secondary panel
        if (secondaryPanel === 'recipe') {
          closeSecondaryPanel()
        } else {
          setSecondaryPanel('recipe')
        }
      } else {
        // Open recipe as primary
        setActivePanel('recipe')
      }
      return
    }

    if (panelId === 'clean') {
      if (activePanel === 'clean') {
        // Toggle off clean
        setActivePanel(null)
      } else if (activePanel === 'recipe') {
        // Recipe is open - switch to Clean as primary with Recipe as secondary
        setActivePanel('clean')
        setSecondaryPanel('recipe')
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
        } else if (action.id === 'recipe') {
          // Recipe can be active as primary OR secondary panel
          isActive = activePanel === 'recipe' || secondaryPanel === 'recipe'
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
                {action.id === 'recipe' && recipeCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-primary text-[10px] text-primary-foreground flex items-center justify-center font-medium">
                    {recipeCount}
                  </span>
                )}
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
