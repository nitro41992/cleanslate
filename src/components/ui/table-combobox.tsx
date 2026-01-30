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

interface TableOption {
  id: string
  name: string
  rowCount: number
}

interface TableComboboxProps {
  tables: TableOption[]
  value: string | null
  onValueChange: (id: string, name: string) => void
  placeholder?: string
  disabled?: boolean
  /** IDs to exclude from the dropdown (e.g., already-selected tables) */
  excludeIds?: string[]
  /** Controlled open state */
  open?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
  /** Auto-focus the search input when opened */
  autoFocus?: boolean
}

export function TableCombobox({
  tables,
  value,
  onValueChange,
  placeholder = 'Select table...',
  disabled = false,
  excludeIds = [],
  open: controlledOpen,
  onOpenChange,
  autoFocus = false,
}: TableComboboxProps) {
  const [internalOpen, setInternalOpen] = React.useState(false)

  // Use controlled state if provided, otherwise internal
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen
  const setOpen = (newOpen: boolean) => {
    setInternalOpen(newOpen)
    onOpenChange?.(newOpen)
  }

  const filteredTables = tables.filter((t) => !excludeIds.includes(t.id))
  const selectedTable = tables.find((t) => t.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
          data-testid="table-selector"
        >
          <span className="truncate">
            {selectedTable ? selectedTable.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder="Search tables..." autoFocus={autoFocus} />
          <CommandList>
            <CommandEmpty>No table found.</CommandEmpty>
            <CommandGroup>
              {filteredTables.map((table) => (
                <CommandItem
                  key={table.id}
                  value={table.name}
                  onSelect={() => {
                    onValueChange(table.id, table.name)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      value === table.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1 truncate">{table.name}</span>
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">
                    {table.rowCount.toLocaleString()} rows
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
