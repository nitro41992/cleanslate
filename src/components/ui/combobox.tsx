import * as React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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

interface ColumnComboboxProps {
  columns: string[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** Controlled open state */
  open?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
  /** Auto-focus the search input when opened */
  autoFocus?: boolean
}

export function ColumnCombobox({
  columns,
  value,
  onValueChange,
  placeholder = 'Select column...',
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  autoFocus = false,
}: ColumnComboboxProps) {
  const [internalOpen, setInternalOpen] = React.useState(false)

  // Use controlled state if provided, otherwise internal
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen
  const setOpen = (newOpen: boolean) => {
    setInternalOpen(newOpen)
    onOpenChange?.(newOpen)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
          data-testid="column-selector"
        >
          {value || placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder="Search columns..." autoFocus={autoFocus} />
          <CommandList>
            <CommandEmpty>No column found.</CommandEmpty>
            <CommandGroup>
              {columns.map((col) => (
                <CommandItem
                  key={col}
                  value={col}
                  onSelect={() => {
                    onValueChange(col)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === col ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {col}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
