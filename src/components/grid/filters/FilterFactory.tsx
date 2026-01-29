import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { FilterOperator } from '@/types'
import { getOperatorLabel, type FilterCategory } from '@/lib/duckdb/filter-builder'

interface FilterFactoryProps {
  category: FilterCategory
  operators: FilterOperator[]
  selectedOperator: FilterOperator
  value: string | number | boolean | null
  value2?: string | number
  onOperatorChange: (operator: FilterOperator) => void
  onValueChange: (value: string | number | boolean | null) => void
  onValue2Change: (value: string | number | undefined) => void
  onApply: () => void
}

export function FilterFactory({
  category,
  operators,
  selectedOperator,
  value,
  value2,
  onOperatorChange,
  onValueChange,
  onValue2Change,
  onApply,
}: FilterFactoryProps) {
  // Handle Enter key in inputs
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onApply()
    }
  }

  // Determine if the selected operator needs a value input
  const needsValue = !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(selectedOperator)
  const needsSecondValue = ['between', 'date_between'].includes(selectedOperator)

  // Render operator selector for non-boolean types
  const renderOperatorSelect = () => {
    if (category === 'boolean') {
      return null // Boolean uses radio buttons instead
    }

    return (
      <div className="px-2 mb-2">
        <Select
          value={selectedOperator}
          onValueChange={(val) => onOperatorChange(val as FilterOperator)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operators.map((op) => (
              <SelectItem key={op} value={op} className="text-xs">
                {getOperatorLabel(op)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  // Render value input based on category
  const renderValueInput = () => {
    if (!needsValue) {
      return null
    }

    switch (category) {
      case 'text':
        return (
          <div className="px-2">
            <Input
              type="text"
              placeholder="Filter value..."
              value={String(value ?? '')}
              onChange={(e) => onValueChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-8 text-sm"
              autoFocus
            />
          </div>
        )

      case 'numeric':
        return (
          <div className="px-2 space-y-2">
            <Input
              type="number"
              placeholder={needsSecondValue ? 'Min value...' : 'Filter value...'}
              value={value === null || value === '' ? '' : String(value)}
              onChange={(e) => {
                const val = e.target.value
                onValueChange(val === '' ? null : Number(val))
              }}
              onKeyDown={handleKeyDown}
              className="h-8 text-sm"
              autoFocus
            />
            {needsSecondValue && (
              <Input
                type="number"
                placeholder="Max value..."
                value={value2 === undefined ? '' : String(value2)}
                onChange={(e) => {
                  const val = e.target.value
                  onValue2Change(val === '' ? undefined : Number(val))
                }}
                onKeyDown={handleKeyDown}
                className="h-8 text-sm"
              />
            )}
          </div>
        )

      case 'date':
        return (
          <div className="px-2 space-y-2">
            {selectedOperator === 'last_n_days' ? (
              <Input
                type="number"
                placeholder="Number of days..."
                min={1}
                value={value === null || value === '' ? '' : String(value)}
                onChange={(e) => {
                  const val = e.target.value
                  onValueChange(val === '' ? null : Number(val))
                }}
                onKeyDown={handleKeyDown}
                className="h-8 text-sm"
                autoFocus
              />
            ) : (
              <>
                <Input
                  type="date"
                  value={String(value ?? '')}
                  onChange={(e) => onValueChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="h-8 text-sm"
                  autoFocus
                />
                {needsSecondValue && (
                  <Input
                    type="date"
                    value={String(value2 ?? '')}
                    onChange={(e) => onValue2Change(e.target.value || undefined)}
                    onKeyDown={handleKeyDown}
                    className="h-8 text-sm"
                  />
                )}
              </>
            )}
          </div>
        )

      case 'boolean':
        // Boolean uses radio buttons, handled separately
        return null

      default:
        // Unknown type - use text input
        return (
          <div className="px-2">
            <Input
              type="text"
              placeholder="Filter value..."
              value={String(value ?? '')}
              onChange={(e) => onValueChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-8 text-sm"
              autoFocus
            />
          </div>
        )
    }
  }

  // Render boolean filter as radio buttons
  const renderBooleanFilter = () => {
    if (category !== 'boolean') {
      return null
    }

    return (
      <div className="px-2">
        <RadioGroup
          value={selectedOperator}
          onValueChange={(val) => onOperatorChange(val as FilterOperator)}
          className="space-y-1"
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="is_true" id="filter-true" />
            <Label htmlFor="filter-true" className="text-sm font-normal cursor-pointer">
              True
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="is_false" id="filter-false" />
            <Label htmlFor="filter-false" className="text-sm font-normal cursor-pointer">
              False
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="is_empty" id="filter-empty" />
            <Label htmlFor="filter-empty" className="text-sm font-normal cursor-pointer">
              Empty / NULL
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="is_not_empty" id="filter-not-empty" />
            <Label htmlFor="filter-not-empty" className="text-sm font-normal cursor-pointer">
              Not Empty
            </Label>
          </div>
        </RadioGroup>
      </div>
    )
  }

  return (
    <>
      {renderOperatorSelect()}
      {renderValueInput()}
      {renderBooleanFilter()}
    </>
  )
}
