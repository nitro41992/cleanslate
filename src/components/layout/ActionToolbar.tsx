import { Sparkles, Users, Merge, Shield, GitCompare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePreviewStore, type PanelType } from '@/stores/previewStore'
import { useDiffStore } from '@/stores/diffStore'
import { cn } from '@/lib/utils'

const actions: { id: PanelType; label: string; icon: typeof Sparkles; description: string; shortcut: string }[] = [
  {
    id: 'clean',
    label: 'Clean',
    icon: Sparkles,
    description: 'Transform and clean data',
    shortcut: '1',
  },
  {
    id: 'match',
    label: 'Match',
    icon: Users,
    description: 'Find duplicate records',
    shortcut: '2',
  },
  {
    id: 'combine',
    label: 'Combine',
    icon: Merge,
    description: 'Stack or join tables',
    shortcut: '3',
  },
  {
    id: 'scrub',
    label: 'Scrub',
    icon: Shield,
    description: 'Obfuscate sensitive data',
    shortcut: '4',
  },
  {
    id: 'diff',
    label: 'Diff',
    icon: GitCompare,
    description: 'Compare tables',
    shortcut: '5',
  },
]

interface ActionToolbarProps {
  disabled?: boolean
}

export function ActionToolbar({ disabled = false }: ActionToolbarProps) {
  const activePanel = usePreviewStore((s) => s.activePanel)
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const openDiffView = useDiffStore((s) => s.openView)
  const isDiffViewOpen = useDiffStore((s) => s.isViewOpen)

  const handleClick = (panelId: PanelType) => {
    // Diff opens as a full-screen overlay instead of a side panel
    if (panelId === 'diff') {
      openDiffView()
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
        // Diff uses overlay state, others use panel state
        const isActive = action.id === 'diff' ? isDiffViewOpen : activePanel === action.id
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
                  'gap-2 transition-all',
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
