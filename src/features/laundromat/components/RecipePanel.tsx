import { useState } from 'react'
import { Play, Trash2, GripVertical, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useAuditStore } from '@/stores/auditStore'
import { useTableStore } from '@/stores/tableStore'
import { toast } from '@/hooks/use-toast'
import {
  applyTransformation,
  getTransformationLabel,
  TRANSFORMATIONS,
} from '@/lib/transformations'
import type { TransformationStep } from '@/types'
import { cn } from '@/lib/utils'

interface RecipePanelProps {
  recipe: TransformationStep[]
  columns: string[]
  tableName: string
  tableId: string
  onRemoveStep: (index: number) => void
  onClearRecipe: () => void
}

export function RecipePanel({
  recipe,
  columns: _columns,
  tableName,
  tableId,
  onRemoveStep,
  onClearRecipe,
}: RecipePanelProps) {
  const [isRunning, setIsRunning] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const updateTable = useTableStore((s) => s.updateTable)

  const handleRunRecipe = async () => {
    if (!tableName || recipe.length === 0) return

    setIsRunning(true)
    let totalAffected = 0
    let finalRowCount = 0

    try {
      for (let i = 0; i < recipe.length; i++) {
        setCurrentStep(i)
        const step = recipe[i]

        const result = await applyTransformation(tableName, step)
        totalAffected += result.affected
        finalRowCount = result.rowCount

        addAuditEntry(
          tableId,
          tableName,
          getTransformationLabel(step),
          `Applied transformation. Rows affected: ${result.affected}. Current row count: ${result.rowCount}`
        )
      }

      // Update table metadata
      updateTable(tableId, { rowCount: finalRowCount })

      toast({
        title: 'Recipe Applied',
        description: `${recipe.length} transformations completed. ${totalAffected} rows affected.`,
      })

      onClearRecipe()
    } catch (error) {
      console.error('Recipe execution failed:', error)
      toast({
        title: 'Recipe Failed',
        description:
          error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
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
    <div className="flex-1 flex flex-col min-h-0">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {recipe.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">No transformations yet</p>
              <p className="text-xs mt-1">
                Click "Add Transformation" to start
              </p>
            </div>
          ) : (
            recipe.map((step, index) => (
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
                    onClick={() => onRemoveStep(index)}
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

      {recipe.length > 0 && (
        <div className="p-4 border-t border-border/50 space-y-2">
          <Button
            className="w-full"
            onClick={handleRunRecipe}
            disabled={isRunning || !tableName}
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Running ({currentStep + 1}/{recipe.length})
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Run Recipe ({recipe.length} steps)
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={onClearRecipe}
            disabled={isRunning}
          >
            Clear Recipe
          </Button>
        </div>
      )}
    </div>
  )
}
