import * as React from 'react'
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, X, Trash2, Columns } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

interface ColumnHeaderMenuProps {
  columnName: string
  columnType: string
  /** Human-readable type name for display */
  columnTypeDisplay?: string
  /** Description of what this column type means */
  columnTypeDescription?: string
  currentSortColumn: string | null
  currentSortDirection: 'asc' | 'desc'
  onSetSort: (direction: 'asc' | 'desc') => void
  onClearSort: () => void
  /** Column operations - if provided, shows column management section */
  onInsertColumnLeft?: () => void
  onInsertColumnRight?: () => void
  onDeleteColumn?: () => void
  /** Whether column operations are enabled (requires editable table) */
  columnOperationsEnabled?: boolean
  /** Controlled open state */
  open?: boolean
  /** Controlled open change handler */
  onOpenChange?: (open: boolean) => void
  /** Position for the popover */
  anchorPosition?: { x: number; y: number }
}

export function ColumnHeaderMenu({
  columnName,
  columnTypeDisplay,
  columnTypeDescription,
  currentSortColumn,
  currentSortDirection,
  onSetSort,
  onClearSort,
  onInsertColumnLeft,
  onInsertColumnRight,
  onDeleteColumn,
  columnOperationsEnabled = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  anchorPosition,
}: ColumnHeaderMenuProps) {
  // Use controlled state if provided, otherwise manage internally
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = controlledOnOpenChange ?? setInternalOpen

  const isColumnSorted = currentSortColumn === columnName

  const handleSort = (direction: 'asc' | 'desc') => {
    onSetSort(direction)
    setOpen(false)
  }

  const handleClearSort = () => {
    onClearSort()
    setOpen(false)
  }

  const handleInsertLeft = () => {
    onInsertColumnLeft?.()
    setOpen(false)
  }

  const handleInsertRight = () => {
    onInsertColumnRight?.()
    setOpen(false)
  }

  const handleDeleteClick = () => {
    // Call the delete handler directly - confirmation is handled by parent (DataGrid)
    // This follows the same pattern as RowMenu where confirmation is lifted
    onDeleteColumn?.()
    setOpen(false)
  }

  return (
    <>

    <Popover open={open} onOpenChange={setOpen}>
      {/* Virtual trigger at anchor position - use 1x1 size for Radix positioning */}
      <PopoverTrigger asChild>
        <div
          className="fixed pointer-events-none"
          style={anchorPosition ? {
            left: anchorPosition.x,
            top: anchorPosition.y,
            width: '1px',
            height: '1px',
          } : { display: 'none' }}
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0 z-50"
        align="start"
        sideOffset={4}
      >
        {/* Column Info Header */}
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <div className="font-medium text-sm text-foreground">{columnName}</div>
          {columnTypeDisplay && (
            <div className="text-xs text-muted-foreground mt-0.5">
              Type: <span className="text-amber-600 dark:text-amber-500">{columnTypeDisplay}</span>
            </div>
          )}
          {columnTypeDescription && (
            <div className="text-[10px] text-muted-foreground/70 mt-0.5">{columnTypeDescription}</div>
          )}
        </div>

        {/* Sort Section */}
        <div className="p-2">
          <div className="text-xs font-medium text-muted-foreground mb-2 px-2">Sort</div>
          <Button
            variant={isColumnSorted && currentSortDirection === 'asc' ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start gap-2 h-8"
            onClick={() => handleSort('asc')}
          >
            <ArrowUp className="h-3.5 w-3.5" />
            Sort Ascending
          </Button>
          <Button
            variant={isColumnSorted && currentSortDirection === 'desc' ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start gap-2 h-8"
            onClick={() => handleSort('desc')}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Sort Descending
          </Button>
          {isColumnSorted && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-8 text-muted-foreground"
              onClick={handleClearSort}
            >
              <X className="h-3.5 w-3.5" />
              Clear Sort
            </Button>
          )}
        </div>

        {/* Column Operations Section */}
        {columnOperationsEnabled && (
          <>
            <Separator />
            <div className="p-2">
              <div className="text-xs font-medium text-muted-foreground mb-2 px-2 flex items-center gap-1">
                <Columns className="h-3 w-3" />
                Column
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 h-8"
                onClick={handleInsertLeft}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Insert Left
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 h-8"
                onClick={handleInsertRight}
              >
                <ArrowRight className="h-3.5 w-3.5" />
                Insert Right
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={handleDeleteClick}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Column
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
    </>
  )
}
