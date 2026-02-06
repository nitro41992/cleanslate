import { useState, useRef, useEffect, useCallback } from 'react'
import { Loader2, Wand2, AlertTriangle, BookOpen, Pencil } from 'lucide-react'
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ColumnCombobox } from '@/components/ui/combobox'
import { MultiColumnCombobox } from '@/components/ui/multi-column-combobox'
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
import { toast } from 'sonner'
import type { RecipeStep, TransformationType } from '@/types'
import {
  TRANSFORMATIONS,
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
import { FormulaEditor, type OutputMode } from '@/components/clean/FormulaEditor'
import { extractColumnRefs } from '@/lib/formula'
import { AddToRecipeButton } from '@/components/recipe/AddToRecipeButton'
import { ConfirmStepUpdateDialog } from '@/components/recipe/ConfirmStepUpdateDialog'
import { useRecipeStore, selectSelectedRecipe } from '@/stores/recipeStore'
import { getTransformId } from '@/lib/recipe/transform-lookup'
import { useOperationStore } from '@/stores/operationStore'

export function CleanPanel() {
  const [activeTab, setActiveTab] = useState<'transforms' | 'formula'>('transforms')
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

  // Formula tab state (separate from transforms tab)
  const [formulaParams, setFormulaParams] = useState<Record<string, string>>({})
  const [formulaPreviewState, setFormulaPreviewState] = useState<PreviewState | null>(null)

  // Keyboard navigation state
  const [columnComboboxOpen, setColumnComboboxOpen] = useState(false)
  const [multiColumnComboboxOpen, setMultiColumnComboboxOpen] = useState(false)
  const pickerRef = useRef<GroupedTransformationPickerRef>(null)
  const applyButtonRef = useRef<HTMLButtonElement>(null)
  // Use a more flexible approach for first param - store the element directly
  const firstParamElementRef = useRef<HTMLElement | null>(null)

  // Editing step state
  const editingStepContext = useRecipeStore((s) => s.editingStepContext)
  const cancelEditingStep = useRecipeStore((s) => s.cancelEditingStep)
  const commitEditingStep = useRecipeStore((s) => s.commitEditingStep)
  const editingRecipe = useRecipeStore(selectSelectedRecipe)
  const [showUpdateDialog, setShowUpdateDialog] = useState(false)
  // Track whether we've already populated form from editing context (avoids re-running on every render)
  const editingPopulatedRef = useRef<string | null>(null)

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const activeTable = tables.find((t) => t.id === activeTableId)
  const timeline = useTimelineStore((s) => activeTableId ? s.getTimeline(activeTableId) : undefined)
  const setSecondaryPanel = usePreviewStore((s) => s.setSecondaryPanel)

  const columns = activeTable?.columns.map((c) => c.name) || []
  // Columns with type info for type-aware FormulaEditor
  const columnsWithTypes = activeTable?.columns.map((c) => ({ name: c.name, type: c.type })) || []
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

  // Pre-populate form when editing a recipe step
  useEffect(() => {
    if (!editingStepContext) {
      // Context cleared (cancel or commit) — reset form if we previously populated
      if (editingPopulatedRef.current) {
        editingPopulatedRef.current = null
        resetForm()
      }
      return
    }

    // Avoid re-populating if we already set up for this step
    if (editingPopulatedRef.current === editingStepContext.stepId) return
    editingPopulatedRef.current = editingStepContext.stepId

    const step = editingStepContext.originalStep

    // Handle formula steps — switch to formula tab
    if (step.type === 'transform:excel_formula') {
      setActiveTab('formula')
      const fp: Record<string, string> = {}
      if (step.params) {
        for (const [k, v] of Object.entries(step.params)) {
          fp[k] = String(v ?? '')
        }
      }
      setFormulaParams(fp)
      return
    }

    // Switch to transforms tab
    setActiveTab('transforms')

    // Look up the TransformationDefinition
    const transformId = getTransformId(step.type)
    const transformDef = TRANSFORMATIONS.find((t) => t.id === transformId)
    if (transformDef) {
      setSelectedTransform(transformDef)
    }

    // Set column
    if (step.column) {
      setSelectedColumn(step.column)
    }

    // Convert step.params (Record<string, unknown>) to Record<string, string>
    if (step.params) {
      const stringParams: Record<string, string> = {}
      for (const [k, v] of Object.entries(step.params)) {
        stringParams[k] = String(v ?? '')
      }
      setParams(stringParams)
    }
  }, [editingStepContext])

  // Cancel editing when CleanPanel truly unmounts (user navigates away).
  // Use a ref to survive React StrictMode's simulated unmount/remount cycle —
  // StrictMode fires cleanup between the two mounts, which would clear the
  // editing context before the remounted effect can read it.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Defer so StrictMode's immediate remount can set mountedRef back to true
      setTimeout(() => {
        if (!mountedRef.current && useRecipeStore.getState().editingStepContext) {
          useRecipeStore.getState().cancelEditingStep()
        }
      }, 0)
    }
  }, [])

  const resetForm = () => {
    setSelectedTransform(null)
    setSelectedColumn('')
    setParams({})
    setLastApplied(null)
    setPreviewState(null)
  }

  const resetFormulaForm = () => {
    setFormulaParams({})
    setLastApplied(null)
    setFormulaPreviewState(null)
  }

  const handleTabChange = (tab: string) => {
    setActiveTab(tab as 'transforms' | 'formula')
    // Reset transforms tab state when switching away
    if (tab === 'formula') {
      resetForm()
    }
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

    const opLabel = `Applying ${selectedTransform.label}${selectedColumn ? ` to '${selectedColumn}'` : ''}`
    const opId = useOperationStore.getState().registerOperation('clean', opLabel)
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
          useOperationStore.getState().updateProgress(opId, progress.progress, progress.message)
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
      useOperationStore.getState().deregisterOperation(opId)
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

  // Handle "Update Step" click — open confirmation dialog
  const handleUpdateStepClick = () => {
    setShowUpdateDialog(true)
  }

  // Handle confirmed step update
  const handleConfirmStepUpdate = () => {
    setShowUpdateDialog(false)
    if (!editingStepContext) return

    if (activeTab === 'formula') {
      // Formula step update
      const step = buildFormulaStep()
      if (step) {
        commitEditingStep({
          column: step.column,
          params: step.params,
          label: step.label,
        })
      }
    } else {
      // Transform step update
      const step = buildStepFromCurrentForm()
      if (step) {
        commitEditingStep({
          column: step.column,
          params: step.params,
          label: step.label,
        })
      }
    }

    toast.success('Recipe step updated')
    setTimeout(resetForm, 300)
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

  // Check if the current form state is valid for adding to a recipe
  // Note: Less strict than isValid() - allows adding to recipes even with 0 matching rows
  // because recipes are often planned for future use with different data
  const canAddToRecipe = () => {
    if (!selectedTransform) return false
    if (selectedTransform.requiresColumn && !selectedColumn) return false
    if (selectedTransform.params) {
      for (const param of selectedTransform.params) {
        if (param.required !== false && !params[param.name]) return false
      }
    }

    // Semantic validation: block truly invalid transforms but allow data-dependent no-ops
    // - 'invalid': Transform cannot work (e.g., column doesn't exist)
    // - 'no_op' with NO_MATCHES: Current data has no matches - OK for recipes since
    //   recipes are often planned for different data
    // - Other 'no_op': Inherently pointless (e.g., replace 'foo' with 'foo') - still block
    if (validationResult.status === 'invalid') {
      return false
    }
    if (validationResult.status === 'no_op' && validationResult.code !== 'NO_MATCHES') {
      return false
    }

    return true
  }

  // Compute editing step index for banner display
  const editingStepNumber = editingStepContext && editingRecipe
    ? (editingRecipe.steps.findIndex((s) => s.id === editingStepContext.stepId) + 1)
    : null

  // ===== Formula Tab Logic =====
  const formulaBuilderDef = TRANSFORMATIONS.find((t) => t.id === 'excel_formula')!

  const isFormulaValid = () => {
    if (!formulaParams.formula || formulaParams.formula.trim() === '') return false
    const outputMode = formulaParams.outputMode || 'new'
    if (outputMode === 'new') {
      if (!formulaParams.outputColumn || formulaParams.outputColumn.trim() === '') return false
    } else if (outputMode === 'replace') {
      if (!formulaParams.targetColumn || formulaParams.targetColumn.trim() === '') return false
    }
    // Block Apply if preview shows an error (e.g., invalid SQL, bad column refs)
    if (formulaPreviewState?.isReady && !formulaPreviewState.isLoading) {
      if (formulaPreviewState.hasError) {
        return false
      }
    }
    return true
  }

  const handleFormulaApply = async () => {
    if (!activeTable) return

    const opId = useOperationStore.getState().registerOperation('clean', 'Applying formula')
    setIsApplying(true)
    try {
      await initializeTimeline(activeTable.id, activeTable.name)

      const commandType = getCommandTypeFromTransform('excel_formula')
      if (!commandType) {
        throw new Error('Unknown transformation type: excel_formula')
      }

      const commandParams = {
        tableId: activeTable.id,
        ...formulaParams,
      }

      const command = createCommand(commandType, commandParams)
      const result = await executeWithConfirmation(command, activeTable.id, {
        onProgress: (progress: ExecutorProgress) => {
          setExecutionProgress(progress)
          useOperationStore.getState().updateProgress(opId, progress.progress, progress.message)
        },
      })

      if (!result) return

      if (!result.success && result.validationResult) {
        const errors = result.validationResult.errors.map((e) => e.message).join(', ')
        toast.error('Validation Failed', { description: errors })
        return
      }

      if (!result.success) {
        throw new Error(result.error || 'Formula failed')
      }

      const affected = result.executionResult?.affected ?? 0
      setLastApplied('excel_formula')
      toast.success('Formula Applied', {
        description: `${getCommandLabel(commandType)} completed. ${affected} rows affected.`,
      })

      setTimeout(resetFormulaForm, 1500)
    } catch (error) {
      console.error('Formula failed:', error)
      toast.error('Formula Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsApplying(false)
      setExecutionProgress(null)
      useOperationStore.getState().deregisterOperation(opId)
    }
  }

  const buildFormulaStep = (): Omit<RecipeStep, 'id'> | null => {
    const formula = formulaParams.formula || ''
    const outputMode = formulaParams.outputMode || 'new'
    const referencedColumns = extractColumnRefs(formula)

    const stepParams: Record<string, unknown> = {
      formula,
      outputMode,
      referencedColumns,
    }

    if (outputMode === 'new') {
      stepParams.outputColumn = formulaParams.outputColumn || ''
    } else {
      stepParams.targetColumn = formulaParams.targetColumn || ''
    }

    const outputLabel = outputMode === 'new'
      ? formulaParams.outputColumn
      : formulaParams.targetColumn

    return {
      type: 'transform:excel_formula',
      label: `Formula Builder → ${outputLabel}`,
      column: undefined,
      params: stepParams,
      enabled: true,
    }
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

      {/* Confirm Step Update Dialog */}
      <ConfirmStepUpdateDialog
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
        recipe={editingRecipe}
        onConfirm={handleConfirmStepUpdate}
        onCancel={() => setShowUpdateDialog(false)}
      />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
        <div className="border-b border-border/50 px-4 pt-2">
          <TabsList className="w-full">
            <TabsTrigger value="transforms" className="flex-1">Quick Transforms</TabsTrigger>
            <TabsTrigger value="formula" className="flex-1">Formula Builder</TabsTrigger>
          </TabsList>
        </div>

        {/* Quick Transforms Tab */}
        <TabsContent value="transforms" className="flex-1 mt-0 overflow-hidden">
          <div className="flex h-full">
            {/* Left Column: Picker (scrollable) */}
            <div className="w-[340px] min-w-[340px] max-w-[340px] border-r border-border/50 flex flex-col">
              <div className="flex-1 overflow-y-auto overflow-x-hidden">
                <div className="p-4">
                  <GroupedTransformationPicker
                    ref={pickerRef}
                    selectedTransform={selectedTransform}
                    lastApplied={lastApplied}
                    disabled={!activeTable || isApplying || !!editingStepContext}
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
              </div>
            </div>

            {/* Right Column: Configuration (vertically centered, scrollable if needed) */}
            <div className="flex-1 flex flex-col overflow-y-auto">
              {/* Privacy Sub-Panel - renders in right column when privacy_batch is selected */}
              {selectedTransform?.id === 'privacy_batch' ? (
                <PrivacySubPanel
                  onCancel={resetForm}
                  onApplySuccess={() => {
                    setLastApplied('privacy_batch')
                    setTimeout(resetForm, 1500)
                  }}
                />
              ) : (
              <div className="flex-1 flex flex-col justify-center p-4">
                {selectedTransform ? (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {/* Editing Step Banner */}
                      {editingStepContext && editingRecipe && (
                        <div className="flex items-center justify-between rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2">
                          <span className="text-sm text-blue-700 dark:text-blue-300">
                            Editing step {editingStepNumber} of <strong>{editingRecipe.name}</strong>
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100"
                            onClick={() => {
                              cancelEditingStep()
                              resetForm()
                            }}
                          >
                            Cancel Edit
                          </Button>
                        </div>
                      )}

                      {/* Enhanced Transform Info */}
                      <div className="bg-muted rounded-lg p-3 space-y-3">
                        {/* Header */}
                        <div>
                          <h3 className="font-medium flex items-center gap-2">
                            <selectedTransform.icon className="w-5 h-5" />
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
                                  <span className="text-red-600 dark:text-red-400/80">{ex.before}</span>
                                  <span className="text-muted-foreground">→</span>
                                  <span className="text-green-700 dark:text-green-400/80">{ex.after}</span>
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
                                  <span className="text-blue-600 dark:text-blue-400">•</span>
                                  {hint}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      {/* Live Preview */}
                      {activeTable && (
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
                        {editingStepContext ? (
                          /* Update Step button (edit mode) */
                          <Button
                            ref={applyButtonRef}
                            className="flex-1 transition-colors duration-150"
                            onClick={handleUpdateStepClick}
                            disabled={!isValid()}
                            data-testid="update-step-btn"
                          >
                            <Pencil className="w-4 h-4 mr-2" />
                            Update Step
                          </Button>
                        ) : (
                          <>
                            {/* Apply Button (normal mode) */}
                            <Button
                              ref={applyButtonRef}
                              className="flex-1 transition-colors duration-150"
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
                                  <Wand2 className="w-4 h-4 mr-2" />
                                  Apply
                                </>
                              )}
                            </Button>

                            {/* Add to Recipe (hidden in edit mode) */}
                            <AddToRecipeButton
                              buildStep={buildStepFromCurrentForm}
                              canAdd={canAddToRecipe()}
                              isProcessing={isApplying}
                              stepLabel={selectedTransform?.label}
                            />
                          </>
                        )}
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
                        onClick={() => {
                          if (editingStepContext) {
                            cancelEditingStep()
                          }
                          resetForm()
                        }}
                        disabled={isApplying}
                      >
                        {editingStepContext ? 'Cancel Edit' : 'Cancel'}
                      </Button>
                    </div>
                ) : (
                  /* Empty State for right column */
                  <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-6">
                    <p className="text-lg text-muted-foreground">
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
              )}
            </div>
          </div>
        </TabsContent>

        {/* Formula Builder Tab */}
        <TabsContent value="formula" className="flex-1 mt-0 overflow-hidden">
          <div className="flex-1 flex flex-col p-4 overflow-y-auto h-full">
            {!activeTable ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <p className="text-sm text-muted-foreground">No table selected</p>
                <p className="text-xs mt-1 text-muted-foreground">
                  Upload a CSV file to start using formulas
                </p>
              </div>
            ) : (
              <>
                <FormulaEditor
                  value={formulaParams.formula || ''}
                  onChange={(formula) => setFormulaParams({ ...formulaParams, formula })}
                  columns={columnsWithTypes}
                  outputMode={(formulaParams.outputMode as OutputMode) || 'new'}
                  onOutputModeChange={(mode) => setFormulaParams({ ...formulaParams, outputMode: mode })}
                  outputColumn={formulaParams.outputColumn || ''}
                  onOutputColumnChange={(col) => setFormulaParams({ ...formulaParams, outputColumn: col })}
                  targetColumn={formulaParams.targetColumn || ''}
                  onTargetColumnChange={(col) => setFormulaParams({ ...formulaParams, targetColumn: col })}
                  disabled={isApplying}
                />

                {/* Live Preview for Formula Builder */}
                {activeTable && (
                  <TransformPreview
                    tableName={activeTable.name}
                    column={undefined}
                    transformType={'excel_formula' as TransformationType}
                    params={formulaParams}
                    sampleCount={10}
                    onPreviewStateChange={setFormulaPreviewState}
                  />
                )}

                {/* Editing Step Banner (formula tab) */}
                {editingStepContext && editingRecipe && (
                  <div className="flex items-center justify-between rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 mt-4">
                    <span className="text-sm text-blue-700 dark:text-blue-300">
                      Editing step {editingStepNumber} of <strong>{editingRecipe.name}</strong>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100"
                      onClick={() => {
                        cancelEditingStep()
                        resetFormulaForm()
                      }}
                    >
                      Cancel Edit
                    </Button>
                  </div>
                )}

                {/* Action Buttons for Formula Builder */}
                <div className="mt-4 space-y-2 pt-4 border-t border-border/50">
                  <div className="flex gap-2">
                    {editingStepContext ? (
                      <Button
                        className="flex-1 transition-colors duration-150"
                        onClick={handleUpdateStepClick}
                        disabled={!isFormulaValid()}
                        data-testid="update-step-btn"
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        Update Step
                      </Button>
                    ) : (
                      <>
                        <Button
                          className="flex-1 transition-colors duration-150"
                          onClick={handleFormulaApply}
                          disabled={isApplying || !isFormulaValid()}
                          data-testid="apply-formula-btn"
                        >
                          {isApplying ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Applying...
                            </>
                          ) : (
                            <>
                              <Wand2 className="w-4 h-4 mr-2" />
                              Apply Formula
                            </>
                          )}
                        </Button>

                        {/* Add to Recipe (hidden in edit mode) */}
                        <AddToRecipeButton
                          buildStep={buildFormulaStep}
                          canAdd={isFormulaValid()}
                          isProcessing={isApplying}
                          stepLabel={formulaBuilderDef?.label || 'Formula'}
                        />
                      </>
                    )}
                  </div>

                  {/* Execution Progress */}
                  {executionProgress && (
                    <div className="space-y-1 animate-in slide-in-from-top-2 duration-200">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{executionProgress.message}</span>
                        <span>{Math.round(executionProgress.progress)}%</span>
                      </div>
                      <Progress value={executionProgress.progress} className="h-2" />
                    </div>
                  )}

                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      if (editingStepContext) {
                        cancelEditingStep()
                      }
                      resetFormulaForm()
                    }}
                    disabled={isApplying}
                  >
                    {editingStepContext ? 'Cancel Edit' : 'Cancel'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  )
}
