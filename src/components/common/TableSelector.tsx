import { Table, Plus, ChevronDown, Trash2, Loader2, Snowflake } from 'lucide-react'
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
import { formatNumber } from '@/lib/utils'
import { useDuckDB } from '@/hooks/useDuckDB'
import { ConfirmDeleteTableDialog } from './ConfirmDeleteTableDialog'
import { toast } from 'sonner'

interface TableSelectorProps {
  onNewTable?: () => void
}

export function TableSelector({ onNewTable }: TableSelectorProps) {
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const setActiveTable = useTableStore((s) => s.setActiveTable)
  const switchToTable = useTableStore((s) => s.switchToTable)
  const isContextSwitching = useTableStore((s) => s.isContextSwitching)
  const isTableFrozen = useTableStore((s) => s.isTableFrozen)

  const setPreviewActiveTable = usePreviewStore((s) => s.setActiveTable)
  const { deleteTable } = useDuckDB()

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [tableToDelete, setTableToDelete] = useState<{ id: string; name: string; rowCount: number } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const activeTable = tables.find((t) => t.id === activeTableId)

  const handleSelectTable = async (tableId: string) => {
    // If context switch is already in progress, ignore
    if (isContextSwitching) {
      return
    }

    const table = tables.find((t) => t.id === tableId)
    if (!table) return

    // Check if this is a frozen table that needs thawing
    const isFrozen = isTableFrozen(tableId)

    if (isFrozen || (activeTableId && activeTableId !== tableId)) {
      // Use switchToTable for freeze/thaw workflow
      console.log(`[TableSelector] Switching to table: ${table.name} (frozen: ${isFrozen})`)
      const success = await switchToTable(tableId)
      if (success) {
        setPreviewActiveTable(tableId, table.name)
      } else {
        toast.error(`Failed to switch to ${table.name}`)
      }
    } else {
      // Simple switch (no freeze/thaw needed - same table or first table)
      setActiveTable(tableId)
      setPreviewActiveTable(tableId, table.name)
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
          tables.map((table) => {
            const isFrozen = isTableFrozen(table.id)
            const isActive = table.id === activeTableId
            return (
            <DropdownMenuItem
              key={table.id}
              className="flex items-center justify-between group cursor-pointer"
              onClick={() => handleSelectTable(table.id)}
              disabled={isContextSwitching}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {isContextSwitching && table.id === activeTableId ? (
                  <Loader2 className="w-4 h-4 shrink-0 text-muted-foreground animate-spin" />
                ) : isFrozen ? (
                  <Snowflake className="w-4 h-4 shrink-0 text-blue-400" />
                ) : (
                  <Table className="w-4 h-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {table.name}
                    {table.isCheckpoint && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(checkpoint)</span>
                    )}
                    {isFrozen && !isActive && (
                      <span className="ml-1 text-[10px] text-blue-400">(on disk)</span>
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
                      onClick={(e) => handleDeleteClick({ id: table.id, name: table.name, rowCount: table.rowCount }, e)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete table</TooltipContent>
                </Tooltip>
              </div>
            </DropdownMenuItem>
            )
          })
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
