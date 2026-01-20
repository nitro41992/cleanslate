import { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Sparkles,
  GitCompare,
  Users,
  Shield,
  Table,
  Trash2,
  HardDrive,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTableStore } from '@/stores/tableStore'
import { useUIStore } from '@/stores/uiStore'
import { MemoryIndicator } from '@/components/common/MemoryIndicator'
import { formatNumber } from '@/lib/utils'

const navItems = [
  {
    label: 'Laundromat',
    icon: Sparkles,
    path: '/laundromat',
    description: 'Clean & transform data',
  },
  {
    label: 'Diff',
    icon: GitCompare,
    path: '/diff',
    description: 'Compare tables',
  },
  {
    label: 'Matcher',
    icon: Users,
    path: '/matcher',
    description: 'Find duplicates',
  },
  {
    label: 'Scrubber',
    icon: Shield,
    path: '/scrubber',
    description: 'Obfuscate data',
  },
]

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation()
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const setActiveTable = useTableStore((s) => s.setActiveTable)
  const removeTable = useTableStore((s) => s.removeTable)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const persistenceStatus = useUIStore((s) => s.persistenceStatus)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen bg-background">
        {/* Sidebar */}
        <aside
          className={cn(
            'flex flex-col border-r border-border/50 bg-card/50 transition-all duration-300',
            sidebarCollapsed ? 'w-16' : 'w-64'
          )}
        >
          {/* Logo */}
          <div className="h-14 flex items-center px-4 border-b border-border/50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-primary-foreground" />
              </div>
              {!sidebarCollapsed && (
                <span className="font-semibold text-lg">CleanSlate</span>
              )}
            </div>
          </div>

          {/* Navigation */}
          <nav className="p-2 space-y-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path
              return (
                <Tooltip key={item.path}>
                  <TooltipTrigger asChild>
                    <NavLink
                      to={item.path}
                      className={cn(
                        'sidebar-item',
                        isActive && 'active'
                      )}
                    >
                      <item.icon className="w-5 h-5 shrink-0" />
                      {!sidebarCollapsed && (
                        <span className="truncate">{item.label}</span>
                      )}
                    </NavLink>
                  </TooltipTrigger>
                  {sidebarCollapsed && (
                    <TooltipContent side="right">
                      <p className="font-medium">{item.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    </TooltipContent>
                  )}
                </Tooltip>
              )
            })}
          </nav>

          <Separator className="my-2" />

          {/* Tables Section */}
          {!sidebarCollapsed && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Tables
                </span>
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              </div>
              <ScrollArea className="flex-1 px-2">
                <div className="space-y-1 pb-4">
                  {tables.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-2 py-4 text-center">
                      No tables loaded yet.
                      <br />
                      Drop a file to get started.
                    </p>
                  ) : (
                    tables.map((table) => (
                      <div
                        key={table.id}
                        className={cn(
                          'group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors',
                          activeTableId === table.id
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-muted/50'
                        )}
                        onClick={() => setActiveTable(table.id)}
                      >
                        <Table className="w-4 h-4 shrink-0 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{table.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatNumber(table.rowCount)} rows
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeTable(table.id)
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Footer - Persistence Status */}
          <div className="mt-auto border-t border-border/50">
            {!sidebarCollapsed && (
              <div className="p-3 space-y-3">
                <MemoryIndicator />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>
                    {persistenceStatus === 'saved'
                      ? 'All changes saved'
                      : persistenceStatus === 'saving'
                      ? 'Saving...'
                      : persistenceStatus === 'error'
                      ? 'Save failed'
                      : 'Ready'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {children}
        </main>
      </div>
    </TooltipProvider>
  )
}
