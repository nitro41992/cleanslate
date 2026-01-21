import { useState } from 'react'
import { Play, Trash2, GripVertical, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { useTableStore } from '@/stores/tableStore'
import { toast } from 'sonner'
import {
  applyTransformation,
  getTransformationLabel,
  TRANSFORMATIONS,
} from '@/lib/transformations'
import { TransformationPicker } from '@/features/laundromat/components/TransformationPicker'
import type { TransformationStep } from '@/types'
import { cn } from '@/lib/utils'

export function CleanPanel() {
  const [isRunning, setIsRunning] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const pendingRecipe = usePreviewStore((s) => s.pendingRecipe)
  const addRecipeStep = usePreviewStore((s) => s.addRecipeStep)
  const removeRecipeStep = usePreviewStore((s) => s.removeRecipeStep)
  const clearRecipe = usePreviewStore((s) => s.clearRecipe)
  const addPendingOperation = usePreviewStore((s) => s.addPendingOperation)
  const updateChangesSummary = usePreviewStore((s) => s.updateChangesSummary)

  const addTransformationEntry = useAuditStore((s) => s.addTransformationEntry)

  const handleAddStep = (step: TransformationStep) => {
    addRecipeStep(step)
    setIsPickerOpen(false)
  }

  const handleRunRecipe = async () => {
    if (!activeTable || pendingRecipe.length === 0) return

    setIsRunning(true)
    let totalAffected = 0
    let finalRowCount = 0

    try {
      for (let i = 0; i < pendingRecipe.length; i++) {
        setCurrentStep(i)
        const step = pendingRecipe[i]

        const result = await applyTransformation(activeTable.name, step)
        totalAffected += result.affected
        finalRowCount = result.rowCount

        addTransformationEntry({
          tableId: activeTable.id,
          tableName: activeTable.name,
          action: getTransformationLabel(step),
          details: `Applied transformation. Current row count: ${result.rowCount}`,
          rowsAffected: result.affected,
          hasRowDetails: result.hasRowDetails,
          auditEntryId: result.auditEntryId,
        })

        // Track in pending operations
        addPendingOperation({
          type: 'transform',
          label: getTransformationLabel(step),
          config: step,
        })
      }

      // Update table metadata
      updateTable(activeTable.id, { rowCount: finalRowCount })

      // Update changes summary
      updateChangesSummary({ transformsApplied: pendingRecipe.length })

      toast.success('Recipe Applied', {
        description: `${pendingRecipe.length} transformations completed. ${totalAffected} rows affected.`,
      })

      clearRecipe()
    } catch (error) {
      console.error('Recipe execution failed:', error)
      toast.error('Recipe Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsRunning(false)
      setCurrentStep(-1)
    }
  }

  const getStepIcon = (type: string) => {
    const def = TRANSFORMATIONS.find((t) => t.id === type)
    return def?.icon || '?'
  }

  return (
    <div className="flex flex-col h-full">
      {/* Recipe List */}
      <ScrollArea className="flex-1 px-4">
        <div className="py-4 space-y-2">
          {pendingRecipe.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">No transformations yet</p>
              <p className="text-xs mt-1">
                Click "Add Transformation" to start building your recipe
              </p>
            </div>
          ) : (
            pendingRecipe.map((step, index) => (
              <div
                key={step.id}
                className={cn(
                  'group flex items-center gap-2 p-3 rounded-lg border border-border/50 bg-card',
                  'hover:border-border transition-colors',
                  currentStep === index && 'border-primary bg-primary/5'
                )}
              >
                <GripVertical className="w-4 h-4 text-muted-foreground/50 cursor-grab" />

                <span className="text-lg">{getStepIcon(step.type)}</span>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {TRANSFORMATIONS.find((t) => t.id === step.type)?.label ||
                      step.type}
                  </p>
                  {step.column && (
                    <Badge variant="secondary" className="mt-1 text-xs">
                      {step.column}
                    </Badge>
                  )}
                </div>

                {currentStep === index ? (
                  <Loader2 className="w-4 h-4 animate-spin text-primary" />
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => removeRecipeStep(index)}
                    disabled={isRunning}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />

      {/* Actions */}
      <div className="p-4 space-y-2">
        <Button
          variant="outline"
          className="w-full"
          onClick={() => setIsPickerOpen(true)}
          disabled={!activeTable}
          data-testid="add-transformation-btn"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Transformation
        </Button>

        {pendingRecipe.length > 0 && (
          <>
            <Button
              className="w-full"
              onClick={handleRunRecipe}
              disabled={isRunning || !activeTable}
              data-testid="run-recipe-btn"
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Running ({currentStep + 1}/{pendingRecipe.length})
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Run Recipe ({pendingRecipe.length} steps)
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={clearRecipe}
              disabled={isRunning}
            >
              Clear Recipe
            </Button>
          </>
        )}
      </div>

      {/* Transformation Picker Dialog */}
      <TransformationPicker
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        columns={activeTable?.columns.map((c) => c.name) || []}
        onSelect={handleAddStep}
      />
    </div>
  )
}
