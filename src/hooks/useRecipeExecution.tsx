/**
 * useRecipeExecution - Shared hook for recipe execution with secret handling
 *
 * Encapsulates the recipe execution flow including:
 * - Column mapping detection
 * - Secret prompt for hash operations
 * - Execution with progress tracking
 */

import { useState, useCallback } from 'react'
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
import { useRecipeStore, type ColumnMapping } from '@/stores/recipeStore'
import { toast } from 'sonner'
import type { Recipe } from '@/types'

interface UseRecipeExecutionOptions {
  activeTableId: string | undefined
  activeTableName: string | undefined
  tableColumns: string[]
}

export function useRecipeExecution({ activeTableId, activeTableName, tableColumns }: UseRecipeExecutionOptions) {
  const setIsProcessing = useRecipeStore((s) => s.setIsProcessing)
  const setExecutionProgress = useRecipeStore((s) => s.setExecutionProgress)
  const setExecutionError = useRecipeStore((s) => s.setExecutionError)
  const setColumnMapping = useRecipeStore((s) => s.setColumnMapping)
  const clearColumnMapping = useRecipeStore((s) => s.clearColumnMapping)

  // Secret dialog state
  const [showSecretDialog, setShowSecretDialog] = useState(false)
  const [recipeSecret, setRecipeSecret] = useState('')
  const [pendingExecution, setPendingExecution] = useState<{
    recipe: Recipe
    mapping: ColumnMapping
  } | null>(null)

  // Column mapping dialog state (managed by parent, but we need to track pending mapping)
  const [pendingMappingRecipe, setPendingMappingRecipe] = useState<Recipe | null>(null)

  /**
   * Execute a recipe with all required prompts (mapping, secret)
   */
  const startExecution = useCallback(async (
    recipe: Recipe,
    onShowMappingDialog: (recipe: Recipe, mapping: ColumnMapping, unmapped: string[]) => void
  ) => {
    if (!activeTableId || !activeTableName) {
      toast.error('Please select a table first')
      return
    }

    const enabledSteps = recipe.steps.filter((s) => s.enabled)
    if (enabledSteps.length === 0) {
      toast.error('Recipe has no enabled steps')
      return
    }

    const { matchColumns } = await import('@/lib/recipe/column-matcher')
    const matchResult = matchColumns(recipe.requiredColumns, tableColumns)

    if (matchResult.unmapped.length > 0) {
      const initialMapping: ColumnMapping = {}
      for (const col of recipe.requiredColumns) {
        initialMapping[col] = matchResult.mapping[col] || ''
      }
      setColumnMapping(initialMapping)
      useRecipeStore.getState().setUnmappedColumns(matchResult.unmapped)
      setPendingMappingRecipe(recipe)
      onShowMappingDialog(recipe, initialMapping, matchResult.unmapped)
      return
    }

    await executeWithSecretCheck(recipe, matchResult.mapping)
  }, [activeTableId, activeTableName, tableColumns, setColumnMapping])

  /**
   * Continue execution after column mapping is confirmed
   */
  const continueAfterMapping = useCallback(async (mapping: ColumnMapping) => {
    if (!pendingMappingRecipe) return

    const recipe = pendingMappingRecipe
    setPendingMappingRecipe(null)
    await executeWithSecretCheck(recipe, mapping)
  }, [pendingMappingRecipe])

  /**
   * Check if secret is needed and either prompt or execute directly
   */
  const executeWithSecretCheck = useCallback(async (recipe: Recipe, mapping: ColumnMapping) => {
    const { recipeRequiresSecret } = await import('@/lib/recipe/recipe-executor')

    if (recipeRequiresSecret(recipe)) {
      setPendingExecution({ recipe, mapping })
      setRecipeSecret('')
      setShowSecretDialog(true)
      return
    }

    await doExecute(recipe, mapping)
  }, [])

  /**
   * Execute the recipe
   */
  const doExecute = useCallback(async (recipe: Recipe, mapping: ColumnMapping, secret?: string) => {
    if (!activeTableId || !activeTableName) return

    setIsProcessing(true)
    setExecutionError(null)

    try {
      const { executeRecipe } = await import('@/lib/recipe/recipe-executor')
      await executeRecipe(recipe, activeTableId, activeTableName, mapping, (progress) => {
        setExecutionProgress(progress)
      }, secret)

      toast.success(`Recipe applied (${recipe.steps.filter((s) => s.enabled).length} steps)`)
    } catch (err) {
      console.error('Recipe execution failed:', err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      setExecutionError(message)
      toast.error('Recipe failed', { description: message })
    } finally {
      setIsProcessing(false)
      setExecutionProgress(null)
      clearColumnMapping()
    }
  }, [activeTableId, activeTableName, setIsProcessing, setExecutionError, setExecutionProgress, clearColumnMapping])

  /**
   * Handle confirm secret and execute
   */
  const handleConfirmSecret = useCallback(async () => {
    if (!pendingExecution) return

    if (recipeSecret.length < 5) {
      toast.error('Secret must be at least 5 characters')
      return
    }

    setShowSecretDialog(false)
    await doExecute(pendingExecution.recipe, pendingExecution.mapping, recipeSecret)
    setPendingExecution(null)
    setRecipeSecret('')
  }, [pendingExecution, recipeSecret, doExecute])

  /**
   * Secret dialog element - render this directly in your component with {secretDialogElement}
   */
  const secretDialogElement = (
    <Dialog open={showSecretDialog} onOpenChange={(open) => {
      setShowSecretDialog(open)
      if (!open) {
        setPendingExecution(null)
        setRecipeSecret('')
      }
    }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Secret Required</DialogTitle>
          <DialogDescription>
            This recipe includes hash operations that require a secret key for security.
            The secret is not stored in recipes for security reasons.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Label htmlFor="recipe-secret">Hash Secret</Label>
          <Input
            id="recipe-secret"
            type="password"
            value={recipeSecret}
            onChange={(e) => setRecipeSecret(e.target.value)}
            placeholder="Enter secret (min 5 characters)"
            className="mt-2"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && recipeSecret.length >= 5) {
                handleConfirmSecret()
              }
            }}
          />
          <p className="text-xs text-muted-foreground mt-2">
            Use the same secret you used when creating the original data to get consistent hash values.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setShowSecretDialog(false)
              setPendingExecution(null)
              setRecipeSecret('')
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirmSecret} disabled={recipeSecret.length < 5}>
            Apply Recipe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return {
    startExecution,
    continueAfterMapping,
    secretDialogElement,
  }
}
