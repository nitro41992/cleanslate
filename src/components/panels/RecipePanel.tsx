import { useState, useMemo } from 'react'
import {
  Play,
  Plus,
  Trash2,
  Download,
  Upload,
  Copy,
  GripVertical,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Check,
  X,
  Wand2,
  History,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { useRecipeStore, selectSelectedRecipe, type ColumnMapping } from '@/stores/recipeStore'
import { useTableStore } from '@/stores/tableStore'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Recipe, RecipeStep } from '@/types'
import { RecipeStepBuilder } from './RecipeStepBuilder'
import { getStepApplicationStatus, type StepApplicationStatus } from '@/lib/recipe/step-status'

export function RecipePanel() {
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
  const duplicateRecipe = useRecipeStore((s) => s.duplicateRecipe)
  const toggleStepEnabled = useRecipeStore((s) => s.toggleStepEnabled)
  const removeStep = useRecipeStore((s) => s.removeStep)
  const setColumnMapping = useRecipeStore((s) => s.setColumnMapping)
  const updateColumnMapping = useRecipeStore((s) => s.updateColumnMapping)
  const clearColumnMapping = useRecipeStore((s) => s.clearColumnMapping)
  const setIsProcessing = useRecipeStore((s) => s.setIsProcessing)
  const setExecutionProgress = useRecipeStore((s) => s.setExecutionProgress)
  const setExecutionError = useRecipeStore((s) => s.setExecutionError)

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const activeTable = tables.find((t) => t.id === activeTableId)

  // Local state for dialogs
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showMappingDialog, setShowMappingDialog] = useState(false)
  const [newRecipeName, setNewRecipeName] = useState('')
  const [newRecipeDescription, setNewRecipeDescription] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)

  // Expanded step state
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())

  // Show step builder when building from scratch
  const [showStepBuilder, setShowStepBuilder] = useState(false)

  // Get table columns for mapping
  const tableColumns = useMemo(() => {
    if (!activeTable) return []
    return activeTable.columns
      .filter((c) => !c.name.startsWith('_cs_') && !c.name.startsWith('__'))
      .map((c) => c.name)
  }, [activeTable])

  // Handle recipe selection
  const handleSelectRecipe = (id: string) => {
    setSelectedRecipe(id === selectedRecipeId ? null : id)
  }

  // Handle create new recipe
  const handleCreateRecipe = () => {
    setNewRecipeName('')
    setNewRecipeDescription('')
    setShowSaveDialog(true)
  }

  // Handle save new recipe
  const handleSaveNewRecipe = () => {
    if (!newRecipeName.trim()) {
      toast.error('Please enter a recipe name')
      return
    }

    addRecipe({
      name: newRecipeName.trim(),
      description: newRecipeDescription.trim(),
      version: '1.0',
      requiredColumns: [],
      steps: [],
    })

    setShowSaveDialog(false)
    toast.success('Recipe created')
  }

  // Handle delete recipe
  const handleDeleteRecipe = () => {
    if (!selectedRecipeId) return
    deleteRecipe(selectedRecipeId)
    setShowDeleteDialog(false)
    toast.success('Recipe deleted')
  }

  // Handle duplicate recipe
  const handleDuplicateRecipe = () => {
    if (!selectedRecipeId) return
    const newId = duplicateRecipe(selectedRecipeId)
    if (newId) {
      toast.success('Recipe duplicated')
    }
  }

  // Handle export recipe to JSON
  const handleExportRecipe = () => {
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
  const handleImportRecipe = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        const data = JSON.parse(text)

        // Validate required fields
        if (!data.name || !Array.isArray(data.steps)) {
          throw new Error('Invalid recipe format')
        }

        addRecipe({
          name: data.name,
          description: data.description || '',
          version: data.version || '1.0',
          requiredColumns: data.requiredColumns || [],
          steps: data.steps.map((s: RecipeStep) => ({
            ...s,
            enabled: s.enabled !== false,
          })),
        })

        toast.success(`Recipe "${data.name}" imported`)
      } catch (err) {
        console.error('Failed to import recipe:', err)
        toast.error('Failed to import recipe')
      }
    }
    input.click()
  }

  // Handle apply recipe
  const handleApplyRecipe = async () => {
    if (!selectedRecipe || !activeTableId || !activeTable) {
      toast.error('Please select a table first')
      return
    }

    const enabledSteps = selectedRecipe.steps.filter((s) => s.enabled)
    if (enabledSteps.length === 0) {
      toast.error('Recipe has no enabled steps')
      return
    }

    // Check column mapping
    const { matchColumns } = await import('@/lib/recipe/column-matcher')
    const matchResult = matchColumns(selectedRecipe.requiredColumns, tableColumns)

    if (matchResult.unmapped.length > 0) {
      // Show mapping dialog
      const initialMapping: ColumnMapping = {}
      for (const col of selectedRecipe.requiredColumns) {
        initialMapping[col] = matchResult.mapping[col] || ''
      }
      setColumnMapping(initialMapping)
      useRecipeStore.getState().setUnmappedColumns(matchResult.unmapped)
      setShowMappingDialog(true)
      return
    }

    // All columns matched - apply recipe
    await executeRecipe(selectedRecipe, matchResult.mapping)
  }

  // Execute recipe with mapping
  const executeRecipe = async (recipe: Recipe, mapping: ColumnMapping) => {
    if (!activeTableId || !activeTable) return

    setIsProcessing(true)
    setExecutionError(null)

    try {
      const { executeRecipe: doExecute } = await import('@/lib/recipe/recipe-executor')
      await doExecute(recipe, activeTableId, activeTable.name, mapping, (progress) => {
        setExecutionProgress(progress)
      })

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
  }

  // Handle confirm column mapping
  const handleConfirmMapping = async () => {
    if (!selectedRecipe || !pendingColumnMapping) return

    // Check all columns are mapped
    const stillUnmapped = unmappedColumns.filter((col) => !pendingColumnMapping[col])
    if (stillUnmapped.length > 0) {
      toast.error(`Please map all columns: ${stillUnmapped.join(', ')}`)
      return
    }

    setShowMappingDialog(false)
    await executeRecipe(selectedRecipe, pendingColumnMapping)
  }

  // Toggle step expansion
  const toggleStepExpanded = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepId)) {
        next.delete(stepId)
      } else {
        next.add(stepId)
      }
      return next
    })
  }

  // Format step label
  const formatStepLabel = (step: RecipeStep) => {
    const type = step.type.replace(/^(transform|scrub|standardize):/, '')
    if (step.column) {
      return `${type} → ${step.column}`
    }
    return type
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Recipe List Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-muted-foreground">MY RECIPES</h3>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleImportRecipe}>
                      <Upload className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Import recipe</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCreateRecipe}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create new recipe</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {recipes.length === 0 ? (
              <div className="space-y-3 py-4">
                {/* Primary CTA: Build from Scratch */}
                <Button
                  variant="default"
                  size="lg"
                  className="w-full h-12"
                  onClick={handleCreateRecipe}
                >
                  <Wand2 className="w-4 h-4 mr-2" />
                  Build New Recipe
                </Button>

                {/* Secondary CTA: Import from History */}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleImportRecipe}
                >
                  <History className="w-4 h-4 mr-2" />
                  Import from File
                </Button>

                <p className="text-xs text-center text-muted-foreground pt-2">
                  Or export transforms from the Audit Log
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {recipes.map((recipe) => (
                  <div
                    key={recipe.id}
                    className={cn(
                      'flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors',
                      selectedRecipeId === recipe.id
                        ? 'bg-primary/10 border border-primary/30'
                        : 'hover:bg-muted/50'
                    )}
                    onClick={() => handleSelectRecipe(recipe.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{recipe.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {recipe.steps.length} step{recipe.steps.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleDuplicateRecipe()}>
                          <Copy className="w-4 h-4 mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleExportRecipe()}>
                          <Download className="w-4 h-4 mr-2" />
                          Export JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setSelectedRecipe(recipe.id)
                            setShowDeleteDialog(true)
                          }}
                          className="text-destructive"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selected Recipe Details */}
          {selectedRecipe && (
            <>
              <Separator />

              <div className="space-y-3">
                {/* Recipe Name */}
                <div>
                  <Label className="text-xs text-muted-foreground">Name</Label>
                  {editingName ? (
                    <div className="flex items-center gap-1 mt-1">
                      <Input
                        value={selectedRecipe.name}
                        onChange={(e) => updateRecipe(selectedRecipe.id, { name: e.target.value })}
                        className="h-8"
                        autoFocus
                      />
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditingName(false)}>
                        <Check className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <p
                      className="text-sm cursor-pointer hover:text-primary mt-1"
                      onClick={() => setEditingName(true)}
                    >
                      {selectedRecipe.name}
                    </p>
                  )}
                </div>

                {/* Recipe Description */}
                <div>
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  {editingDescription ? (
                    <div className="mt-1">
                      <Textarea
                        value={selectedRecipe.description}
                        onChange={(e) => updateRecipe(selectedRecipe.id, { description: e.target.value })}
                        className="min-h-[60px] text-sm"
                        autoFocus
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1"
                        onClick={() => setEditingDescription(false)}
                      >
                        Done
                      </Button>
                    </div>
                  ) : (
                    <p
                      className="text-sm text-muted-foreground cursor-pointer hover:text-foreground mt-1"
                      onClick={() => setEditingDescription(true)}
                    >
                      {selectedRecipe.description || 'Click to add description...'}
                    </p>
                  )}
                </div>

                {/* Required Columns */}
                {selectedRecipe.requiredColumns.length > 0 && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Required Columns</Label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {selectedRecipe.requiredColumns.map((col) => (
                        <Badge key={col} variant="secondary" className="text-xs">
                          {col}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Steps */}
                <div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      STEPS ({selectedRecipe.steps.filter((s) => s.enabled).length} enabled)
                    </Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() => setShowStepBuilder(!showStepBuilder)}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Step
                    </Button>
                  </div>

                  {/* Step Builder */}
                  {showStepBuilder && (
                    <div className="mt-2">
                      <RecipeStepBuilder
                        recipeId={selectedRecipe.id}
                        tableColumns={tableColumns}
                        onStepAdded={() => setShowStepBuilder(false)}
                      />
                    </div>
                  )}

                  {selectedRecipe.steps.length === 0 && !showStepBuilder ? (
                    <p className="text-sm text-muted-foreground mt-2">
                      No steps yet. Click "Add Step" above to build your recipe.
                    </p>
                  ) : (
                    <div className="space-y-1 mt-2">
                      {selectedRecipe.steps.map((step, index) => {
                        // Get step application status if we have an active table
                        const status: StepApplicationStatus = activeTableId
                          ? getStepApplicationStatus(step, activeTableId, pendingColumnMapping || {})
                          : 'not_applied'

                        return (
                          <div
                            key={step.id}
                            className={cn(
                              'border rounded-lg transition-colors',
                              step.enabled ? 'border-border' : 'border-border/50 opacity-60',
                              status === 'already_applied' && 'border-emerald-500/40 bg-emerald-500/5',
                              status === 'modified_since' && 'border-amber-500/40 bg-amber-500/5'
                            )}
                          >
                            <div
                              className="flex items-center gap-2 p-2 cursor-pointer"
                              onClick={() => toggleStepExpanded(step.id)}
                            >
                              <GripVertical className="w-4 h-4 text-muted-foreground cursor-grab" />
                              <span className="text-xs text-muted-foreground w-5">{index + 1}.</span>
                              {expandedSteps.has(step.id) ? (
                                <ChevronDown className="w-4 h-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-muted-foreground" />
                              )}
                              <span className="text-sm flex-1 truncate">{formatStepLabel(step)}</span>

                              {/* Status indicator */}
                              {status === 'already_applied' && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="outline" className="text-emerald-500 border-emerald-500/50 text-[10px] px-1.5">
                                      <Check className="w-2.5 h-2.5 mr-0.5" />
                                      Applied
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>Already applied to current table</TooltipContent>
                                </Tooltip>
                              )}
                              {status === 'modified_since' && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="outline" className="text-amber-500 border-amber-500/50 text-[10px] px-1.5">
                                      <AlertCircle className="w-2.5 h-2.5 mr-0.5" />
                                      Modified
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>Applied, but column was modified since</TooltipContent>
                                </Tooltip>
                              )}

                              <Switch
                                checked={step.enabled}
                                onCheckedChange={() => toggleStepEnabled(selectedRecipe.id, step.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeStep(selectedRecipe.id, step.id)
                                }}
                              >
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                            {expandedSteps.has(step.id) && (
                              <div className="px-4 pb-2 pt-1 border-t border-border/50">
                                <p className="text-xs text-muted-foreground">Type: {step.type}</p>
                                {step.column && (
                                  <p className="text-xs text-muted-foreground">Column: {step.column}</p>
                                )}
                                {step.params && Object.keys(step.params).length > 0 && (
                                  <div className="mt-1">
                                    <p className="text-xs text-muted-foreground">Parameters:</p>
                                    <pre className="text-xs bg-muted/50 p-1 rounded mt-0.5 overflow-x-auto">
                                      {JSON.stringify(step.params, null, 2)}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      {/* Footer Actions */}
      {selectedRecipe && (
        <div className="p-4 border-t border-border/50 space-y-2">
          {/* Progress Indicator */}
          {isProcessing && executionProgress && (
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <span>{executionProgress.currentStepLabel}</span>
                <span>
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
            <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
              {executionError}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExportRecipe}>
              <Download className="w-4 h-4 mr-2" />
              Export JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDeleteDialog(true)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </Button>
            <div className="flex-1" />
            <Button
              onClick={handleApplyRecipe}
              disabled={isProcessing || !activeTableId || selectedRecipe.steps.length === 0}
            >
              <Play className="w-4 h-4 mr-2" />
              {isProcessing ? 'Applying...' : 'Apply to Table'}
            </Button>
          </div>
        </div>
      )}

      {/* Create Recipe Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Recipe</DialogTitle>
            <DialogDescription>Give your recipe a name and optional description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="recipe-name">Name</Label>
              <Input
                id="recipe-name"
                value={newRecipeName}
                onChange={(e) => setNewRecipeName(e.target.value)}
                placeholder="e.g., Email Cleanup"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="recipe-description">Description (optional)</Label>
              <Textarea
                id="recipe-description"
                value={newRecipeDescription}
                onChange={(e) => setNewRecipeDescription(e.target.value)}
                placeholder="What does this recipe do?"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveNewRecipe}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Recipe</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{selectedRecipe?.name}"? This cannot be undone.
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
              Some recipe columns don't match the current table. Please map them.
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
    </div>
  )
}
