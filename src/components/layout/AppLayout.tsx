import { ReactNode, useEffect, useCallback } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppHeader } from './AppHeader'
import { StatusBar } from './StatusBar'
import { AuditSidebar } from './AuditSidebar'
import { FeaturePanel } from './FeaturePanel'
import { actions, type ActionId } from './ActionToolbar'
import { usePreviewStore } from '@/stores/previewStore'
import { useDiffStore } from '@/stores/diffStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { useStandardizerStore } from '@/stores/standardizerStore'
import { useUIStore } from '@/stores/uiStore'

interface AppLayoutProps {
  children: ReactNode
  panelContent?: ReactNode
  secondaryPanelContent?: ReactNode
  onNewTable?: () => void
  onPersist?: () => void
  isPersisting?: boolean
}

export function AppLayout({
  children,
  panelContent,
  secondaryPanelContent,
  onNewTable,
  onPersist,
  isPersisting,
}: AppLayoutProps) {
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const openDiffView = useDiffStore((s) => s.openView)
  const openMatchView = useMatcherStore((s) => s.openView)
  const openStandardizeView = useStandardizerStore((s) => s.openView)

  // Handler for action shortcuts - centralized from ActionToolbar
  const handleActionShortcut = useCallback((actionId: ActionId) => {
    switch (actionId) {
      case 'diff':
        openDiffView()
        break
      case 'match':
        openMatchView()
        break
      case 'standardize':
        openStandardizeView()
        break
      default:
        setActivePanel(actionId)
    }
  }, [setActivePanel, openDiffView, openMatchView, openStandardizeView])

  // Keyboard shortcuts for panels - uses shortcuts defined in ActionToolbar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Escape closes panel
        if (e.key === 'Escape') {
          setActivePanel(null)
          return
        }

        // Check if key matches any action shortcut (case-insensitive)
        const action = actions.find(
          a => a.shortcut.toLowerCase() === e.key.toLowerCase()
        )
        if (action) {
          handleActionShortcut(action.id)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActivePanel, handleActionShortcut])

  // Event listener for storage quota warning to open sidebar
  useEffect(() => {
    const handleOpenSidebar = () => {
      const { sidebarCollapsed, toggleSidebar } = useUIStore.getState()
      if (sidebarCollapsed) {
        toggleSidebar()
      }
    }

    window.addEventListener('open-table-sidebar', handleOpenSidebar)
    return () => window.removeEventListener('open-table-sidebar', handleOpenSidebar)
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
        {/* Header */}
        <AppHeader onNewTable={onNewTable} onPersist={onPersist} isPersisting={isPersisting} />

        {/* Main content area */}
        <div className="flex-1 flex min-h-0">
          {/* Main content */}
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {children}
          </main>

          {/* Audit sidebar (conditionally rendered) */}
          <AuditSidebar />
        </div>

        {/* Status bar */}
        <StatusBar />

        {/* Feature panel (slides in from right) */}
        <FeaturePanel secondaryContent={secondaryPanelContent}>
          {panelContent}
        </FeaturePanel>
      </div>
    </TooltipProvider>
  )
}
