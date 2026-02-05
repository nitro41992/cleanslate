import { useState } from 'react'
import { BookOpen, ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRecipeStore } from '@/stores/recipeStore'
import { usePreviewStore } from '@/stores/previewStore'
import { toast } from 'sonner'
import type { RecipeStep } from '@/types'

export interface AddToRecipeButtonProps {
  /** Callback to build a RecipeStep from the current form state. Return null if invalid. */
  buildStep: () => Omit<RecipeStep, 'id'> | null
  /** Whether the current form state allows adding to a recipe */
  canAdd: boolean
  /** Whether an operation is in progress (disables the button) */
  isProcessing?: boolean
  /** Label for toast messages (e.g., "Trim whitespace", "Privacy Transforms") */
  stepLabel?: string
  /** Test ID for the button */
  testId?: string
  /** Required columns for the recipe (used when creating new recipe) */
  requiredColumns?: string[]
}

/**
 * Shared "Add to Recipe" button component.
 *
 * Renders either:
 * - A direct button when a recipe is selected in the Recipe panel
 * - A dropdown menu with "Create New Recipe" and existing recipes
 *
 * Visibility is animated based on whether the Recipe panel is open.
 */
export function AddToRecipeButton({
  buildStep,
  canAdd,
  isProcessing = false,
  stepLabel = 'step',
  testId = 'add-to-recipe-btn',
  requiredColumns = [],
}: AddToRecipeButtonProps) {
  // Recipe store
  const recipes = useRecipeStore((s) => s.recipes)
  const selectedRecipeId = useRecipeStore((s) => s.selectedRecipeId)
  const addRecipe = useRecipeStore((s) => s.addRecipe)
  const addStep = useRecipeStore((s) => s.addStep)
  const setSelectedRecipe = useRecipeStore((s) => s.setSelectedRecipe)

  // Panel visibility
  const secondaryPanel = usePreviewStore((s) => s.secondaryPanel)
  const setSecondaryPanel = usePreviewStore((s) => s.setSecondaryPanel)

  // Dialog state
  const [showNewRecipeDialog, setShowNewRecipeDialog] = useState(false)
  const [newRecipeName, setNewRecipeName] = useState('')
  const [pendingStep, setPendingStep] = useState<Omit<RecipeStep, 'id'> | null>(null)

  const selectedRecipe = recipes.find((r) => r.id === selectedRecipeId)

  // Handle "Add to New Recipe" action
  const handleAddToNewRecipe = () => {
    const step = buildStep()
    if (!step) return

    setPendingStep(step)
    setNewRecipeName('')
    setShowNewRecipeDialog(true)
  }

  // Handle creating recipe with the pending step
  const handleCreateRecipeWithStep = () => {
    if (!newRecipeName.trim()) {
      toast.error('Please enter a recipe name')
      return
    }

    if (!pendingStep) return

    // Create the recipe first
    const recipeId = addRecipe({
      name: newRecipeName.trim(),
      description: '',
      version: '1.0',
      requiredColumns,
      steps: [],
    })

    // Add the pending step to it
    addStep(recipeId, pendingStep)

    // Open Recipe panel if not already open
    if (secondaryPanel !== 'recipe') {
      setSecondaryPanel('recipe')
    }
    setSelectedRecipe(recipeId)

    setShowNewRecipeDialog(false)
    setPendingStep(null)
    toast.success('Recipe created', {
      description: `Added ${stepLabel} to "${newRecipeName.trim()}"`,
    })
  }

  // Handle "Add to Existing Recipe" action
  const handleAddToExistingRecipe = (recipeId: string) => {
    const step = buildStep()
    if (!step) return

    const recipe = recipes.find((r) => r.id === recipeId)
    const added = addStep(recipeId, step)

    if (!added) {
      toast.info('Step already exists in recipe', {
        description: 'This exact step is already in the recipe',
      })
      return
    }

    // Open Recipe panel if not already open and select the recipe
    if (secondaryPanel !== 'recipe') {
      setSecondaryPanel('recipe')
    }
    setSelectedRecipe(recipeId)

    toast.success('Step added to recipe', {
      description: `Added ${stepLabel} to "${recipe?.name}"`,
    })
  }

  // Handle direct add to selected recipe (when recipe panel is open with a selection)
  const handleAddToSelectedRecipe = () => {
    if (!selectedRecipeId) return
    handleAddToExistingRecipe(selectedRecipeId)
  }

  return (
    <>
      {/* Button/Dropdown - animated visibility based on recipe panel */}
      <div
        className={`transition-all duration-150 overflow-hidden ${
          secondaryPanel === 'recipe'
            ? 'flex-1 opacity-100'
            : 'w-0 opacity-0'
        }`}
      >
        {selectedRecipeId && selectedRecipe ? (
          // Direct add to selected recipe
          <Button
            variant="outline"
            className="w-full whitespace-nowrap"
            disabled={!canAdd || isProcessing}
            onClick={handleAddToSelectedRecipe}
            data-testid={testId}
          >
            <BookOpen className="w-4 h-4 mr-2" />
            Add to {selectedRecipe.name}
          </Button>
        ) : (
          // Dropdown when no recipe selected
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="w-full whitespace-nowrap"
                disabled={!canAdd || isProcessing}
                data-testid={testId}
              >
                <BookOpen className="w-4 h-4 mr-2" />
                Add to Recipe
                <ChevronDown className="w-3 h-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={handleAddToNewRecipe}>
                <Plus className="w-4 h-4 mr-2" />
                Create New Recipe...
              </DropdownMenuItem>
              {recipes.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Add to Existing</DropdownMenuLabel>
                  {recipes.map((recipe) => (
                    <DropdownMenuItem
                      key={recipe.id}
                      onClick={() => handleAddToExistingRecipe(recipe.id)}
                    >
                      {recipe.name}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {recipe.steps.length} steps
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* New Recipe Dialog */}
      <Dialog open={showNewRecipeDialog} onOpenChange={setShowNewRecipeDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create New Recipe</DialogTitle>
            <DialogDescription>
              The current transform will be added as the first step.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="new-recipe-name">Recipe Name</Label>
            <Input
              id="new-recipe-name"
              value={newRecipeName}
              onChange={(e) => setNewRecipeName(e.target.value)}
              placeholder="e.g., Email Cleanup"
              className="mt-2"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewRecipeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateRecipeWithStep}>
              Create & Add Step
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
