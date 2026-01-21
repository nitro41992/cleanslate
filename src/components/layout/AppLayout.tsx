import { ReactNode, useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppHeader } from './AppHeader'
import { StatusBar } from './StatusBar'
import { AuditSidebar } from './AuditSidebar'
import { FeaturePanel } from './FeaturePanel'
import { usePreviewStore } from '@/stores/previewStore'

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

      // Number keys 1-5 for panels
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key) {
          case '1':
            setActivePanel('clean')
            break
          case '2':
            setActivePanel('match')
            break
          case '3':
            setActivePanel('combine')
            break
          case '4':
            setActivePanel('scrub')
            break
          case '5':
            setActivePanel('diff')
            break
          case 'Escape':
            setActivePanel(null)
            break
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActivePanel])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-screen bg-background">
        {/* Header */}
        <AppHeader onNewTable={onNewTable} />

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
        <StatusBar onPersist={onPersist} isPersisting={isPersisting} />

        {/* Feature panel (slides in from right) */}
        <FeaturePanel>{panelContent}</FeaturePanel>
      </div>
    </TooltipProvider>
  )
}
