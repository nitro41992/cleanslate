import { cn } from '@/lib/utils'
import type { MatchFilter } from '@/stores/matcherStore'

interface CategoryFilterProps {
  currentFilter: MatchFilter
  onFilterChange: (filter: MatchFilter) => void
  counts: {
    all: number
    definite: number
    maybe: number
    notMatch: number
  }
}

export function CategoryFilter({
  currentFilter,
  onFilterChange,
  counts,
}: CategoryFilterProps) {
  const filters: { value: MatchFilter; label: string; count: number; color: string }[] = [
    { value: 'all', label: 'All', count: counts.all, color: '' },
    { value: 'definite', label: 'Definite', count: counts.definite, color: 'bg-green-950/40 data-[active=true]:bg-green-900/50' },
    { value: 'maybe', label: 'Maybe', count: counts.maybe, color: 'bg-yellow-950/40 data-[active=true]:bg-yellow-900/50' },
    { value: 'not_match', label: 'Not Match', count: counts.notMatch, color: 'bg-red-950/40 data-[active=true]:bg-red-900/50' },
  ]

  return (
    <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
      {filters.map((filter) => (
        <button
          key={filter.value}
          onClick={() => onFilterChange(filter.value)}
          data-active={currentFilter === filter.value}
          className={cn(
            'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
            'hover:bg-muted',
            filter.color,
            currentFilter === filter.value
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground'
          )}
        >
          {filter.label} ({filter.count})
        </button>
      ))}
    </div>
  )
}
