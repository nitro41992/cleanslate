import { ReactNode, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Sparkles,
  GitCompare,
  Users,
  Shield,
  Table,
  Trash2,
  HardDrive,
  ChevronDown,
  Save,
  Loader2,
  AlertTriangle,
  Merge,
  Plus,
  Copy,
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
import { getAuditEntriesForTable } from '@/lib/audit-from-timeline'
import { duplicateTable } from '@/lib/duckdb'
import { MemoryIndicator } from '@/components/common/MemoryIndicator'
import { formatNumber } from '@/lib/utils'
import { usePersistence } from '@/hooks/usePersistence'

const navItems = [
  {
    label: 'Laundromat',
    icon: Sparkles,
    path: '/laundromat',
    description: 'Clean & transform data',
  },
  {
    label: 'Matcher',
    icon: Users,
    path: '/matcher',
    description: 'Find duplicates',
  },
  {
    label: 'Combiner',
    icon: Merge,
    path: '/combiner',
    description: 'Stack & join tables',
  },
  {
    label: 'Scrubber',
    icon: Shield,
    path: '/scrubber',
    description: 'Obfuscate data',
  },
  {
    label: 'Diff',
    icon: GitCompare,
    path: '/diff',
    description: 'Compare tables',
  },
]

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const setActiveTable = useTableStore((s) => s.setActiveTable)
  const removeTable = useTableStore((s) => s.removeTable)
  const checkpointTable = useTableStore((s) => s.checkpointTable)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const persistenceStatus = useUIStore((s) => s.persistenceStatus)

  const { saveAllTables, isRestoring } = usePersistence()

  const [checkpointLoading, setCheckpointLoading] = useState<string | null>(null)

  // Checkpoint handler - create a snapshot of the current table state
  const handleCheckpoint = async (tableId: string) => {
    const table = tables.find((t) => t.id === tableId)
    if (!table) return

    setCheckpointLoading(tableId)
    try {
      // Generate checkpoint name with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const checkpointName = `${table.name}_checkpoint_${timestamp}`

      // Duplicate the table in DuckDB
      const { columns, rowCount } = await duplicateTable(table.name, checkpointName)

      // Get transformations applied to this table from timeline (derived audit)
      const tableTransformations = getAuditEntriesForTable(tableId)
        .map((e) => ({
          action: e.action,
          details: e.details,
          timestamp: e.timestamp,
          rowsAffected: e.rowsAffected,
        }))

      // Add to table store with lineage info
      checkpointTable(
        tableId,
        checkpointName,
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount,
        tableTransformations
      )
    } catch (error) {
      console.error('Failed to create checkpoint:', error)
    } finally {
      setCheckpointLoading(null)
    }
  }

  // Navigate to Laundromat and trigger file upload
  const handleNewTable = () => {
    navigate('/laundromat')
    // Dispatch custom event to trigger file upload dialog
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('trigger-file-upload'))
    }, 100)
  }

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
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleNewTable}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Import new table</p>
                    </TooltipContent>
                  </Tooltip>
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                </div>
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
                          <p className="text-sm truncate">
                            {table.name}
                            {table.isCheckpoint && (
                              <span className="ml-1 text-[10px] text-muted-foreground">(checkpoint)</span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatNumber(table.rowCount)} rows
                          </p>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                disabled={checkpointLoading === table.id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCheckpoint(table.id)
                                }}
                              >
                                {checkpointLoading === table.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Create checkpoint</p>
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeTable(table.id)
                                }}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Delete table</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
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

                {/* Storage Actions */}
                <div className="flex gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={saveAllTables}
                        disabled={isRestoring || tables.length === 0}
                      >
                        {isRestoring ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        <span className="ml-1.5">Save All</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Save all tables to browser storage</p>
                    </TooltipContent>
                  </Tooltip>
                </div>

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

                {/* Warning about clearing browser data */}
                {persistenceStatus === 'saved' && (
                  <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    Clearing browser data will erase saved tables
                  </p>
                )}
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
