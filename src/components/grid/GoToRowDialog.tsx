import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface GoToRowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Total number of rows in the table (1-based display) */
  totalRows: number
  /** Callback to scroll the grid to a specific row (0-based index) */
  onGoToRow: (rowIndex: number) => void
}

/**
 * Minimal dialog for jumping to a specific row number.
 * Triggered by Cmd+G / Ctrl+G when the data grid is active.
 */
export function GoToRowDialog({ open, onOpenChange, totalRows, onGoToRow }: GoToRowDialogProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setValue('')
      setError(null)
      // Small delay to allow dialog animation
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const handleSubmit = useCallback(() => {
    const num = parseInt(value, 10)
    if (isNaN(num) || num < 1 || num > totalRows) {
      setError(`Enter a row between 1 and ${totalRows.toLocaleString()}`)
      return
    }
    onGoToRow(num - 1) // Convert 1-based input to 0-based index
    onOpenChange(false)
  }, [value, totalRows, onGoToRow, onOpenChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs gap-3 p-4">
        <DialogHeader className="space-y-0.5">
          <DialogTitle className="text-sm font-medium">Go to Row</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {totalRows.toLocaleString()} rows total
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              ref={inputRef}
              type="number"
              min={1}
              max={totalRows}
              placeholder="Row number"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={handleKeyDown}
              className="h-8 text-sm tabular-nums"
            />
            {error && (
              <p className="text-[10px] text-destructive mt-1">{error}</p>
            )}
          </div>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!value}
            className="h-8 px-3 text-xs"
          >
            Go
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
