import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Play,
  Plus,
  Trash2,
  Download,
  Upload,
  AlertCircle,
  Check,
  Pencil,
  BookOpen,
  Sparkles,
  Minimize2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useRecipeStore, selectSelectedRecipe } from '@/stores/recipeStore'
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useRecipeExecution } from '@/hooks/useRecipeExecution'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { RecipeStep } from '@/types'
import { RecipeStepCard } from '@/components/recipe/RecipeStepCard'

/**
 * RecipePanelPrimary - Independent recipe management view (880px primary panel)
 *
 * Layout:
 * - Left sidebar (280px): Recipe list with create/import buttons
 * - Right main area: Selected recipe details with pipeline visualization
 *
 * When adding steps, opens Clean panel as secondary for familiar transform UX.
 */
export function RecipePanelPrimary() {
  const recipes = useRecipeStore((s) => s.recipes)
  const selectedRecipeId = useRecipeStore((s) => s.selectedRecipeId)
  const selectedRecipe = useRecipeStore(selectSelectedRecipe)
  const isProcessing = useRecipeStore((s) => s.isProcessing)
  const executionProgress = useRecipeStore((s) => s.executionProgress)
  const executionError = useRecipeStore((s) => s.executionError)
  const pendingColumnMapping = useRecipeStore((s) => s.pendingColumnMapping)
  const unmappedColumns = useRecipeStore((s) => s.unmappedColumns)

  const setSelectedRecipe = useRecipeStore((s) => s.setSelectedRecipe)
  const addRecipe = useRecipeStore((s) => s.addRecipe)
  const updateRecipe = useRecipeStore((s) => s.updateRecipe)
  const deleteRecipe = useRecipeStore((s) => s.deleteRecipe)
  const toggleStepEnabled = useRecipeStore((s) => s.toggleStepEnabled)
  const removeStep = useRecipeStore((s) => s.removeStep)
  const reorderSteps = useRecipeStore((s) => s.reorderSteps)
  const updateColumnMapping = useRecipeStore((s) => s.updateColumnMapping)
  const clearColumnMapping = useRecipeStore((s) => s.clearColumnMapping)

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const setActivePanel = usePreviewStore((s) => s.setActivePanel)
  const setSecondaryPanel = usePreviewStore((s) => s.setSecondaryPanel)

  // Dialog states
  const [showNewRecipeDialog, setShowNewRecipeDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showMappingDialog, setShowMappingDialog] = useState(false)
  const [newRecipeName, setNewRecipeName] = useState('')

  // Editing states
  const [editingName, setEditingName] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [tempName, setTempName] = useState('')
  const [tempDescription, setTempDescription] = useState('')

  // Track newly added steps for highlight animation
  const [newlyAddedStepId, setNewlyAddedStepId] = useState<string | null>(null)
  const prevStepsLengthRef = useRef<number>(0)

  // Get table columns for mapping
  const tableColumns = useMemo(() => {
    if (!activeTable) return []
    return activeTable.columns
      .filter((c) => !c.name.startsWith('_cs_') && !c.name.startsWith('__'))
      .map((c) => c.name)
  }, [activeTable])

  // Recipe execution hook with secret handling
  const { startExecution, continueAfterMapping, secretDialogElement } = useRecipeExecution({
    activeTableId: activeTableId ?? undefined,
    activeTableName: activeTable?.name ?? undefined,
    tableColumns,
  })

  // Detect newly added steps and trigger highlight
  useEffect(() => {
    if (selectedRecipe) {
      const currentLength = selectedRecipe.steps.length
      if (currentLength > prevStepsLengthRef.current && prevStepsLengthRef.current > 0) {
        // A step was added - highlight the last one
        const lastStep = selectedRecipe.steps[currentLength - 1]
        if (lastStep) {
          setNewlyAddedStepId(lastStep.id)
          // Clear highlight after animation
          setTimeout(() => setNewlyAddedStepId(null), 2000)
        }
      }
      prevStepsLengthRef.current = currentLength
    }
  }, [selectedRecipe?.steps.length])

  // Handle recipe name edit
  const startEditingName = () => {
    if (selectedRecipe) {
      setTempName(selectedRecipe.name)
      setEditingName(true)
    }
  }

  const saveNameEdit = () => {
    if (selectedRecipe && tempName.trim()) {
      updateRecipe(selectedRecipe.id, { name: tempName.trim() })
    }
    setEditingName(false)
  }

  // Handle recipe description edit
  const startEditingDescription = () => {
    if (selectedRecipe) {
      setTempDescription(selectedRecipe.description)
      setEditingDescription(true)
    }
  }

  const saveDescriptionEdit = () => {
    if (selectedRecipe) {
      updateRecipe(selectedRecipe.id, { description: tempDescription })
    }
    setEditingDescription(false)
  }

  // Handle step reordering
  const moveStepUp = (index: number) => {
    if (selectedRecipe && index > 0) {
      reorderSteps(selectedRecipe.id, index, index - 1)
    }
  }

  const moveStepDown = (index: number) => {
    if (selectedRecipe && index < selectedRecipe.steps.length - 1) {
      reorderSteps(selectedRecipe.id, index, index + 1)
    }
  }

  // Handle create new recipe
  const handleCreateRecipe = () => {
    if (!newRecipeName.trim()) {
      toast.error('Please enter a recipe name')
      return
    }

    const recipeId = addRecipe({
      name: newRecipeName.trim(),
      description: '',
      version: '1.0',
      requiredColumns: [],
      steps: [],
    })

    setSelectedRecipe(recipeId)
    setShowNewRecipeDialog(false)
    setNewRecipeName('')
    toast.success('Recipe created')
  }

  // Handle delete recipe
  const handleDeleteRecipe = () => {
    if (!selectedRecipeId) return
    deleteRecipe(selectedRecipeId)
    setShowDeleteDialog(false)
    toast.success('Recipe deleted')
  }

  // Handle export recipe to JSON
  const handleExport = () => {
    if (!selectedRecipe) return

    const exportData = {
      name: selectedRecipe.name,
      description: selectedRecipe.description,
      version: selectedRecipe.version,
      requiredColumns: selectedRecipe.requiredColumns,
      steps: selectedRecipe.steps,
      createdAt: selectedRecipe.createdAt.toISOString(),
      modifiedAt: selectedRecipe.modifiedAt.toISOString(),
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedRecipe.name.replace(/[^a-zA-Z0-9]/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)

    toast.success('Recipe exported')
  }

  // Handle import recipe from JSON
  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        const data = JSON.parse(text)

        if (!data.name || !Array.isArray(data.steps)) {
          throw new Error('Invalid recipe format')
        }

        const recipeId = addRecipe({
          name: data.name,
          description: data.description || '',
          version: data.version || '1.0',
          requiredColumns: data.requiredColumns || [],
          steps: data.steps.map((s: RecipeStep) => ({
            ...s,
            enabled: s.enabled !== false,
          })),
        })

        setSelectedRecipe(recipeId)
        toast.success(`Recipe "${data.name}" imported`)
      } catch (err) {
        console.error('Failed to import recipe:', err)
        toast.error('Failed to import recipe')
      }
    }
    input.click()
  }

  // Handle "Add Step" - opens Clean panel as secondary
  const handleAddStep = () => {
    if (!selectedRecipeId) {
      toast.error('Please select or create a recipe first')
      return
    }
    // Switch to Clean as primary, Recipe as secondary
    setActivePanel('clean')
    setSecondaryPanel('recipe')
  }

  // Handle collapse to Clean panel with Recipe as secondary
  const handleCollapseToClean = () => {
    setActivePanel('clean')
    setSecondaryPanel('recipe')
  }

  // Handle apply recipe
  const handleApplyRecipe = async () => {
    if (!selectedRecipe) return

    await startExecution(selectedRecipe, (_recipe, _mapping, _unmapped) => {
      setShowMappingDialog(true)
    })
  }

  // Handle confirm column mapping
  const handleConfirmMapping = async () => {
    if (!selectedRecipe || !pendingColumnMapping) return

    const stillUnmapped = unmappedColumns.filter((col) => !pendingColumnMapping[col])
    if (stillUnmapped.length > 0) {
      toast.error(`Please map all columns: ${stillUnmapped.join(', ')}`)
      return
    }

    setShowMappingDialog(false)
    await continueAfterMapping(pendingColumnMapping)
  }

  // Format date for display
  const formatDate = (date: Date): string => {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div className="flex h-full">
      {/* Left Sidebar: Recipe List */}
      <div className="w-[280px] shrink-0 border-r border-border/40 flex flex-col bg-muted/10">
        {/* Sidebar Header */}
        <div className="p-3 border-b border-border/40">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Recipes</h3>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleCollapseToClean}
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse to Clean view</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleImport}
                    aria-label="Import recipe"
                  >
                    <Upload className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Import recipe</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setShowNewRecipeDialog(true)}
                    aria-label="Create new recipe"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Create new recipe</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Recipe List */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {recipes.length === 0 ? (
              <div className="text-center py-8">
                <BookOpen className="w-8 h-8 mx-auto text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">No recipes yet</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() => setShowNewRecipeDialog(true)}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Create Recipe
                </Button>
              </div>
            ) : (
              recipes.map((recipe) => (
                <button
                  key={recipe.id}
                  onClick={() => setSelectedRecipe(recipe.id)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md transition-colors',
                    'hover:bg-muted/50',
                    selectedRecipeId === recipe.id && 'bg-muted'
                  )}
                >
                  <div className="font-medium text-sm truncate">{recipe.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">
                      {recipe.steps.length} steps
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(recipe.modifiedAt)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right Main Area: Recipe Detail */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedRecipe ? (
          <>
            {/* Recipe Header */}
            <div className="p-4 border-b border-border/40 shrink-0">
              {/* Name (editable) */}
              <div className="mb-2">
                {editingName ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={tempName}
                      onChange={(e) => setTempName(e.target.value)}
                      className="h-8 text-lg font-semibold"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveNameEdit()
                        if (e.key === 'Escape') setEditingName(false)
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={saveNameEdit}
                    >
                      <Check className="w-4 h-4" />
                    </Button>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-2 group cursor-pointer"
                    onClick={startEditingName}
                  >
                    <h2 className="text-lg font-semibold">{selectedRecipe.name}</h2>
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                )}
              </div>

              {/* Description (editable) */}
              {editingDescription ? (
                <div className="space-y-2">
                  <Textarea
                    value={tempDescription}
                    onChange={(e) => setTempDescription(e.target.value)}
                    className="text-sm min-h-[60px]"
                    placeholder="Add a description..."
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={saveDescriptionEdit}
                  >
                    Done
                  </Button>
                </div>
              ) : (
                <p
                  className="text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={startEditingDescription}
                >
                  {selectedRecipe.description || 'Click to add description...'}
                </p>
              )}

              {/* Metadata badges */}
              <div className="flex items-center gap-2 mt-3">
                <Badge variant="secondary" className="text-xs">
                  v{selectedRecipe.version}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {selectedRecipe.steps.filter((s) => s.enabled).length}/{selectedRecipe.steps.length} enabled
                </Badge>
                {selectedRecipe.requiredColumns.length > 0 && (
                  <Badge variant="outline" className="text-xs">
                    {selectedRecipe.requiredColumns.length} columns
                  </Badge>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 mt-4">
                <Button
                  size="sm"
                  onClick={handleApplyRecipe}
                  disabled={
                    isProcessing ||
                    !activeTableId ||
                    selectedRecipe.steps.filter((s) => s.enabled).length === 0
                  }
                >
                  <Play className="w-3.5 h-3.5 mr-1.5" />
                  {isProcessing ? 'Applying...' : 'Apply to Table'}
                </Button>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleExport}
                      disabled={selectedRecipe.steps.length === 0}
                    >
                      <Download className="w-3.5 h-3.5 mr-1.5" />
                      Export
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Export as JSON</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setShowDeleteDialog(true)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete recipe</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Progress Indicator */}
            {isProcessing && executionProgress && (
              <div className="px-4 py-2 border-b border-border/40 bg-muted/20">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="truncate">{executionProgress.currentStepLabel}</span>
                  <span className="shrink-0">
                    {executionProgress.currentStep}/{executionProgress.totalSteps}
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${(executionProgress.currentStep / executionProgress.totalSteps) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Error Message */}
            {executionError && (
              <div className="px-4 py-2 border-b border-border/40">
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span className="break-words">{executionError}</span>
                </div>
              </div>
            )}

            {/* Steps List */}
            <ScrollArea className="flex-1">
              <div className="p-4">
                {/* Steps Header */}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    Transformation Steps
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddStep}
                  >
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Add Step
                  </Button>
                </div>

                {selectedRecipe.steps.length === 0 ? (
                  <div className="text-center py-12 border-2 border-dashed border-border/40 rounded-lg">
                    <Sparkles className="w-8 h-8 mx-auto text-muted-foreground/40 mb-2" />
                    <p className="text-sm text-muted-foreground mb-3">
                      No steps yet. Add transforms to build your recipe.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAddStep}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1.5" />
                      Add First Step
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedRecipe.steps.map((step, index) => (
                      <RecipeStepCard
                        key={step.id}
                        step={step}
                        index={index}
                        totalSteps={selectedRecipe.steps.length}
                        isHighlighted={step.id === newlyAddedStepId}
                        onMoveUp={() => moveStepUp(index)}
                        onMoveDown={() => moveStepDown(index)}
                        onToggleEnabled={() => toggleStepEnabled(selectedRecipe.id, step.id)}
                        onDelete={() => removeStep(selectedRecipe.id, step.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          /* Empty State */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm">
              <BookOpen className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium mb-2">No Recipe Selected</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Select a recipe from the list or create a new one to get started.
              </p>
              <Button onClick={() => setShowNewRecipeDialog(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create New Recipe
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* New Recipe Dialog */}
      <Dialog open={showNewRecipeDialog} onOpenChange={setShowNewRecipeDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create New Recipe</DialogTitle>
            <DialogDescription>
              Create a recipe template to save and reuse transformation sequences.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="recipe-name">Recipe Name</Label>
            <Input
              id="recipe-name"
              value={newRecipeName}
              onChange={(e) => setNewRecipeName(e.target.value)}
              placeholder="e.g., Email Cleanup"
              className="mt-2"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateRecipe()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewRecipeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateRecipe}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Recipe</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{selectedRecipe?.name}&quot;? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteRecipe}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Column Mapping Dialog */}
      <Dialog open={showMappingDialog} onOpenChange={setShowMappingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Column Mapping</DialogTitle>
            <DialogDescription>
              Some recipe columns don&apos;t match the current table. Please map them.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            {selectedRecipe?.requiredColumns.map((col) => {
              const currentMapping = pendingColumnMapping?.[col] || ''
              const isUnmapped = unmappedColumns.includes(col) && !currentMapping

              return (
                <div key={col} className="flex items-center gap-3">
                  <div className="w-1/3">
                    <span className="text-sm font-medium">{col}</span>
                    {isUnmapped && (
                      <Badge variant="destructive" className="ml-2 text-[10px]">
                        unmapped
                      </Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground">→</span>
                  <Select
                    value={currentMapping}
                    onValueChange={(value) => updateColumnMapping(col, value)}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select column..." />
                    </SelectTrigger>
                    <SelectContent>
                      {tableColumns.map((tc) => (
                        <SelectItem key={tc} value={tc}>
                          {tc}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )
            })}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowMappingDialog(false)
                clearColumnMapping()
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmMapping}>Apply Recipe</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret Input Dialog (from shared hook) */}
      {secretDialogElement}
    </div>
  )
}
