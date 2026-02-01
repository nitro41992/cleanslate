import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface AddColumnDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Position relative to reference column: 'left' or 'right' */
  position: 'left' | 'right'
  /** Reference column name (for display) */
  referenceColumn: string
  /** Called when user confirms with column name */
  onConfirm: (columnName: string) => void
}

export function AddColumnDialog({
  open,
  onOpenChange,
  position,
  referenceColumn,
  onConfirm,
}: AddColumnDialogProps) {
  const [columnName, setColumnName] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setColumnName('')
      setError(null)
      // Focus input after a short delay to allow animation
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const trimmedName = columnName.trim()
    if (!trimmedName) {
      setError('Column name is required')
      return
    }

    // Basic validation - no special characters that would break SQL
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedName)) {
      setError('Column name must start with a letter or underscore and contain only letters, numbers, and underscores')
      return
    }

    onConfirm(trimmedName)
    onOpenChange(false)
  }

  const positionText = position === 'left' ? 'before' : 'after'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Column</DialogTitle>
            <DialogDescription>
              Insert a new column {positionText} "{referenceColumn}". The column will be created with type VARCHAR (text).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="columnName">Column Name</Label>
              <Input
                ref={inputRef}
                id="columnName"
                value={columnName}
                onChange={(e) => {
                  setColumnName(e.target.value)
                  setError(null)
                }}
                placeholder="new_column"
                className={error ? 'border-destructive' : ''}
              />
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Add Column</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
