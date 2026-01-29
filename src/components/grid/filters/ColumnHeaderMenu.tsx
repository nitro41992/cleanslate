import * as React from 'react'
import { ArrowUp, ArrowDown, Filter, X } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { FilterFactory } from './FilterFactory'
import type { ColumnFilter, FilterOperator } from '@/types'
import { getFilterCategory, getOperatorsForCategory, type FilterCategory } from '@/lib/duckdb/filter-builder'

interface ColumnHeaderMenuProps {
  columnName: string
  columnType: string
  currentFilter?: ColumnFilter
  currentSortColumn: string | null
  currentSortDirection: 'asc' | 'desc'
  onSetFilter: (filter: ColumnFilter) => void
  onRemoveFilter: () => void
  onSetSort: (direction: 'asc' | 'desc') => void
  onClearSort: () => void
  children: React.ReactNode
}

export function ColumnHeaderMenu({
  columnName,
  columnType,
  currentFilter,
  currentSortColumn,
  currentSortDirection,
  onSetFilter,
  onRemoveFilter,
  onSetSort,
  onClearSort,
  children,
}: ColumnHeaderMenuProps) {
  const [open, setOpen] = React.useState(false)
  const [filterValue, setFilterValue] = React.useState<string | number | boolean | null>(
    currentFilter?.value ?? ''
  )
  const [filterValue2, setFilterValue2] = React.useState<string | number | undefined>(
    currentFilter?.value2
  )
  const [selectedOperator, setSelectedOperator] = React.useState<FilterOperator>(
    currentFilter?.operator ?? 'contains'
  )

  const filterCategory = getFilterCategory(columnType)
  const availableOperators = getOperatorsForCategory(filterCategory)
  const isColumnSorted = currentSortColumn === columnName
  const hasActiveFilter = Boolean(currentFilter)

  // Reset local state when filter changes externally
  React.useEffect(() => {
    if (currentFilter) {
      setFilterValue(currentFilter.value ?? '')
      setFilterValue2(currentFilter.value2)
      setSelectedOperator(currentFilter.operator)
    } else {
      setFilterValue('')
      setFilterValue2(undefined)
      // Set default operator based on category
      setSelectedOperator(getDefaultOperator(filterCategory))
    }
  }, [currentFilter, filterCategory])

  const handleApplyFilter = () => {
    // Don't apply empty filters (except for is_empty/is_not_empty/is_true/is_false)
    const noValueOperators: FilterOperator[] = ['is_empty', 'is_not_empty', 'is_true', 'is_false']
    if (!noValueOperators.includes(selectedOperator) && (filterValue === '' || filterValue === null)) {
      return
    }

    onSetFilter({
      column: columnName,
      operator: selectedOperator,
      value: filterValue,
      value2: filterValue2,
    })
    setOpen(false)
  }

  const handleClearFilter = () => {
    onRemoveFilter()
    setFilterValue('')
    setFilterValue2(undefined)
    setSelectedOperator(getDefaultOperator(filterCategory))
    setOpen(false)
  }

  const handleSort = (direction: 'asc' | 'desc') => {
    onSetSort(direction)
    setOpen(false)
  }

  const handleClearSort = () => {
    onClearSort()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        sideOffset={4}
      >
        {/* Sort Section */}
        <div className="p-2">
          <div className="text-xs font-medium text-muted-foreground mb-2 px-2">Sort</div>
          <Button
            variant={isColumnSorted && currentSortDirection === 'asc' ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start gap-2 h-8"
            onClick={() => handleSort('asc')}
          >
            <ArrowUp className="h-3.5 w-3.5" />
            Sort Ascending
          </Button>
          <Button
            variant={isColumnSorted && currentSortDirection === 'desc' ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start gap-2 h-8"
            onClick={() => handleSort('desc')}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Sort Descending
          </Button>
          {isColumnSorted && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-8 text-muted-foreground"
              onClick={handleClearSort}
            >
              <X className="h-3.5 w-3.5" />
              Clear Sort
            </Button>
          )}
        </div>

        <Separator />

        {/* Filter Section */}
        <div className="p-2">
          <div className="text-xs font-medium text-muted-foreground mb-2 px-2 flex items-center gap-1">
            <Filter className="h-3 w-3" />
            Filter
          </div>

          <FilterFactory
            category={filterCategory}
            operators={availableOperators}
            selectedOperator={selectedOperator}
            value={filterValue}
            value2={filterValue2}
            onOperatorChange={setSelectedOperator}
            onValueChange={setFilterValue}
            onValue2Change={setFilterValue2}
            onApply={handleApplyFilter}
          />

          <div className="flex gap-2 mt-3 px-2">
            <Button
              variant="default"
              size="sm"
              className="flex-1 h-8"
              onClick={handleApplyFilter}
            >
              Apply
            </Button>
            {hasActiveFilter && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={handleClearFilter}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function getDefaultOperator(category: FilterCategory): FilterOperator {
  switch (category) {
    case 'text':
      return 'contains'
    case 'numeric':
      return 'eq'
    case 'date':
      return 'date_eq'
    case 'boolean':
      return 'is_true'
    default:
      return 'contains'
  }
}
