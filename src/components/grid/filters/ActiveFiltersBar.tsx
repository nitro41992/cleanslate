import { X, Filter } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ColumnFilter } from '@/types'
import { formatFilterForDisplay } from '@/lib/duckdb/filter-builder'

interface ActiveFiltersBarProps {
  filters: ColumnFilter[]
  filteredCount: number | null
  totalCount: number
  sortColumn: string | null
  sortDirection: 'asc' | 'desc'
  onRemoveFilter: (column: string) => void
  onClearAllFilters: () => void
  onClearSort: () => void
}

export function ActiveFiltersBar({
  filters,
  filteredCount,
  totalCount,
  sortColumn,
  sortDirection,
  onRemoveFilter,
  onClearAllFilters,
  onClearSort,
}: ActiveFiltersBarProps) {
  const hasFilters = filters.length > 0
  const hasSortOrFilters = hasFilters || sortColumn

  if (!hasSortOrFilters) {
    return null
  }

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b border-border/50 flex-wrap"
      data-testid="active-filters-bar"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">
          {filteredCount !== null && filteredCount !== totalCount ? (
            <>
              {filteredCount.toLocaleString()} of {totalCount.toLocaleString()} rows
            </>
          ) : (
            <>{totalCount.toLocaleString()} rows</>
          )}
        </span>
      </div>

      {/* Sort indicator */}
      {sortColumn && (
        <Badge
          variant="secondary"
          className="gap-1 pr-1 text-xs font-normal"
        >
          <span>
            Sorted by {sortColumn} ({sortDirection === 'asc' ? 'A→Z' : 'Z→A'})
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={onClearSort}
          >
            <X className="h-3 w-3" />
            <span className="sr-only">Clear sort</span>
          </Button>
        </Badge>
      )}

      {/* Filter badges */}
      {filters.map((filter) => (
        <Badge
          key={filter.column}
          variant="secondary"
          className="gap-1 pr-1 text-xs font-normal"
        >
          <span>{formatFilterForDisplay(filter)}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => onRemoveFilter(filter.column)}
          >
            <X className="h-3 w-3" />
            <span className="sr-only">Remove filter</span>
          </Button>
        </Badge>
      ))}

      {/* Clear all button */}
      {(hasFilters || sortColumn) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (hasFilters) onClearAllFilters()
            if (sortColumn) onClearSort()
          }}
        >
          Clear all
        </Button>
      )}
    </div>
  )
}
