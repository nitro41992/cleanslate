import * as React from 'react'
import { Check, Hash, Calendar, Type, ToggleLeft, ChevronLeft } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ColumnFilter, FilterOperator, ColumnInfo } from '@/types'
import {
  getFilterCategory,
  getOperatorsForCategory,
  getOperatorLabel,
  type FilterCategory,
} from '@/lib/duckdb/filter-builder'

interface FilterCommandProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columns: ColumnInfo[]
  existingFilter?: ColumnFilter
  onApply: (filter: ColumnFilter) => void
}

type Step = 'column' | 'operator' | 'value'

const categoryIcons: Record<FilterCategory, React.ReactNode> = {
  text: <Type className="h-4 w-4" />,
  numeric: <Hash className="h-4 w-4" />,
  date: <Calendar className="h-4 w-4" />,
  boolean: <ToggleLeft className="h-4 w-4" />,
  unknown: <Type className="h-4 w-4" />,
}

const categoryLabels: Record<FilterCategory, string> = {
  text: 'Text',
  numeric: 'Number',
  date: 'Date',
  boolean: 'Boolean',
  unknown: 'Text',
}

export function FilterCommand({
  open,
  onOpenChange,
  columns,
  existingFilter,
  onApply,
}: FilterCommandProps) {
  const [step, setStep] = React.useState<Step>('column')
  const [selectedColumn, setSelectedColumn] = React.useState<ColumnInfo | null>(null)
  const [selectedOperator, setSelectedOperator] = React.useState<FilterOperator | null>(null)
  const [value, setValue] = React.useState<string>('')
  const [value2, setValue2] = React.useState<string>('')
  const [direction, setDirection] = React.useState<'forward' | 'backward'>('forward')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const commandInputRef = React.useRef<HTMLInputElement>(null)

  // Reset state when dialog opens/closes or existing filter changes
  React.useEffect(() => {
    if (open) {
      setDirection('forward')
      if (existingFilter) {
        // Editing existing filter - find the column info
        const col = columns.find(c => c.name === existingFilter.column)
        if (col) {
          setSelectedColumn(col)
          setSelectedOperator(existingFilter.operator)
          setValue(existingFilter.value?.toString() ?? '')
          setValue2(existingFilter.value2?.toString() ?? '')
          setStep('value')
        }
      } else {
        // New filter - start fresh
        setSelectedColumn(null)
        setSelectedOperator(null)
        setValue('')
        setValue2('')
        setStep('column')
      }
    }
  }, [open, existingFilter, columns])

  // Focus input when entering value step
  React.useEffect(() => {
    if (step === 'value' && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [step])

  const goBack = React.useCallback(() => {
    setDirection('backward')
    if (step === 'value') {
      setStep('operator')
      setValue('')
      setValue2('')
    } else if (step === 'operator') {
      setStep('column')
      setSelectedColumn(null)
      setSelectedOperator(null)
    }
  }, [step])

  const handleColumnSelect = (col: ColumnInfo) => {
    setDirection('forward')
    setSelectedColumn(col)
    const category = getFilterCategory(col.type)
    const operators = getOperatorsForCategory(category)
    // Set default operator
    setSelectedOperator(operators[0])
    setStep('operator')
  }

  const handleOperatorSelect = (op: FilterOperator) => {
    setDirection('forward')
    setSelectedOperator(op)
    // Skip value step for operators that don't need values
    const noValueOps: FilterOperator[] = ['is_empty', 'is_not_empty', 'is_true', 'is_false']
    if (noValueOps.includes(op)) {
      handleApply(op)
    } else {
      setStep('value')
    }
  }

  const handleApply = (operatorOverride?: FilterOperator) => {
    if (!selectedColumn || (!selectedOperator && !operatorOverride)) return

    const op = operatorOverride ?? selectedOperator!
    const category = getFilterCategory(selectedColumn.type)

    let filterValue: string | number | boolean | null = value
    let filterValue2: string | number | undefined = value2 || undefined

    // Convert values based on category
    if (category === 'numeric') {
      filterValue = value === '' ? null : Number(value)
      filterValue2 = value2 === '' ? undefined : Number(value2)
    }

    onApply({
      column: selectedColumn.name,
      operator: op,
      value: filterValue,
      value2: filterValue2,
    })

    onOpenChange(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && step === 'value') {
      e.preventDefault()
      handleApply()
    }
    // Backspace to go back when input is empty
    if (e.key === 'Backspace' && step === 'value' && value === '' && value2 === '') {
      e.preventDefault()
      goBack()
    }
  }

  // Handle backspace in command input to go back
  const handleCommandKeyDown = (e: React.KeyboardEvent) => {
    const input = e.target as HTMLInputElement
    if (e.key === 'Backspace' && input.value === '' && step !== 'column') {
      e.preventDefault()
      goBack()
    }
    // Escape to close
    if (e.key === 'Escape') {
      onOpenChange(false)
    }
  }

  const category = selectedColumn ? getFilterCategory(selectedColumn.type) : null
  const operators = category ? getOperatorsForCategory(category) : []
  const needsSecondValue = selectedOperator && ['between', 'date_between'].includes(selectedOperator)

  // Group columns by category for display
  const columnsByCategory = React.useMemo(() => {
    const grouped: Record<FilterCategory, ColumnInfo[]> = {
      text: [],
      numeric: [],
      date: [],
      boolean: [],
      unknown: [],
    }
    columns
      .filter(c => !c.name.startsWith('_cs_')) // Hide internal columns
      .forEach(col => {
        const cat = getFilterCategory(col.type)
        grouped[cat].push(col)
      })
    return grouped
  }, [columns])

  const renderBreadcrumb = () => {
    return (
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-muted/30">
        {step !== 'column' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={goBack}
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Go back</span>
          </Button>
        )}

        <div className="flex items-center gap-2 text-sm">
          {step === 'column' && (
            <span className="text-muted-foreground">Select a column to filter</span>
          )}

          {step === 'operator' && selectedColumn && (
            <>
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">
                  {categoryIcons[getFilterCategory(selectedColumn.type)]}
                </span>
                <span className="font-mono font-medium">{selectedColumn.name}</span>
              </span>
              <span className="text-muted-foreground/70">→</span>
              <span className="text-muted-foreground">condition</span>
            </>
          )}

          {step === 'value' && selectedColumn && selectedOperator && (
            <>
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">
                  {categoryIcons[getFilterCategory(selectedColumn.type)]}
                </span>
                <span className="font-mono font-medium">{selectedColumn.name}</span>
              </span>
              <span className="text-muted-foreground/70">→</span>
              <span className="text-muted-foreground">{getOperatorLabel(selectedOperator)}</span>
            </>
          )}
        </div>
      </div>
    )
  }

  // Animation classes based on direction
  const slideAnimation = direction === 'forward'
    ? 'animate-in slide-in-from-right-4 fade-in duration-200'
    : 'animate-in slide-in-from-left-4 fade-in duration-200'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 gap-0 max-w-md overflow-hidden"
        onKeyDown={handleCommandKeyDown}
      >
        <DialogTitle className="sr-only">
          {existingFilter ? 'Edit Filter' : 'Add Filter'}
        </DialogTitle>

        {renderBreadcrumb()}

        <div className="min-h-[320px] flex flex-col">
          {/* Step 1: Column Selection */}
          {step === 'column' && (
            <div key="column" className={cn("flex-1 flex flex-col", slideAnimation)}>
              <Command className="rounded-none border-0 flex-1 flex flex-col">
                <CommandInput
                  ref={commandInputRef}
                  placeholder="Search columns..."
                  autoFocus
                  className="h-12"
                />
                <CommandList className="max-h-[260px] flex-1">
                  <CommandEmpty>No columns found.</CommandEmpty>
                  {Object.entries(columnsByCategory).map(([cat, cols]) => {
                    if (cols.length === 0) return null
                    return (
                      <CommandGroup key={cat} heading={categoryLabels[cat as FilterCategory]}>
                        {cols.map((col) => (
                          <CommandItem
                            key={col.name}
                            value={col.name}
                            onSelect={() => handleColumnSelect(col)}
                            className="gap-3 py-2.5 cursor-pointer"
                          >
                            <span className="text-muted-foreground">
                              {categoryIcons[cat as FilterCategory]}
                            </span>
                            <span className="font-mono text-sm">{col.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground/60 font-normal">
                              {col.type}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )
                  })}
                </CommandList>
              </Command>
            </div>
          )}

          {/* Step 2: Operator Selection */}
          {step === 'operator' && (
            <div key="operator" className={cn("flex-1 flex flex-col", slideAnimation)}>
              <Command className="rounded-none border-0 flex-1 flex flex-col">
                <CommandInput
                  placeholder="Select condition..."
                  autoFocus
                  className="h-12"
                />
                <CommandList className="max-h-[260px] flex-1">
                  <CommandEmpty>No operators found.</CommandEmpty>
                  <CommandGroup>
                    {operators.map((op) => (
                      <CommandItem
                        key={op}
                        value={`${op} ${getOperatorLabel(op)}`}
                        onSelect={() => handleOperatorSelect(op)}
                        className="gap-3 py-2.5 cursor-pointer"
                      >
                        <div className="w-4 flex justify-center">
                          {selectedOperator === op && (
                            <Check className="h-4 w-4 text-primary" />
                          )}
                        </div>
                        <span className="text-sm">{getOperatorLabel(op)}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              {/* Backspace hint */}
              <div className="px-3 py-2.5 border-t border-border/30 text-xs text-muted-foreground/70 flex items-center">
                <kbd className="inline-flex items-center justify-center px-2 py-1 bg-muted/70 rounded text-[11px] font-medium tracking-tight">Backspace</kbd>
                <span className="ml-2">to go back</span>
              </div>
            </div>
          )}

          {/* Step 3: Value Input */}
          {step === 'value' && (
            <div key="value" className={cn("flex-1 flex flex-col", slideAnimation)} onKeyDown={handleKeyDown}>
              <div className="p-4 space-y-4 flex-1">
                <div className="space-y-3">
                  <label className="text-sm text-muted-foreground">
                    {needsSecondValue ? 'Enter range values' : 'Enter filter value'}
                  </label>
                  <Input
                    ref={inputRef}
                    type={category === 'numeric' ? 'number' : category === 'date' ? 'date' : 'text'}
                    placeholder={needsSecondValue ? 'Min value...' : 'Enter value...'}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="h-11 font-mono"
                  />
                  {needsSecondValue && (
                    <Input
                      type={category === 'numeric' ? 'number' : 'date'}
                      placeholder="Max value..."
                      value={value2}
                      onChange={(e) => setValue2(e.target.value)}
                      className="h-11 font-mono"
                    />
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleApply()}
                    disabled={!value && !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(selectedOperator!)}
                  >
                    Apply Filter
                  </Button>
                </div>
              </div>
              {/* Keyboard hints */}
              <div className="px-3 py-2.5 border-t border-border/30 text-xs text-muted-foreground/70 flex items-center gap-5">
                <span className="flex items-center">
                  <kbd className="inline-flex items-center justify-center px-2 py-1 bg-muted/70 rounded text-[11px] font-medium tracking-tight">Backspace</kbd>
                  <span className="ml-2">back</span>
                </span>
                <span className="flex items-center">
                  <kbd className="inline-flex items-center justify-center px-2 py-1 bg-muted/70 rounded text-[11px] font-medium tracking-tight">Enter</kbd>
                  <span className="ml-2">apply</span>
                </span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
