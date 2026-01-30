import * as React from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface MultiColumnComboboxProps {
  /** Available columns to select from */
  columns: string[]
  /** Currently selected column names (order is preserved) */
  value: string[]
  /** Callback when selection changes */
  onValueChange: (values: string[]) => void
  /** Placeholder text when no columns selected */
  placeholder?: string
  /** Disable the combobox */
  disabled?: boolean
  /** Minimum columns required for validation */
  minColumns?: number
  /** Controlled open state */
  open?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
}

export function MultiColumnCombobox({
  columns,
  value,
  onValueChange,
  placeholder = 'Select columns...',
  disabled = false,
  minColumns = 2,
  open: controlledOpen,
  onOpenChange,
}: MultiColumnComboboxProps) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const [searchValue, setSearchValue] = React.useState('')

  // Use controlled state if provided, otherwise internal
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen
  const setOpen = (newOpen: boolean) => {
    setInternalOpen(newOpen)
    onOpenChange?.(newOpen)
    // Clear search when closing
    if (!newOpen) {
      setSearchValue('')
    }
  }

  const handleSelect = (column: string) => {
    if (value.includes(column)) {
      // Remove column if already selected
      onValueChange(value.filter((v) => v !== column))
    } else {
      // Add column to selection (maintains order)
      onValueChange([...value, column])
    }
    // Clear search input so user can immediately type next column
    setSearchValue('')
  }

  const handleRemove = (column: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onValueChange(value.filter((v) => v !== column))
  }

  // Columns not yet selected (available for selection)
  const availableColumns = columns.filter((col) => !value.includes(col))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between min-h-[40px] h-auto',
            value.length === 0 && 'text-muted-foreground'
          )}
          data-testid="multi-column-selector"
        >
          <div className="flex flex-wrap gap-1 flex-1">
            {value.length === 0 ? (
              <span>{placeholder}</span>
            ) : (
              value.map((col) => (
                <Badge
                  key={col}
                  variant="secondary"
                  className="gap-1 pr-1 text-xs"
                >
                  {col}
                  <X
                    className="w-3 h-3 cursor-pointer hover:text-destructive transition-colors"
                    onClick={(e) => handleRemove(col, e)}
                  />
                </Badge>
              ))
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput
            placeholder="Search columns..."
            value={searchValue}
            onValueChange={setSearchValue}
          />
          <CommandList>
            <CommandEmpty>No column found.</CommandEmpty>
            <CommandGroup>
              {/* Show selected columns first with checkmarks */}
              {value.map((col) => (
                <CommandItem
                  key={col}
                  value={col}
                  onSelect={() => handleSelect(col)}
                >
                  <Check className="mr-2 h-4 w-4 opacity-100" />
                  <span className="font-medium">{col}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    #{value.indexOf(col) + 1}
                  </span>
                </CommandItem>
              ))}
              {/* Then available columns */}
              {availableColumns.map((col) => (
                <CommandItem
                  key={col}
                  value={col}
                  onSelect={() => handleSelect(col)}
                >
                  <Check className="mr-2 h-4 w-4 opacity-0" />
                  {col}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {/* Selection hint */}
        {value.length > 0 && value.length < minColumns && (
          <div className="px-3 py-2 border-t text-xs text-muted-foreground">
            Select at least {minColumns} columns to combine
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
