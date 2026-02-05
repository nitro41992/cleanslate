import * as React from 'react'
import { Plus, X, Filter, ArrowUpDown, Hash, Calendar, Type, ToggleLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ColumnFilter, ColumnInfo } from '@/types'
import {
  formatFilterForDisplay,
  getFilterCategory,
  type FilterCategory,
} from '@/lib/duckdb/filter-builder'
import { FilterCommand } from './FilterCommand'

interface FilterBarProps {
  columns: ColumnInfo[]
  filters: ColumnFilter[]
  filteredCount: number | null
  totalCount: number
  sortColumn: string | null
  sortDirection: 'asc' | 'desc'
  onSetFilter: (filter: ColumnFilter) => void
  onRemoveFilter: (column: string) => void
  onClearAllFilters: () => void
  onClearSort: () => void
}

const categoryColors: Record<FilterCategory, string> = {
  text: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  numeric: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  date: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  boolean: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  unknown: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
}

const categoryIcons: Record<FilterCategory, React.ReactNode> = {
  text: <Type className="h-3 w-3" />,
  numeric: <Hash className="h-3 w-3" />,
  date: <Calendar className="h-3 w-3" />,
  boolean: <ToggleLeft className="h-3 w-3" />,
  unknown: <Type className="h-3 w-3" />,
}

export function FilterBar({
  columns,
  filters,
  filteredCount,
  totalCount,
  sortColumn,
  sortDirection,
  onSetFilter,
  onRemoveFilter,
  onClearAllFilters,
  onClearSort,
}: FilterBarProps) {
  const [commandOpen, setCommandOpen] = React.useState(false)
  const [editingFilter, setEditingFilter] = React.useState<ColumnFilter | undefined>()

  const hasFilters = filters.length > 0
  const hasSort = Boolean(sortColumn)
  const hasAny = hasFilters || hasSort

  // Keyboard shortcut: F to open filter dialog (when not in an input)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const target = e.target as HTMLElement
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (!isTyping && e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setEditingFilter(undefined)
        setCommandOpen(true)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleAddFilter = () => {
    setEditingFilter(undefined)
    setCommandOpen(true)
  }

  const handleEditFilter = (filter: ColumnFilter) => {
    setEditingFilter(filter)
    setCommandOpen(true)
  }

  const handleApplyFilter = (filter: ColumnFilter) => {
    onSetFilter(filter)
  }

  const handleClearAll = () => {
    if (hasFilters) onClearAllFilters()
    if (hasSort) onClearSort()
  }

  // Get column type for a filter
  const getColumnCategory = (columnName: string): FilterCategory => {
    const col = columns.find(c => c.name === columnName)
    return col ? getFilterCategory(col.type) : 'unknown'
  }

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 border-b border-border/50 flex-wrap',
          hasAny ? 'bg-muted/30' : 'bg-transparent'
        )}
        data-testid="filter-bar"
      >
        {/* Row count indicator */}
        <div className="flex items-center gap-1.5 text-muted-foreground mr-1">
          <Filter className="h-3.5 w-3.5" />
          <span className="text-xs tabular-nums">
            {filteredCount !== null && filteredCount !== totalCount ? (
              <>
                <span className="text-foreground font-medium">{filteredCount.toLocaleString()}</span>
                <span className="mx-0.5">/</span>
                <span>{totalCount.toLocaleString()}</span>
              </>
            ) : (
              <span>{totalCount.toLocaleString()} rows</span>
            )}
          </span>
        </div>

        {/* Sort chip */}
        {sortColumn && (
          <FilterChip
            icon={<ArrowUpDown className="h-3 w-3" />}
            label={`${sortColumn} ${sortDirection === 'asc' ? '↑' : '↓'}`}
            colorClass="bg-zinc-500/10 text-zinc-300 border-zinc-500/20"
            onRemove={onClearSort}
          />
        )}

        {/* Filter chips */}
        {filters.map((filter) => {
          const category = getColumnCategory(filter.column)
          return (
            <FilterChip
              key={filter.column}
              icon={categoryIcons[category]}
              label={formatFilterForDisplay(filter)}
              colorClass={categoryColors[category]}
              onClick={() => handleEditFilter(filter)}
              onRemove={() => onRemoveFilter(filter.column)}
            />
          )
        })}

        {/* Add filter button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5 border-dashed border-muted-foreground/30 text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 hover:bg-muted/50"
              onClick={handleAddFilter}
            >
              <Plus className="h-3.5 w-3.5" />
              Add filter
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            <p className="text-xs">Filter data by column values</p>
            <p className="text-xs text-muted-foreground mt-0.5">Press <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">F</kbd> for quick access</p>
          </TooltipContent>
        </Tooltip>

        {/* Clear all button */}
        {hasAny && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground ml-auto"
            onClick={handleClearAll}
          >
            Clear all
          </Button>
        )}
      </div>

      <FilterCommand
        open={commandOpen}
        onOpenChange={setCommandOpen}
        columns={columns}
        existingFilter={editingFilter}
        onApply={handleApplyFilter}
      />
    </>
  )
}

interface FilterChipProps {
  icon: React.ReactNode
  label: string
  colorClass: string
  onClick?: () => void
  onRemove: () => void
}

function FilterChip({ icon, label, colorClass, onClick, onRemove }: FilterChipProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md border text-xs',
        'transition-colors',
        colorClass,
        onClick && 'cursor-pointer hover:brightness-110'
      )}
      onClick={onClick}
    >
      <span className="opacity-70">{icon}</span>
      <span className="font-mono text-[11px] max-w-[200px] truncate">{label}</span>
      <button
        className="ml-0.5 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        <X className="h-3 w-3" />
        <span className="sr-only">Remove</span>
      </button>
    </div>
  )
}
