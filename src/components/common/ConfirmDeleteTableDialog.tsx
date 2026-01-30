/**
 * Confirmation dialog for deleting a table.
 *
 * Warns users that deletion is permanent and releases all associated data.
 */

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'
import { formatNumber } from '@/lib/utils'

interface ConfirmDeleteTableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tableName: string
  rowCount: number
  onConfirm: () => void
  onCancel: () => void
  isDeleting?: boolean
}

export function ConfirmDeleteTableDialog({
  open,
  onOpenChange,
  tableName,
  rowCount,
  onConfirm,
  onCancel,
  isDeleting = false,
}: ConfirmDeleteTableDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Delete Table?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Are you sure you want to delete <strong>{tableName}</strong>?
              </p>
              <p className="text-xs text-muted-foreground">
                This will permanently remove {formatNumber(rowCount)} rows and all undo history.
                This action cannot be undone.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onCancel()} disabled={isDeleting}>
            Cancel
          </AlertDialogCancel>
          <Button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onConfirm()
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
