import { Sparkles, Download, Undo2, Redo2, History, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { TableSelector } from '@/components/common/TableSelector'
import { ActionToolbar } from './ActionToolbar'
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useEditStore } from '@/stores/editStore'
import { useAuditStore } from '@/stores/auditStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { useCallback } from 'react'

interface AppHeaderProps {
  onNewTable?: () => void
}

export function AppHeader({ onNewTable }: AppHeaderProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const auditSidebarOpen = usePreviewStore((s) => s.auditSidebarOpen)
  const toggleAuditSidebar = usePreviewStore((s) => s.toggleAuditSidebar)

  const { exportTable, updateCell } = useDuckDB()

  // Edit store for undo/redo
  const undo = useEditStore((s) => s.undo)
  const redo = useEditStore((s) => s.redo)
  const canUndo = useEditStore((s) => s.canUndo)
  const canRedo = useEditStore((s) => s.canRedo)
  const undoStackLength = useEditStore((s) => s.undoStack.length)
  const redoStackLength = useEditStore((s) => s.redoStack.length)

  const addAuditEntry = useAuditStore((s) => s.addEntry)

  const handleUndo = useCallback(async () => {
    const edit = undo()
    if (edit && activeTable) {
      await updateCell(edit.tableName, edit.rowIndex, edit.columnName, edit.previousValue)
      addAuditEntry(
        edit.tableId,
        edit.tableName,
        'Undo Edit',
        `Reverted cell [${edit.rowIndex}, ${edit.columnName}] from "${edit.newValue}" to "${edit.previousValue}"`,
        'B'
      )
    }
  }, [undo, activeTable, updateCell, addAuditEntry])

  const handleRedo = useCallback(async () => {
    const edit = redo()
    if (edit && activeTable) {
      await updateCell(edit.tableName, edit.rowIndex, edit.columnName, edit.newValue)
      addAuditEntry(
        edit.tableId,
        edit.tableName,
        'Redo Edit',
        `Re-applied cell [${edit.rowIndex}, ${edit.columnName}] from "${edit.previousValue}" to "${edit.newValue}"`,
        'B'
      )
    }
  }, [redo, activeTable, updateCell, addAuditEntry])

  const handleExport = () => {
    if (activeTable) {
      exportTable(activeTable.name, `${activeTable.name}_cleaned.csv`)
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleUndo}
                  disabled={!canUndo() || undoStackLength === 0}
                  className="h-8 w-8"
                >
                  <Undo2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Undo</p>
                <p className="text-xs text-muted-foreground">Ctrl+Z</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRedo}
                  disabled={!canRedo() || redoStackLength === 0}
                  className="h-8 w-8"
                >
                  <Redo2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Redo</p>
                <p className="text-xs text-muted-foreground">Ctrl+Shift+Z</p>
              </TooltipContent>
            </Tooltip>

            <div className="w-px h-6 bg-border mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={auditSidebarOpen ? 'secondary' : 'ghost'}
                  size="icon"
                  onClick={toggleAuditSidebar}
                  className="h-8 w-8"
                >
                  <History className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle audit log</TooltipContent>
            </Tooltip>

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
