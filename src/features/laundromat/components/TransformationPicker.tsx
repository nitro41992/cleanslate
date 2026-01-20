import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TRANSFORMATIONS, TransformationDefinition } from '@/lib/transformations'
import type { TransformationStep } from '@/types'
import { generateId, cn } from '@/lib/utils'

interface TransformationPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columns: string[]
  onSelect: (step: TransformationStep) => void
}

export function TransformationPicker({
  open,
  onOpenChange,
  columns,
  onSelect,
}: TransformationPickerProps) {
  const [selected, setSelected] = useState<TransformationDefinition | null>(null)
  const [selectedColumn, setSelectedColumn] = useState<string>('')
  const [params, setParams] = useState<Record<string, string>>({})

  const handleSelect = (transformation: TransformationDefinition) => {
    setSelected(transformation)
    setSelectedColumn('')
    // Pre-populate params with defaults
    const defaultParams: Record<string, string> = {}
    transformation.params?.forEach((param) => {
      if (param.default) {
        defaultParams[param.name] = param.default
      }
    })
    setParams(defaultParams)
  }

  const handleConfirm = () => {
    if (!selected) return

    const step: TransformationStep = {
      id: generateId(),
      type: selected.id,
      label: selected.label,
      column: selected.requiresColumn ? selectedColumn : undefined,
      params: Object.keys(params).length > 0 ? params : undefined,
    }

    onSelect(step)
    setSelected(null)
    setSelectedColumn('')
    setParams({})
  }

  const isValid = () => {
    if (!selected) return false
    if (selected.requiresColumn && !selectedColumn) return false
    if (selected.params) {
      for (const param of selected.params) {
        if (!params[param.name]) return false
      }
    }
    return true
  }

  const handleClose = () => {
    setSelected(null)
    setSelectedColumn('')
    setParams({})
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Transformation</DialogTitle>
        </DialogHeader>

        <div className="flex gap-4 h-[400px]">
          {/* Transformation List */}
          <ScrollArea className="w-1/2 border border-border rounded-lg">
            <div className="p-2 space-y-1">
              {TRANSFORMATIONS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleSelect(t)}
                  className={cn(
                    'w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors',
                    'hover:bg-muted/50',
                    selected?.id === t.id && 'bg-accent text-accent-foreground'
                  )}
                >
                  <span className="text-xl">{t.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{t.label}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* Configuration Panel */}
          <div className="w-1/2 border border-border rounded-lg overflow-hidden">
            {!selected ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                Select a transformation from the list
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="p-4 space-y-4">
                  <div>
                    <h3 className="font-semibold flex items-center gap-2">
                      <span className="text-xl">{selected.icon}</span>
                      {selected.label}
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {selected.description}
                    </p>
                  </div>

                  {selected.requiresColumn && (
                    <div className="space-y-2">
                      <Label>Column</Label>
                      <Select
                        value={selectedColumn}
                        onValueChange={setSelectedColumn}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select column" />
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

                  {selected.params?.map((param) => (
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
                </div>
              </ScrollArea>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!isValid()}>
            Add to Recipe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
