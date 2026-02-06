/**
 * Confirmation dialog for updating a recipe step.
 *
 * Warns that the original step configuration will be lost (no versioning)
 * and offers a backup download before committing the update.
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
import { AlertTriangle, Download } from 'lucide-react'
import type { Recipe } from '@/types'
import { downloadRecipeAsJson } from '@/lib/recipe/recipe-exporter'

interface ConfirmStepUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recipe: Recipe | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmStepUpdateDialog({
  open,
  onOpenChange,
  recipe,
  onConfirm,
  onCancel,
}: ConfirmStepUpdateDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Update Recipe Step?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This will permanently modify this step. There is no versioning
                &mdash; the original configuration will be lost.
              </p>
              <p className="text-xs text-muted-foreground">
                Download a backup first if you want to preserve the current recipe.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {recipe && (
            <Button
              variant="outline"
              onClick={() => downloadRecipeAsJson(recipe)}
              className="mr-auto"
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Download Backup
            </Button>
          )}
          <AlertDialogCancel onClick={() => onCancel()}>Cancel</AlertDialogCancel>
          {/* Using Button instead of AlertDialogAction to prevent race condition.
              See ConfirmDiscardDialog for rationale. */}
          <Button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onConfirm()
            }}
          >
            Update Step
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
