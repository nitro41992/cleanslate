import { ReactNode, useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppHeader } from './AppHeader'
import { StatusBar } from './StatusBar'
import { AuditSidebar } from './AuditSidebar'
import { FeaturePanel } from './FeaturePanel'
import { usePreviewStore } from '@/stores/previewStore'
import { useDiffStore } from '@/stores/diffStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { useUIStore } from '@/stores/uiStore'

interface AppLayoutProps {
  children: ReactNode
  panelContent?: ReactNode
  onNewTable?: () => void
  onPersist?: () => void
  isPersisting?: boolean
}

export function AppLayout({
  children,
  panelContent,
  onNewTable,
  onPersist,
  isPersisting,
}: AppLayoutProps) {
  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const openDiffView = useDiffStore((s) => s.openView)
  const openMatchView = useMatcherStore((s) => s.openView)

  // Keyboard shortcuts for panels
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      // Number keys 1-5 for panels (2 and 5 open overlays)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key) {
          case '1':
            setActivePanel('clean')
            break
          case '2':
            openMatchView()
            break
          case '3':
            setActivePanel('combine')
            break
          case '4':
            setActivePanel('scrub')
            break
          case '5':
            openDiffView()
            break
          case 'Escape':
            setActivePanel(null)
            break
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActivePanel, openDiffView, openMatchView])

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
      <div className="flex flex-col h-screen bg-background">
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
        <FeaturePanel>{panelContent}</FeaturePanel>
      </div>
    </TooltipProvider>
  )
}
