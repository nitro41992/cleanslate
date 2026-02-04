import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Play,
  Plus,
  Trash2,
  Download,
  Upload,
  X,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  Pencil,
  Calendar,
  Columns,
  Maximize2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useRecipeStore, selectSelectedRecipe } from '@/stores/recipeStore'
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useRecipeExecution } from '@/hooks/useRecipeExecution'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { RecipeStep } from '@/types'
import { formatRecipeValue } from '@/lib/recipe/format-helpers'
import {
  getTransformDefinition,
  getStepIcon,
  getStepLabel,
  getReadableStepType,
  getStepColorClasses,
} from '@/lib/recipe/transform-lookup'

/**
 * RecipePanel - Companion panel for the Clean panel
 *
 * This panel is displayed as a secondary panel alongside Clean.
 * It provides:
 * - Recipe selector with inline name/description editing
 * - Recipe metadata display (dates, required columns)
 * - Expandable step list with reordering
 * - Import/Export functionality
 * - Recipe preview summary
 * - Apply recipe button
 */
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

  // Note: Steps are always expanded in minimized panel (removed expandedSteps state)

  // Track newly added steps for highlight animation
  const [newlyAddedStepId, setNewlyAddedStepId] = useState<string | null>(null)
  const prevStepsLengthRef = useRef<number>(0)

  // Metadata visibility
  const [showMetadata, setShowMetadata] = useState(false)

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

  // Format step parameters for display - shows ALL params from transform definition
  const formatStepParams = (step: RecipeStep): React.ReactNode => {
    const transform = getTransformDefinition(step)

    // If no params defined in transform, or params array is empty, use stored params
    if (!transform?.params || transform.params.length === 0) {
      if (!step.params || Object.keys(step.params).length === 0) return null
      return (
        <div className="space-y-1 text-xs overflow-hidden">
          {Object.entries(step.params).map(([key, value]) => {
            const label = key
              .replace(/([A-Z])/g, ' $1')
              .replace(/^./, (s) => s.toUpperCase())
              .trim()
            return (
              <div key={key} className="flex items-start gap-2 min-w-0">
                <span className="text-muted-foreground shrink-0">{label}:</span>
                <span className="text-foreground break-all min-w-0">{formatRecipeValue(value)}</span>
              </div>
            )
          })}
        </div>
      )
    }

    // Show ALL defined params, using stored value or default
    return (
      <div className="space-y-1 text-xs overflow-hidden">
        {transform.params.map((paramDef) => {
          const storedValue = step.params?.[paramDef.name]
          const value = storedValue !== undefined ? storedValue : paramDef.default ?? ''

          return (
            <div key={paramDef.name} className="flex items-start gap-2 min-w-0">
              <span className="text-muted-foreground shrink-0">{paramDef.label}:</span>
              <span className="text-foreground break-all min-w-0">{formatRecipeValue(value)}</span>
            </div>
          )
        })}
      </div>
    )
  }

  // Format date for display
  const formatDate = (date: Date): string => {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

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

    addRecipe({
      name: newRecipeName.trim(),
      description: '',
      version: '1.0',
      requiredColumns: [],
      steps: [],
    })

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

  // Handle expand to full Recipe panel view
  const handleExpandToRecipePanel = () => {
    setActivePanel('recipe')
    setSecondaryPanel(null)
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Header: Recipe selector with expand toggle */}
      <div className="p-3 shrink-0">
        <div className="flex items-center gap-2">
          {recipes.length > 0 ? (
            <Select
              value={selectedRecipeId || ''}
              onValueChange={(id) => setSelectedRecipe(id || null)}
            >
              <SelectTrigger className="h-8 text-sm bg-muted/30 border-border/50 flex-1">
                <SelectValue placeholder="Select recipe..." />
              </SelectTrigger>
              <SelectContent>
                {recipes.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({r.steps.length} steps)
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-1 flex-1">
              No recipes yet
            </p>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={handleExpandToRecipePanel}
              >
                <Maximize2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Expand to full Recipe view</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Recipe Details & Steps */}
      <ScrollArea className="flex-1 min-h-0 w-full [&>div>div]:!block">
        <div className="p-3 space-y-3 w-full overflow-hidden">
          {selectedRecipe ? (
            <>
              {/* Recipe Name (editable) */}
              <div>
                {editingName ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={tempName}
                      onChange={(e) => setTempName(e.target.value)}
                      className="h-7 text-sm font-medium"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveNameEdit()
                        if (e.key === 'Escape') setEditingName(false)
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={saveNameEdit}
                    >
                      <Check className="w-3 h-3" />
                    </Button>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-1 group cursor-pointer"
                    onClick={startEditingName}
                  >
                    <span className="text-sm font-medium">{selectedRecipe.name}</span>
                    <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                )}
              </div>

              {/* Recipe Description (editable) */}
              <div>
                {editingDescription ? (
                  <div className="space-y-1">
                    <Textarea
                      value={tempDescription}
                      onChange={(e) => setTempDescription(e.target.value)}
                      className="text-xs min-h-[60px]"
                      placeholder="Add a description..."
                      autoFocus
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={saveDescriptionEdit}
                    >
                      Done
                    </Button>
                  </div>
                ) : (
                  <p
                    className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                    onClick={startEditingDescription}
                  >
                    {selectedRecipe.description || 'Add a description...'}
                  </p>
                )}
              </div>

              {/* Metadata Toggle */}
              <Collapsible open={showMetadata} onOpenChange={setShowMetadata}>
                <CollapsibleTrigger asChild>
                  <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {showMetadata ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    Metadata
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Calendar className="w-3 h-3" />
                    <span>Created: {formatDate(selectedRecipe.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Calendar className="w-3 h-3" />
                    <span>Modified: {formatDate(selectedRecipe.modifiedAt)}</span>
                  </div>
                  {selectedRecipe.requiredColumns.length > 0 && (
                    <div className="flex items-start gap-2 text-xs">
                      <Columns className="w-3 h-3 mt-0.5 text-muted-foreground shrink-0" />
                      <div className="flex flex-wrap gap-1">
                        {selectedRecipe.requiredColumns.map((col) => (
                          <Badge key={col} variant="secondary" className="text-[10px] px-1 py-0">
                            {col}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Version: {selectedRecipe.version}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Steps Header */}
              <div className="flex items-center justify-between pt-2 border-t border-border/30 mt-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Steps ({selectedRecipe.steps.filter((s) => s.enabled).length}/{selectedRecipe.steps.length} enabled)
                </p>
              </div>

              {/* Steps List */}
              {selectedRecipe.steps.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  Use &quot;Add to Recipe&quot; in the transform form to add steps
                </p>
              ) : (
                <div className="space-y-3 w-full max-w-full">
                  {selectedRecipe.steps.map((step, index) => {
                    const isNewlyAdded = step.id === newlyAddedStepId
                    const colors = getStepColorClasses(step)
                    const isFirst = index === 0
                    const isLast = index === selectedRecipe.steps.length - 1

                    return (
                      <div key={step.id} className="relative">
                        {/* Pipeline connector from previous step */}
                        {!isFirst && (
                          <div className="absolute left-3 -top-2 w-0.5 h-2 bg-border" />
                        )}

                        {/* Main card */}
                        <div
                          className={cn(
                            'relative rounded-lg border transition-all duration-300 w-full max-w-full overflow-hidden',
                            step.enabled
                              ? 'bg-card border-border/50'
                              : 'bg-muted/20 border-border/20 opacity-60',
                            isNewlyAdded && 'ring-2 ring-primary/60 ring-offset-1 ring-offset-background animate-in fade-in slide-in-from-bottom-2 duration-300'
                          )}
                        >
                          {/* Step indicator dot */}
                          <div
                            className={cn(
                              'absolute left-3 top-3 w-1.5 h-1.5 rounded-full',
                              step.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
                            )}
                          />

                          {/* Step Header */}
                          <div className="flex items-start gap-1.5 pl-6 pr-2 py-2">
                            {/* Icon container - matches transform picker */}
                            <div
                              className={cn(
                                'w-6 h-6 rounded-md flex items-center justify-center shrink-0',
                                colors.iconBg
                              )}
                            >
                              <span className="text-sm">{getStepIcon(step)}</span>
                            </div>

                            {/* Label with nested column */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-muted-foreground tabular-nums">
                                  {index + 1}.
                                </span>
                                <span className="font-medium text-xs leading-tight">
                                  {getStepLabel(step)}
                                </span>
                              </div>
                              {step.column && (
                                <div className="text-xs text-muted-foreground pl-3 flex items-center gap-1">
                                  <span className="text-muted-foreground/60">↳</span>
                                  <span className="truncate">{step.column}</span>
                                </div>
                              )}
                            </div>

                            {/* Compact action buttons */}
                            <div className="flex items-center shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 hover:bg-muted/50"
                                onClick={() => moveStepUp(index)}
                                disabled={index === 0}
                              >
                                <ChevronUp className="w-3 h-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 hover:bg-muted/50"
                                onClick={() => moveStepDown(index)}
                                disabled={index === selectedRecipe.steps.length - 1}
                              >
                                <ChevronDown className="w-3 h-3" />
                              </Button>
                            </div>

                            {/* Enable Toggle */}
                            <Switch
                              checked={step.enabled}
                              onCheckedChange={() => toggleStepEnabled(selectedRecipe.id, step.id)}
                              className="scale-75 shrink-0"
                            />
                          </div>

                          {/* Always Expanded Details */}
                          <div className="pl-6 pr-3 pb-2 pt-1.5 border-t border-border/30 space-y-2 overflow-hidden">
                            <div className="flex items-start gap-2 text-xs min-w-0">
                              <span className="text-muted-foreground shrink-0">Type:</span>
                              <span className="text-foreground/80">
                                {getReadableStepType(step)}
                              </span>
                            </div>
                            {(() => {
                              const paramsContent = formatStepParams(step)
                              if (!paramsContent) return null
                              return (
                                <div className="pt-1.5 border-t border-border/30 overflow-hidden">
                                  {paramsContent}
                                </div>
                              )
                            })()}
                            {/* Delete action */}
                            <div className="pt-1.5 border-t border-border/30">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs text-muted-foreground hover:text-destructive"
                                onClick={() => removeStep(selectedRecipe.id, step.id)}
                              >
                                <X className="w-3 h-3 mr-1" />
                                Remove step
                              </Button>
                            </div>
                          </div>
                        </div>

                        {/* Pipeline connector to next step */}
                        {!isLast && (
                          <div className="absolute left-3 -bottom-2 w-0.5 h-2 bg-border" />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : recipes.length > 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              Select a recipe above
            </p>
          ) : (
            <div className="text-center py-6 space-y-3">
              <p className="text-xs text-muted-foreground">
                Create a recipe to save transformation steps
              </p>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setShowNewRecipeDialog(true)}
              >
                <Plus className="w-3 h-3 mr-1" />
                New Recipe
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Progress Indicator */}
      {isProcessing && executionProgress && (
        <div className="px-3 py-2 border-t border-border/30 bg-muted/20">
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
        <div className="px-3 py-2 border-t border-border/30">
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
            <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
            <span className="break-words">{executionError}</span>
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div className="p-3 border-t border-border/40 space-y-2 shrink-0">
        {/* Action buttons row */}
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={handleApplyRecipe}
            disabled={
              isProcessing ||
              !selectedRecipe ||
              !activeTableId ||
              selectedRecipe.steps.filter((s) => s.enabled).length === 0
            }
          >
            <Play className="w-4 h-4 mr-2" />
            {isProcessing ? 'Applying...' : 'Apply'}
          </Button>

          <Button
            variant="outline"
            className="flex-1"
            onClick={() => setShowNewRecipeDialog(true)}
          >
            <Plus className="w-4 h-4 mr-2" />
            New Recipe
          </Button>
        </div>

        {/* Secondary actions row */}
        <div className="flex items-center justify-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleImport}>
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
                onClick={handleExport}
                disabled={!selectedRecipe || selectedRecipe.steps.length === 0}
              >
                <Download className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export recipe</TooltipContent>
          </Tooltip>

          {selectedRecipe && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => setShowDeleteDialog(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete recipe</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* New Recipe Dialog */}
      <Dialog open={showNewRecipeDialog} onOpenChange={setShowNewRecipeDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create New Recipe</DialogTitle>
            <DialogDescription>
              Give your recipe a name. You can add steps from the Clean panel.
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
