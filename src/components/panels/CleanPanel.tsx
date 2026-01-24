import { useState } from 'react'
import { Loader2, Sparkles, AlertTriangle } from 'lucide-react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { useTableStore } from '@/stores/tableStore'
import { toast } from 'sonner'
import {
  TransformationDefinition,
  validateCastType,
  CastTypeValidation,
} from '@/lib/transformations'
import { GroupedTransformationPicker } from '@/components/clean/GroupedTransformationPicker'
import { initializeTimeline } from '@/lib/timeline-engine'
import {
  createCommand,
  getCommandExecutor,
  getCommandTypeFromTransform,
  getCommandLabel,
  type ExecutorProgress,
} from '@/lib/commands'

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

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const columns = activeTable?.columns.map((c) => c.name) || []

  const handleSelectTransform = (transform: TransformationDefinition) => {
    setSelectedTransform(transform)
    setSelectedColumn('')
    setLastApplied(null)
    // Pre-populate params with defaults
    const defaultParams: Record<string, string> = {}
    transform.params?.forEach((param) => {
      if (param.default) {
        defaultParams[param.name] = param.default
      }
    })
    setParams(defaultParams)
  }

  const resetForm = () => {
    setSelectedTransform(null)
    setSelectedColumn('')
    setParams({})
    setLastApplied(null)
  }

  const isValid = () => {
    if (!selectedTransform) return false
    if (selectedTransform.requiresColumn && !selectedColumn) return false
    if (selectedTransform.params) {
      for (const param of selectedTransform.params) {
        if (!params[param.name]) return false
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

      // 4. Create and execute command through CommandExecutor
      const command = createCommand(commandType, commandParams)
      const executor = getCommandExecutor()
      const result = await executor.execute(command, {
        onProgress: (progress) => {
          console.log(`[Command] ${progress.phase}: ${progress.progress}%`)
          setExecutionProgress(progress)
        },
      })

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
            <AlertDialogAction
              onClick={handleConfirmCastType}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Apply Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Grouped Transformation Picker */}
          <GroupedTransformationPicker
            selectedTransform={selectedTransform}
            lastApplied={lastApplied}
            disabled={!activeTable || isApplying}
            onSelect={handleSelectTransform}
          />

          {/* Configuration Section */}
          {selectedTransform && (
            <div className="space-y-4 pt-4 border-t border-border/50 animate-in slide-in-from-top-2 duration-200">
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

              {/* Column Selector */}
              {selectedTransform.requiresColumn && (
                <div className="space-y-2">
                  <Label>Target Column</Label>
                  <Select
                    value={selectedColumn}
                    onValueChange={setSelectedColumn}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select column..." />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map((col) => (
                        <SelectItem key={col} value={col}>
                          {col}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                .map((param) => (
                <div key={param.name} className="space-y-2">
                  <Label>{param.label}</Label>
                  {param.type === 'select' && param.options ? (
                    <Select
                      value={params[param.name] || ''}
                      onValueChange={(v) =>
                        setParams({ ...params, [param.name]: v })
                      }
                    >
                      <SelectTrigger>
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
                  ) : (
                    <Input
                      value={params[param.name] || ''}
                      onChange={(e) =>
                        setParams({ ...params, [param.name]: e.target.value })
                      }
                      placeholder={param.label}
                    />
                  )}
                </div>
              ))}

              {/* Apply Button */}
              <Button
                className="w-full"
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
                    Apply Transformation
                  </>
                )}
              </Button>

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
          )}

          {/* Empty State */}
          {!selectedTransform && !activeTable && (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">No table selected</p>
              <p className="text-xs mt-1">
                Upload a CSV file to start transforming data
              </p>
            </div>
          )}

          {!selectedTransform && activeTable && (
            <div className="text-center py-4 text-muted-foreground">
              <p className="text-xs">
                Select a transformation above to configure and apply
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
      </div>
    </>
  )
}
