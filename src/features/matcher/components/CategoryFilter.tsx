import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

const countColors: Record<string, string> = {
  definite: 'text-[hsl(var(--matcher-definite))]',
  maybe: 'text-[hsl(var(--matcher-maybe))]',
  not_match: 'text-[hsl(var(--matcher-not-match))]',
}

export function CategoryFilter({
  currentFilter,
  onFilterChange,
  counts,
}: CategoryFilterProps) {
  const filters: { value: MatchFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'definite', label: 'Definite', count: counts.definite },
    { value: 'maybe', label: 'Maybe', count: counts.maybe },
    { value: 'not_match', label: 'Not Match', count: counts.notMatch },
  ]

  return (
    <Tabs value={currentFilter} onValueChange={(v) => onFilterChange(v as MatchFilter)}>
      <TabsList>
        {filters.map((filter) => (
          <TabsTrigger key={filter.value} value={filter.value} className="gap-1.5">
            {filter.label}
            <span className={cn(
              'tabular-nums text-[11px]',
              currentFilter === filter.value && filter.value !== 'all' && countColors[filter.value]
            )}>
              {filter.count}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
