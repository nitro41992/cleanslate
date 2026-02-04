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

interface Recipe {
  id: string
  name: string
  steps: { id: string }[]
}

interface RecipeComboboxProps {
  recipes: Recipe[]
  value: string | null
  onValueChange: (value: string | null) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

export function RecipeCombobox({
  recipes,
  value,
  onValueChange,
  placeholder = 'Select recipe...',
  disabled = false,
  className,
}: RecipeComboboxProps) {
  const [open, setOpen] = React.useState(false)

  const selectedRecipe = recipes.find((r) => r.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('justify-between bg-muted/30 border-border/50', className)}
          data-testid="recipe-selector"
        >
          <span className="truncate">
            {selectedRecipe ? selectedRecipe.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search recipes..." />
          <CommandList>
            <CommandEmpty>No recipe found.</CommandEmpty>
            <CommandGroup>
              {recipes.map((recipe) => (
                <CommandItem
                  key={recipe.id}
                  value={recipe.name}
                  onSelect={() => {
                    onValueChange(recipe.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === recipe.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">{recipe.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {recipe.steps.length} steps
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
