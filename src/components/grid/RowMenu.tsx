import * as React from 'react'
import { ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

interface RowMenuProps {
  /** Row number (1-based for display) */
  rowNumber: number
  /** Row identifier (_cs_id) */
  csId: string
  onInsertAbove: () => void
  onInsertBelow: () => void
  onDelete: () => void
  /** Controlled open state */
  open?: boolean
  /** Controlled open change handler */
  onOpenChange?: (open: boolean) => void
  /** Position for the popover */
  anchorPosition?: { x: number; y: number }
}

export function RowMenu({
  rowNumber,
  csId: _csId,
  onInsertAbove,
  onInsertBelow,
  onDelete,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  anchorPosition,
}: RowMenuProps) {
  // Use controlled state if provided, otherwise manage internally
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = controlledOnOpenChange ?? setInternalOpen

  const handleInsertAbove = () => {
    onInsertAbove()
    setOpen(false)
  }

  const handleInsertBelow = () => {
    onInsertBelow()
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
          className="w-48 p-0 z-50"
          align="start"
          sideOffset={4}
        >
          {/* Row Info */}
          <div className="px-3 py-2 border-b border-border">
            <div className="text-xs font-medium text-muted-foreground">Row {rowNumber}</div>
          </div>

          {/* Row Operations */}
          <div className="p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-8"
              onClick={handleInsertAbove}
            >
              <ArrowUp className="h-3.5 w-3.5" />
              Insert Above
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-8"
              onClick={handleInsertBelow}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              Insert Below
            </Button>

            <Separator className="my-2" />

            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Row
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
