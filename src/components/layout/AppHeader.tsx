import { Sparkles, Download, History, Upload, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { TableSelector } from '@/components/common/TableSelector'
import { ActionToolbar } from './ActionToolbar'
import { TimelineScrubber } from '@/components/grid/TimelineScrubber'
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { useDuckDB } from '@/hooks/useDuckDB'

interface AppHeaderProps {
  onNewTable?: () => void
  onPersist?: () => void
  isPersisting?: boolean
}

export function AppHeader({ onNewTable, onPersist, isPersisting = false }: AppHeaderProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const auditSidebarOpen = usePreviewStore((s) => s.auditSidebarOpen)
  const toggleAuditSidebar = usePreviewStore((s) => s.toggleAuditSidebar)

  const { exportTable } = useDuckDB()

  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const auditEntries = useAuditStore((s) => s.entries)

  // Check if there are meaningful changes (not just "File Loaded")
  const hasChanges = activeTableId
    ? auditEntries.some(
        (entry) => entry.tableId === activeTableId && entry.action !== 'File Loaded'
      )
    : false

  const handleExport = () => {
    if (activeTable && activeTableId) {
      const filename = `${activeTable.name}_cleaned.csv`
      exportTable(activeTable.name, filename)
      addAuditEntry(
        activeTableId,
        activeTable.name,
        'Table Exported',
        `Exported to ${filename}`,
        'A'
      )
    }
  }

  return (
    <header className="h-14 flex items-center justify-between px-4 border-b border-border/50 bg-card/50 shrink-0">
      {/* Left section: Logo + Table selector */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-lg hidden md:inline">CleanSlate</span>
        </div>

        {/* Table selector dropdown */}
        <TableSelector onNewTable={onNewTable} />

        {/* Add file button when table is active */}
        {activeTable && onNewTable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onNewTable}
                className="text-muted-foreground"
              >
                <Upload className="w-4 h-4 mr-1" />
                <span className="hidden sm:inline">Add file</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Import another file</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Center section: Action toolbar */}
      <ActionToolbar disabled={!activeTable} />

      {/* Right section: Actions */}
      <div className="flex items-center gap-2">
        {activeTable && (
          <>
            {/* Timeline-based Undo/Redo */}
            <TimelineScrubber tableId={activeTableId ?? null} compact />

            <div className="w-px h-6 bg-border mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={auditSidebarOpen ? 'secondary' : 'ghost'}
                  size="icon"
                  onClick={toggleAuditSidebar}
                  className="h-8 w-8"
                  data-testid="toggle-audit-sidebar"
                >
                  <History className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle audit log</TooltipContent>
            </Tooltip>

            {hasChanges && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onPersist}
                    disabled={isPersisting}
                    data-testid="persist-table-btn"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    {isPersisting ? 'Saving...' : 'Persist as Table'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Save current state as a new table</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExport}
                  data-testid="export-csv-btn"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export as CSV</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </header>
  )
}
