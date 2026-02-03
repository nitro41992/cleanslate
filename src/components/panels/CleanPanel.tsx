import { useState, useRef, useEffect, useCallback } from 'react'
import { Loader2, Sparkles, AlertTriangle, BookOpen, ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { ColumnCombobox } from '@/components/ui/combobox'
import { MultiColumnCombobox } from '@/components/ui/multi-column-combobox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TransformPreview, type PreviewState } from '@/components/clean/TransformPreview'
import { ValidationMessage } from '@/components/clean/ValidationMessage'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTableStore } from '@/stores/tableStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useRecipeStore } from '@/stores/recipeStore'
import { toast } from 'sonner'
import type { RecipeStep } from '@/types'
import {
  TransformationDefinition,
  validateCastType,
  CastTypeValidation,
} from '@/lib/transformations'
import {
  GroupedTransformationPicker,
  type GroupedTransformationPickerRef,
} from '@/components/clean/GroupedTransformationPicker'
import { initializeTimeline } from '@/lib/timeline-engine'
import {
  createCommand,
  getCommandTypeFromTransform,
  getCommandLabel,
  type ExecutorProgress,
} from '@/lib/commands'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import { useSemanticValidation } from '@/hooks/useSemanticValidation'
import { PrivacySubPanel } from '@/components/clean/PrivacySubPanel'

export function CleanPanel() {
  const [isApplying, setIsApplying] = useState(false)
  const [selectedTransform, setSelectedTransform] = useState<TransformationDefinition | null>(null)
  const [selectedColumn, setSelectedColumn] = useState<string>('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [lastApplied, setLastApplied] = useState<string | null>(null)
  // Cast type validation warning state
  const [castWarningOpen, setCastWarningOpen] = useState(false)
  const [castValidation, setCastValidation] = useState<CastTypeValidation | null>(null)
  // Execution progress state for batched operations
  const [executionProgress, setExecutionProgress] = useState<ExecutorProgress | null>(null)
  // Live preview state for validation (disable Apply if no matching rows)
  const [previewState, setPreviewState] = useState<PreviewState | null>(null)

  // New recipe dialog state
  const [showNewRecipeDialog, setShowNewRecipeDialog] = useState(false)
  const [newRecipeName, setNewRecipeName] = useState('')
  const [pendingStep, setPendingStep] = useState<Omit<RecipeStep, 'id'> | null>(null)

  // Keyboard navigation state
  const [columnComboboxOpen, setColumnComboboxOpen] = useState(false)
  const [multiColumnComboboxOpen, setMultiColumnComboboxOpen] = useState(false)
  const pickerRef = useRef<GroupedTransformationPickerRef>(null)
  const applyButtonRef = useRef<HTMLButtonElement>(null)
  // Use a more flexible approach for first param - store the element directly
  const firstParamElementRef = useRef<HTMLElement | null>(null)

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const activeTable = tables.find((t) => t.id === activeTableId)
  const timeline = useTimelineStore((s) => activeTableId ? s.getTimeline(activeTableId) : undefined)
  const setSecondaryPanel = usePreviewStore((s) => s.setSecondaryPanel)
  const secondaryPanel = usePreviewStore((s) => s.secondaryPanel)

  // Recipe store access
  const recipes = useRecipeStore((s) => s.recipes)
  const addRecipe = useRecipeStore((s) => s.addRecipe)
  const addStep = useRecipeStore((s) => s.addStep)
  const setSelectedRecipe = useRecipeStore((s) => s.setSelectedRecipe)

  const columns = activeTable?.columns.map((c) => c.name) || []
  // Count active timeline commands (not undone)
  const activeCommandCount = timeline
    ? timeline.commands.slice(0, timeline.currentPosition + 1).length
    : 0

  // Live semantic validation for transform operations
  const validationResult = useSemanticValidation(
    activeTable?.name,
    selectedTransform?.id,
    selectedColumn,
    params
  )

  const handleSelectTransform = useCallback((transform: TransformationDefinition) => {
    setSelectedTransform(transform)
    setSelectedColumn('')
    setLastApplied(null)
    setPreviewState(null)
    // Pre-populate params with defaults
    const defaultParams: Record<string, string> = {}
    transform.params?.forEach((param) => {
      if (param.default) {
        defaultParams[param.name] = param.default
      }
    })
    setParams(defaultParams)

    // Privacy batch uses its own sub-panel, no need for further focus management
    if (transform.id === 'privacy_batch') {
      return
    }

    // Auto-open column combobox if transform requires column
    if (transform.requiresColumn) {
      // Small delay to let the UI render
      setTimeout(() => setColumnComboboxOpen(true), 50)
    } else if (transform.id === 'combine_columns') {
      // Auto-open multi-column combobox for combine_columns
      setTimeout(() => setMultiColumnComboboxOpen(true), 50)
    } else if (transform.params && transform.params.length > 0) {
      // Focus first param input
      setTimeout(() => firstParamElementRef.current?.focus(), 50)
    } else {
      // No column or params needed - focus apply button
      setTimeout(() => applyButtonRef.current?.focus(), 50)
    }
  }, [])

  // Handle column selection - auto-advance to next step
  const handleColumnChange = useCallback((value: string) => {
    setSelectedColumn(value)
    setColumnComboboxOpen(false)

    // After column is selected, focus first param or apply button
    if (selectedTransform?.params && selectedTransform.params.length > 0) {
      setTimeout(() => firstParamElementRef.current?.focus(), 50)
    } else {
      setTimeout(() => applyButtonRef.current?.focus(), 50)
    }
  }, [selectedTransform])

  // Handle picker navigation to column combobox
  const handlePickerNavigateNext = useCallback(() => {
    if (selectedTransform?.requiresColumn) {
      setColumnComboboxOpen(true)
    } else if (selectedTransform?.params && selectedTransform.params.length > 0) {
      firstParamElementRef.current?.focus()
    } else {
      applyButtonRef.current?.focus()
    }
  }, [selectedTransform])

  // Focus picker when panel first renders with a table
  useEffect(() => {
    if (activeTable && !selectedTransform && !isApplying) {
      // Small delay to ensure picker is mounted
      const timer = setTimeout(() => {
        pickerRef.current?.focus()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [activeTable, selectedTransform, isApplying])

  const resetForm = () => {
    setSelectedTransform(null)
    setSelectedColumn('')
    setParams({})
    setLastApplied(null)
    setPreviewState(null)
  }

  const isValid = () => {
    if (!selectedTransform) return false
    if (selectedTransform.requiresColumn && !selectedColumn) return false
    if (selectedTransform.params) {
      for (const param of selectedTransform.params) {
        // Params are required by default, unless explicitly marked required: false
        if (param.required !== false && !params[param.name]) return false
      }
    }

    // Semantic validation: block no-op and invalid transforms
    if (validationResult.status === 'no_op' || validationResult.status === 'invalid') {
      return false
    }

    // Live preview validation: block if preview shows no matching rows
    // Only check when preview is ready and not loading (to avoid blocking during debounce)
    if (previewState?.isReady && !previewState.isLoading && !previewState.hasError) {
      if (previewState.totalMatching === 0) {
        return false
      }
    }

    return true
  }

  // Separate function to execute the transformation (called directly or after warning confirmation)
  const executeTransformation = async () => {
    if (!activeTable || !selectedTransform) return

    setIsApplying(true)

    try {
      // 1. Initialize timeline BEFORE transform (captures pre-state snapshot for diff comparison)
      await initializeTimeline(activeTable.id, activeTable.name)

      // 2. Get command type from transformation ID
      const commandType = getCommandTypeFromTransform(selectedTransform.id)
      if (!commandType) {
        throw new Error(`Unknown transformation type: ${selectedTransform.id}`)
      }

      // 3. Build command params
      const commandParams = {
        tableId: activeTable.id,
        column: selectedTransform.requiresColumn ? selectedColumn : undefined,
        ...params, // Spread additional params (find, replace, delimiter, etc.)
      }

      // 4. Create and execute command with confirmation if discarding redo states
      const command = createCommand(commandType, commandParams)
      const result = await executeWithConfirmation(command, activeTable.id, {
        onProgress: (progress: ExecutorProgress) => {
          console.log(`[Command] ${progress.phase}: ${progress.progress}%`)
          setExecutionProgress(progress)
        },
      })

      // User cancelled the confirmation dialog
      if (!result) {
        return
      }

      // 5. Handle validation errors
      if (!result.success && result.validationResult) {
        const errors = result.validationResult.errors.map((e) => e.message).join(', ')
        toast.error('Validation Failed', { description: errors })
        return
      }

      // 6. Handle execution errors
      if (!result.success) {
        throw new Error(result.error || 'Transformation failed')
      }

      // 7. Show success, mark last applied
      // Executor handles: audit logging, timeline recording, store updates
      const affected = result.executionResult?.affected ?? 0
      setLastApplied(selectedTransform.id)
      toast.success('Transformation Applied', {
        description: `${getCommandLabel(commandType)} completed. ${affected} rows affected.`,
      })

      // 8. Reset form after delay
      setTimeout(() => {
        resetForm()
      }, 1500)
    } catch (error) {
      console.error('Transformation failed:', error)
      toast.error('Transformation Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsApplying(false)
      setExecutionProgress(null)
    }
  }

  const handleApply = async () => {
    if (!activeTable || !selectedTransform) return

    // Pre-validation for cast_type - warn if ANY values would become NULL
    if (selectedTransform.id === 'cast_type' && selectedColumn) {
      const targetType = params.targetType || 'VARCHAR'

      setIsApplying(true)
      try {
        const validation = await validateCastType(
          activeTable.name,
          selectedColumn,
          targetType
        )

        if (validation.failCount > 0) {
          // Show warning dialog
          setCastValidation(validation)
          setCastWarningOpen(true)
          setIsApplying(false)
          return
        }
      } catch (error) {
        console.error('Cast type validation failed:', error)
        // If validation fails, proceed anyway (don't block on validation errors)
      }
      setIsApplying(false)
    }

    // Execute the transformation
    await executeTransformation()
  }

  // Handler for confirming cast type despite warnings
  const handleConfirmCastType = async () => {
    setCastWarningOpen(false)
    await executeTransformation()
  }

  const handleCancelCastType = () => {
    setCastWarningOpen(false)
    setCastValidation(null)
  }

  // Get target type label for display
  const getTargetTypeLabel = (type: string) => {
    const typeMap: Record<string, string> = {
      'VARCHAR': 'Text',
      'INTEGER': 'Integer',
      'DOUBLE': 'Decimal',
      'DATE': 'Date',
      'BOOLEAN': 'Boolean',
    }
    return typeMap[type] || type
  }

  // Build a recipe step from the current form state
  const buildStepFromCurrentForm = (): Omit<RecipeStep, 'id'> | null => {
    if (!selectedTransform) return null

    // Build step params from current form state
    // IMPORTANT: Store ALL parameters including empty strings to preserve user intent
    const stepParams: Record<string, unknown> = {}
    if (selectedTransform.params) {
      for (const param of selectedTransform.params) {
        const value = params[param.name]

        // Include the parameter if:
        // 1. It has a non-empty value, OR
        // 2. It has an explicit empty string (user cleared it), OR
        // 3. It differs from the default (including when value is '' and default is undefined)
        const hasValue = value !== undefined && value !== ''
        const hasExplicitEmpty = value === '' && param.required === false
        const differsFromDefault = value !== undefined && value !== param.default

        if (hasValue || hasExplicitEmpty || differsFromDefault) {
          if (param.type === 'number') {
            stepParams[param.name] = parseInt(value, 10)
          } else if (param.name === 'columns') {
            stepParams[param.name] = value.split(',').map((c: string) => c.trim())
          } else {
            stepParams[param.name] = value
          }
        }
      }
    }

    // Determine command type prefix
    let typePrefix = 'transform'
    if (['hash', 'mask', 'redact', 'year_only'].includes(selectedTransform.id)) {
      typePrefix = 'scrub'
    }

    return {
      type: `${typePrefix}:${selectedTransform.id}`,
      label: `${selectedTransform.label}${selectedColumn ? ` → ${selectedColumn}` : ''}`,
      column: selectedTransform.requiresColumn ? selectedColumn : undefined,
      params: Object.keys(stepParams).length > 0 ? stepParams : undefined,
      enabled: true,
    }
  }

  // Handle "Add to New Recipe" action
  const handleAddToNewRecipe = () => {
    const step = buildStepFromCurrentForm()
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
      requiredColumns: [],
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
      description: `Added ${selectedTransform?.label} to "${newRecipeName.trim()}"`,
    })
  }

  // Handle "Add to Existing Recipe" action
  const handleAddToExistingRecipe = (recipeId: string) => {
    const step = buildStepFromCurrentForm()
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
      description: `Added ${selectedTransform?.label} to "${recipe?.name}"`,
    })
  }

  // Check if the current form state is valid for adding to a recipe
  // Uses the same validation logic as isValid() for UX parity
  const canAddToRecipe = () => {
    if (!selectedTransform) return false
    if (selectedTransform.requiresColumn && !selectedColumn) return false
    if (selectedTransform.params) {
      for (const param of selectedTransform.params) {
        if (param.required !== false && !params[param.name]) return false
      }
    }

    // Semantic validation: block no-op and invalid transforms
    if (validationResult.status === 'no_op' || validationResult.status === 'invalid') {
      return false
    }

    // Live preview validation: block if preview shows no matching rows
    // Only check when preview is ready and not loading (to avoid blocking during debounce)
    if (previewState?.isReady && !previewState.isLoading && !previewState.hasError) {
      if (previewState.totalMatching === 0) {
        return false
      }
    }

    return true
  }

  return (
    <>
      {/* Cast Type Warning Dialog */}
      <AlertDialog open={castWarningOpen} onOpenChange={setCastWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              Cast Type Warning
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Converting <strong>&quot;{selectedColumn}&quot;</strong> to{' '}
                  <strong>{getTargetTypeLabel(params.targetType || 'VARCHAR')}</strong>{' '}
                  will result in NULL values for{' '}
                  <strong className="text-destructive">
                    {castValidation?.failCount.toLocaleString()}
                  </strong>{' '}
                  out of {castValidation?.totalRows.toLocaleString()} rows (
                  {castValidation?.failurePercentage.toFixed(1)}%).
                </p>
                {castValidation && castValidation.sampleFailures.length > 0 && (
                  <div>
                    <p className="font-medium text-foreground mb-1">
                      Sample values that cannot be converted:
                    </p>
                    <ul className="list-disc list-inside text-sm space-y-0.5">
                      {castValidation.sampleFailures.map((val, i) => (
                        <li key={i} className="text-muted-foreground">
                          &quot;{val}&quot;
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelCastType}>
              Cancel
            </AlertDialogCancel>
            {/* Using Button instead of AlertDialogAction to prevent race condition.
                AlertDialogAction auto-closes the dialog, which can trigger onOpenChange(false)
                before handleConfirmCastType completes. */}
            <Button
              onClick={handleConfirmCastType}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Apply Anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />

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

      {/* Privacy Sub-Panel - takes over the entire panel when privacy_batch is selected */}
      {selectedTransform?.id === 'privacy_batch' ? (
        <PrivacySubPanel
          onCancel={resetForm}
          onApplySuccess={() => {
            setLastApplied('privacy_batch')
            setTimeout(resetForm, 1500)
          }}
        />
      ) : (
      <div className="flex h-full">
        {/* Left Column: Picker (scrollable) */}
        <div className="w-[340px] border-r border-border/50 flex flex-col">
          <ScrollArea className="flex-1">
            <div className="p-4">
              <GroupedTransformationPicker
                ref={pickerRef}
                selectedTransform={selectedTransform}
                lastApplied={lastApplied}
                disabled={!activeTable || isApplying}
                onSelect={handleSelectTransform}
                onNavigateNext={handlePickerNavigateNext}
              />

              {/* No table state - show in picker column */}
              {!activeTable && (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="text-sm">No table selected</p>
                  <p className="text-xs mt-1">
                    Upload a CSV file to start transforming data
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right Column: Configuration (vertically centered, scrollable if needed) */}
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="flex-1 flex flex-col justify-center p-4">
            {selectedTransform ? (
                <div className="space-y-4 animate-in fade-in duration-200">
                  {/* Enhanced Transform Info */}
                  <div className="bg-muted/30 rounded-lg p-3 space-y-3">
                    {/* Header */}
                    <div>
                      <h3 className="font-medium flex items-center gap-2">
                        <span className="text-lg">{selectedTransform.icon}</span>
                        {selectedTransform.label}
                      </h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {selectedTransform.description}
                      </p>
                    </div>

                    {/* Examples */}
                    {selectedTransform.examples && selectedTransform.examples.length > 0 && (
                      <div className="border-t border-border/50 pt-2">
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">Examples</p>
                        <div className="space-y-1">
                          {selectedTransform.examples.slice(0, 2).map((ex, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs font-mono">
                              <span className="text-red-400/80">{ex.before}</span>
                              <span className="text-muted-foreground">→</span>
                              <span className="text-green-400/80">{ex.after}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Hints */}
                    {selectedTransform.hints && selectedTransform.hints.length > 0 && (
                      <div className="border-t border-border/50 pt-2">
                        <ul className="text-xs text-muted-foreground space-y-0.5">
                          {selectedTransform.hints.map((hint, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className="text-blue-400">•</span>
                              {hint}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Custom SQL Context Helper */}
                  {selectedTransform.id === 'custom_sql' && activeTable && (
                    <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3 space-y-3">
                      {/* Table Info */}
                      <div>
                        <p className="text-xs font-medium text-slate-400 mb-1">Table</p>
                        <code className="text-sm text-cyan-400 font-mono">&quot;{activeTable.name}&quot;</code>
                        <span className="text-xs text-muted-foreground ml-2">
                          ({activeTable.rowCount?.toLocaleString() || 0} rows)
                        </span>
                      </div>

                      {/* Available Columns */}
                      <div>
                        <p className="text-xs font-medium text-slate-400 mb-1">
                          Columns ({columns.length})
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {columns.slice(0, 10).map((col) => (
                            <button
                              key={col}
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(`"${col}"`)
                                toast.success(`Copied "${col}" to clipboard`)
                              }}
                              className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800
                                         text-amber-400 hover:bg-slate-700 transition-colors"
                            >
                              &quot;{col}&quot;
                            </button>
                          ))}
                          {columns.length > 10 && (
                            <span className="text-xs text-muted-foreground self-center">
                              +{columns.length - 10} more
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Quick Templates */}
                      <div>
                        <p className="text-xs font-medium text-slate-400 mb-1">Quick Templates</p>
                        <div className="space-y-1">
                          {[
                            { label: 'Update column', sql: `UPDATE "${activeTable.name}" SET "column" = value` },
                            { label: 'Add column', sql: `ALTER TABLE "${activeTable.name}" ADD COLUMN new_col VARCHAR` },
                            { label: 'Delete rows', sql: `DELETE FROM "${activeTable.name}" WHERE condition` },
                          ].map((template) => (
                            <button
                              key={template.label}
                              type="button"
                              onClick={() => setParams({ ...params, sql: template.sql })}
                              className="w-full text-left text-xs px-2 py-1.5 rounded
                                         bg-slate-800/50 hover:bg-slate-800 transition-colors"
                            >
                              <span className="text-slate-300">{template.label}</span>
                              <code className="block text-[10px] text-slate-500 font-mono truncate">
                                {template.sql}
                              </code>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Live Preview */}
                  {activeTable && selectedTransform.id !== 'custom_sql' && (
                    <TransformPreview
                      tableName={activeTable.name}
                      column={selectedColumn || undefined}
                      transformType={selectedTransform.id}
                      params={params}
                      sampleCount={10}
                      onPreviewStateChange={setPreviewState}
                    />
                  )}

                  {/* Column Selector */}
                  {selectedTransform.requiresColumn && (
                    <div className="space-y-2">
                      <Label>Target Column</Label>
                      <ColumnCombobox
                        columns={columns}
                        value={selectedColumn}
                        onValueChange={handleColumnChange}
                        disabled={isApplying}
                        open={columnComboboxOpen}
                        onOpenChange={setColumnComboboxOpen}
                        autoFocus
                      />
                    </div>
                  )}

                  {/* Additional Params */}
                  {selectedTransform.params
                    ?.filter((param) => {
                      // For split_column, only show relevant params based on splitMode
                      if (selectedTransform.id === 'split_column') {
                        const splitMode = params.splitMode || 'delimiter'
                        if (param.name === 'delimiter') return splitMode === 'delimiter'
                        if (param.name === 'position') return splitMode === 'position'
                        if (param.name === 'length') return splitMode === 'length'
                      }
                      return true
                    })
                    .map((param, paramIndex) => {
                    const isFirstParam = paramIndex === 0

                    return (
                    <div key={param.name} className="space-y-2">
                      <Label>{param.label}</Label>
                      {param.type === 'select' && param.options ? (
                        <Select
                          value={params[param.name] || ''}
                          onValueChange={(v) =>
                            setParams({ ...params, [param.name]: v })
                          }
                        >
                          <SelectTrigger
                            ref={isFirstParam ? (el) => { firstParamElementRef.current = el } : undefined}
                          >
                            <SelectValue placeholder={`Select ${param.label}`} />
                          </SelectTrigger>
                          <SelectContent>
                            {param.options.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : selectedTransform.id === 'custom_sql' && param.name === 'sql' ? (
                        /* Enhanced SQL textarea */
                        <div className="space-y-1">
                          <textarea
                            ref={isFirstParam ? (el) => { firstParamElementRef.current = el } : undefined}
                            value={params[param.name] || ''}
                            onChange={(e) =>
                              setParams({ ...params, [param.name]: e.target.value })
                            }
                            placeholder={`UPDATE "${activeTable?.name || 'table'}" SET "column" = value WHERE condition`}
                            className="w-full h-24 px-3 py-2 text-sm font-mono rounded-md
                                       bg-slate-900 border border-slate-700
                                       text-cyan-300 placeholder:text-slate-600
                                       focus:outline-none focus:ring-2 focus:ring-primary/50
                                       resize-y min-h-[80px]"
                            spellCheck={false}
                          />
                          <p className="text-[10px] text-muted-foreground">
                            Use DuckDB SQL syntax. Column names must be double-quoted.
                          </p>
                        </div>
                      ) : selectedTransform.id === 'combine_columns' && param.name === 'columns' ? (
                        /* Multi-select column picker for combine_columns */
                        <MultiColumnCombobox
                          columns={columns}
                          value={(params[param.name] || '').split(',').filter(Boolean)}
                          onValueChange={(vals) =>
                            setParams({ ...params, [param.name]: vals.join(',') })
                          }
                          placeholder="Select columns to combine..."
                          disabled={isApplying}
                          minColumns={2}
                          open={multiColumnComboboxOpen}
                          onOpenChange={setMultiColumnComboboxOpen}
                        />
                      ) : (
                        <Input
                          ref={isFirstParam ? (el) => { firstParamElementRef.current = el } : undefined}
                          value={params[param.name] || ''}
                          onChange={(e) =>
                            setParams({ ...params, [param.name]: e.target.value })
                          }
                          placeholder={param.label}
                        />
                      )}
                    </div>
                    )
                  })}

                  {/* Validation Message */}
                  {validationResult.status !== 'valid' &&
                   validationResult.status !== 'skipped' &&
                   validationResult.status !== 'pending' && (
                    <ValidationMessage result={validationResult} />
                  )}

                  {/* Action Buttons Row */}
                  <div className="flex gap-2">
                    {/* Apply Button */}
                    <Button
                      ref={applyButtonRef}
                      className="flex-1"
                      onClick={handleApply}
                      disabled={isApplying || !isValid()}
                      data-testid="apply-transformation-btn"
                    >
                      {isApplying ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Applying...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          Apply
                        </>
                      )}
                    </Button>

                    {/* Add to Recipe Dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="flex-1"
                          disabled={!canAddToRecipe() || isApplying}
                          data-testid="add-to-recipe-btn"
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
                  </div>

                  {/* Execution Progress (for batched operations) */}
                  {executionProgress && (
                    <div className="space-y-1 animate-in slide-in-from-top-2 duration-200">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{executionProgress.message}</span>
                        <span>{Math.round(executionProgress.progress)}%</span>
                      </div>
                      <Progress value={executionProgress.progress} className="h-2" />
                    </div>
                  )}

                  {/* Cancel Button */}
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={resetForm}
                    disabled={isApplying}
                  >
                    Cancel
                  </Button>
                </div>
            ) : (
              /* Empty State for right column */
              <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-6">
                <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                  <Sparkles className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Select a transformation from the left to configure it
                </p>

                {/* Save as Recipe shortcut - opens Recipe panel alongside Clean panel */}
                {activeCommandCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-4 text-muted-foreground hover:text-foreground"
                    onClick={() => setSecondaryPanel('recipe')}
                  >
                    <BookOpen className="w-4 h-4 mr-2" />
                    Save transforms as recipe
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      )}
    </>
  )
}
