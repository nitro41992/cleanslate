import { useState } from 'react'
import { Loader2, Sparkles, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { useTableStore } from '@/stores/tableStore'
import { toast } from 'sonner'
import {
  applyTransformation,
  getTransformationLabel,
  TRANSFORMATIONS,
  TransformationDefinition,
} from '@/lib/transformations'
import type { TransformationStep } from '@/types'
import { generateId, cn } from '@/lib/utils'

export function CleanPanel() {
  const [isApplying, setIsApplying] = useState(false)
  const [selectedTransform, setSelectedTransform] = useState<TransformationDefinition | null>(null)
  const [selectedColumn, setSelectedColumn] = useState<string>('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [lastApplied, setLastApplied] = useState<string | null>(null)

  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const addPendingOperation = usePreviewStore((s) => s.addPendingOperation)
  const updateChangesSummary = usePreviewStore((s) => s.updateChangesSummary)

  const addTransformationEntry = useAuditStore((s) => s.addTransformationEntry)

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

  const handleApply = async () => {
    if (!activeTable || !selectedTransform) return

    setIsApplying(true)

    try {
      // 1. Build TransformationStep
      const step: TransformationStep = {
        id: generateId(),
        type: selectedTransform.id,
        label: selectedTransform.label,
        column: selectedTransform.requiresColumn ? selectedColumn : undefined,
        params: Object.keys(params).length > 0 ? params : undefined,
      }

      // 2. Execute immediately
      const result = await applyTransformation(activeTable.name, step)

      // 3. Log to audit store
      addTransformationEntry({
        tableId: activeTable.id,
        tableName: activeTable.name,
        action: getTransformationLabel(step),
        details: `Applied transformation. Current row count: ${result.rowCount}`,
        rowsAffected: result.affected,
        hasRowDetails: result.hasRowDetails,
        auditEntryId: result.auditEntryId,
      })

      // 4. Track in pending operations
      addPendingOperation({
        type: 'transform',
        label: getTransformationLabel(step),
        config: step,
      })

      // 5. Update table metadata
      updateTable(activeTable.id, { rowCount: result.rowCount })

      // 6. Update changes summary
      updateChangesSummary({ transformsApplied: 1 })

      // 7. Show success, mark last applied
      setLastApplied(selectedTransform.id)
      toast.success('Transformation Applied', {
        description: `${selectedTransform.label} completed. ${result.affected} rows affected.`,
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
    }
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Transformation Grid */}
          <div className="grid grid-cols-2 gap-2">
            {TRANSFORMATIONS.map((t) => (
              <button
                key={t.id}
                onClick={() => handleSelectTransform(t)}
                disabled={!activeTable || isApplying}
                className={cn(
                  'flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all',
                  'hover:bg-muted/50 hover:border-border',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  selectedTransform?.id === t.id && 'border-primary bg-primary/5',
                  lastApplied === t.id && 'border-green-500 bg-green-500/10'
                )}
              >
                <div className="relative">
                  <span className="text-2xl">{t.icon}</span>
                  {lastApplied === t.id && (
                    <div className="absolute -top-1 -right-2 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}
                </div>
                <span className="text-xs font-medium text-center leading-tight">
                  {t.label}
                </span>
              </button>
            ))}
          </div>

          {/* Configuration Section */}
          {selectedTransform && (
            <div className="space-y-4 pt-4 border-t border-border/50 animate-in slide-in-from-top-2 duration-200">
              {/* Transform Info */}
              <div className="bg-muted/30 rounded-lg p-3">
                <h3 className="font-medium flex items-center gap-2">
                  <span className="text-lg">{selectedTransform.icon}</span>
                  {selectedTransform.label}
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {selectedTransform.description}
                </p>
              </div>

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
              {selectedTransform.params?.map((param) => (
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
  )
}
