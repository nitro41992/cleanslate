import { Table, Plus, ChevronDown, Trash2, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useState } from 'react'
import { duplicateTable } from '@/lib/duckdb'
import { getAuditEntriesForTable } from '@/lib/audit-from-timeline'
import { formatNumber } from '@/lib/utils'
import { useDuckDB } from '@/hooks/useDuckDB'
import { ConfirmDeleteTableDialog } from './ConfirmDeleteTableDialog'

interface TableSelectorProps {
  onNewTable?: () => void
}

export function TableSelector({ onNewTable }: TableSelectorProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const setActiveTable = useTableStore((s) => s.setActiveTable)
  const checkpointTable = useTableStore((s) => s.checkpointTable)

  const setPreviewActiveTable = usePreviewStore((s) => s.setActiveTable)
  const { deleteTable } = useDuckDB()

  const [checkpointLoading, setCheckpointLoading] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [tableToDelete, setTableToDelete] = useState<{ id: string; name: string; rowCount: number } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const activeTable = tables.find((t) => t.id === activeTableId)

  const handleSelectTable = (tableId: string) => {
    const table = tables.find((t) => t.id === tableId)
    setActiveTable(tableId)
    setPreviewActiveTable(tableId, table?.name || null)
  }

  const handleCheckpoint = async (tableId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const table = tables.find((t) => t.id === tableId)
    if (!table) return

    setCheckpointLoading(tableId)
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const checkpointName = `${table.name}_checkpoint_${timestamp}`

      const { columns, rowCount } = await duplicateTable(table.name, checkpointName)

      // Get transformations from timeline-derived audit
      const tableTransformations = getAuditEntriesForTable(tableId)
        .map((e) => ({
          action: e.action,
          details: e.details,
          timestamp: e.timestamp,
          rowsAffected: e.rowsAffected,
        }))

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

  const handleDeleteClick = (table: { id: string; name: string; rowCount: number }, e: React.MouseEvent) => {
    e.stopPropagation()
    setTableToDelete(table)
    setDeleteConfirmOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!tableToDelete) return

    setIsDeleting(true)
    try {
      await deleteTable(tableToDelete.id, tableToDelete.name)
      if (activeTableId === tableToDelete.id) {
        setPreviewActiveTable(null, null)
      }
    } finally {
      setIsDeleting(false)
      setDeleteConfirmOpen(false)
      setTableToDelete(null)
    }
  }

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false)
    setTableToDelete(null)
  }

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="gap-2 min-w-[200px] justify-between"
          data-testid="table-selector"
        >
          <div className="flex items-center gap-2">
            <Table className="w-4 h-4 text-muted-foreground" />
            {activeTable ? (
              <span className="truncate max-w-[140px]">{activeTable.name}</span>
            ) : (
              <span className="text-muted-foreground">Select table</span>
            )}
          </div>
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Tables</span>
          {onNewTable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation()
                    onNewTable()
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Import new table</TooltipContent>
            </Tooltip>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tables.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No tables loaded.
            <br />
            Drop a CSV file to get started.
          </div>
        ) : (
          tables.map((table) => (
            <DropdownMenuItem
              key={table.id}
              className="flex items-center justify-between group cursor-pointer"
              onClick={() => handleSelectTable(table.id)}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Table className="w-4 h-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {table.name}
                    {table.isCheckpoint && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(checkpoint)</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(table.rowCount)} rows
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      disabled={checkpointLoading === table.id}
                      onClick={(e) => handleCheckpoint(table.id, e)}
                    >
                      {checkpointLoading === table.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create checkpoint</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={(e) => handleDeleteClick({ id: table.id, name: table.name, rowCount: table.rowCount }, e)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete table</TooltipContent>
                </Tooltip>
              </div>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>

    <ConfirmDeleteTableDialog
      open={deleteConfirmOpen}
      onOpenChange={setDeleteConfirmOpen}
      tableName={tableToDelete?.name || ''}
      rowCount={tableToDelete?.rowCount || 0}
      onConfirm={handleDeleteConfirm}
      onCancel={handleDeleteCancel}
      isDeleting={isDeleting}
    />
    </>
  )
}
