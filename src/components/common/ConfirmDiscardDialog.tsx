/**
 * Confirmation dialog for discarding undone operations.
 *
 * Shown when user is in the middle of undo/redo history and performs
 * a new action that would discard redo-able operations.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { AlertTriangle } from 'lucide-react'

interface ConfirmDiscardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  futureStatesCount: number
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDiscardDialog({
  open,
  onOpenChange,
  futureStatesCount,
  onConfirm,
  onCancel,
}: ConfirmDiscardDialogProps) {
  const operationWord = futureStatesCount === 1 ? 'operation' : 'operations'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Discard Undone Changes?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                You have <strong>{futureStatesCount}</strong> undone {operationWord} that
                will be <strong>permanently discarded</strong> if you continue.
              </p>
              <p className="text-xs text-muted-foreground">
                To preserve these changes, press Cancel and use Redo (Ctrl+Y) first.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard & Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
