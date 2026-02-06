import { memo, useMemo } from 'react'
import { Check, X, ChevronDown, ChevronUp, ArrowLeftRight, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { MatchPair } from '@/types'
import type { MatchClassification } from '@/stores/matcherStore'

interface MatchRowProps {
  pair: MatchPair
  matchColumn: string
  classification: MatchClassification
  isSelected: boolean
  isExpanded: boolean
  onToggleSelect: () => void
  onToggleExpand: () => void
  onMerge: () => void
  onKeepSeparate: () => void
  onSwapKeepRow: () => void
  onRevertToPending: () => void
}

// Soft shadow card with thin left accent
const classStyles: Record<MatchClassification, string> = {
  definite: 'shadow-sm hover:shadow-md border-l-[3px] border-l-[hsl(var(--matcher-definite))]',
  maybe: 'shadow-sm hover:shadow-md border-l-[3px] border-l-[hsl(var(--matcher-maybe))]',
  not_match: 'shadow-sm hover:shadow-md',
}

// Similarity badge styles
const badgeStyles: Record<MatchClassification, string> = {
  definite: 'bg-[hsl(var(--matcher-definite)/0.12)] text-[hsl(var(--matcher-definite))] border-[hsl(var(--matcher-definite)/0.2)] hover:bg-[hsl(var(--matcher-definite)/0.12)]',
  maybe: 'bg-[hsl(var(--matcher-maybe)/0.12)] text-[hsl(var(--matcher-maybe))] border-[hsl(var(--matcher-maybe)/0.2)] hover:bg-[hsl(var(--matcher-maybe)/0.12)]',
  not_match: 'bg-muted text-muted-foreground border-transparent hover:bg-muted',
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value === '') return '(empty)'
  return String(value)
}

function ValueCell({ value, isKeep, status }: { value: unknown; isKeep: boolean; status: string }) {
  const formatted = formatValue(value)
  const isTruncated = formatted.length > 40
  const display = isTruncated ? formatted.slice(0, 37) + '...' : formatted

  const textClass = cn(
    'text-[13px] tabular-nums',
    // Keep side: full visibility hierarchy
    isKeep && status === 'different' && 'text-foreground font-medium',
    isKeep && status === 'similar' && 'text-foreground/80',
    isKeep && status === 'exact' && 'text-muted-foreground/60',
    // Remove side: consistently dimmed across all statuses
    !isKeep && status === 'different' && 'text-foreground/50 font-medium',
    !isKeep && status === 'similar' && 'text-foreground/40',
    !isKeep && status === 'exact' && 'text-muted-foreground/35',
  )

  if (isTruncated) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(textClass, 'cursor-help border-b border-dotted border-muted-foreground/30')}>
            {display}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs break-all">
          {formatted}
        </TooltipContent>
      </Tooltip>
    )
  }

  return <span className={cn(textClass, 'truncate block')}>{display}</span>
}

/** Status glyph: visible symbol instead of tiny dot */
function StatusGlyph({ status }: { status: string }) {
  if (status === 'different') {
    return <span className="text-[11px] font-bold text-[hsl(var(--matcher-field-different))]">&ne;</span>
  }
  if (status === 'similar') {
    return <span className="text-[11px] text-[hsl(var(--matcher-field-similar))]">&asymp;</span>
  }
  return <span className="text-[11px] text-muted-foreground/25">=</span>
}

export const MatchRow = memo(function MatchRow({
  pair,
  matchColumn,
  classification,
  isSelected,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
  onMerge,
  onKeepSeparate,
  onSwapKeepRow,
  onRevertToPending,
}: MatchRowProps) {
  const isReviewed = pair.status !== 'pending'
  const matchFieldSimilarity = useMemo(
    () => pair.fieldSimilarities.find((f) => f.column === matchColumn),
    [pair.fieldSimilarities, matchColumn]
  )

  const explanation = useMemo(() => {
    const exact = pair.fieldSimilarities.filter((f) => f.status === 'exact').length
    const similar = pair.fieldSimilarities.filter((f) => f.status === 'similar').length
    const different = pair.fieldSimilarities.filter((f) => f.status === 'different').length
    const parts: string[] = []
    if (exact > 0) parts.push(`${exact} exact`)
    if (similar > 0) parts.push(`${similar} similar`)
    if (different > 0) parts.push(`${different} different`)
    return parts.join(' \u00b7 ')
  }, [pair.fieldSimilarities])

  // Sort fields: different first, then similar, then exact (attention hierarchy)
  const sortedFields = useMemo(() => {
    const order: Record<string, number> = { different: 0, similar: 1, exact: 2 }
    return [...pair.fieldSimilarities].sort(
      (a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2)
    )
  }, [pair.fieldSimilarities])

  return (
    <div className={cn(
      'rounded-xl bg-card transition-all duration-200 overflow-hidden',
      classStyles[classification],
      isExpanded && 'shadow-lg'
    )}>
      {/* Summary Row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
          className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
        />

        <button
          className="flex-1 flex items-center gap-3 text-left min-w-0"
          onClick={onToggleExpand}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn(
                'text-sm truncate',
                pair.keepRow === 'A' ? 'font-medium text-foreground' : 'text-muted-foreground/60'
              )}>
                {matchFieldSimilarity ? formatValue(matchFieldSimilarity.valueA) : formatValue(pair.rowA[matchColumn])}
              </span>
              <span
                role="button"
                tabIndex={0}
                className="shrink-0 hover:bg-muted rounded p-0.5 transition-colors cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  onSwapKeepRow()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    onSwapKeepRow()
                  }
                }}
                title="Swap which row to keep"
              >
                <ArrowLeftRight className="w-3 h-3 text-muted-foreground/40" />
              </span>
              <span className={cn(
                'text-sm truncate',
                pair.keepRow === 'B' ? 'font-medium text-foreground' : 'text-muted-foreground/60'
              )}>
                {matchFieldSimilarity ? formatValue(matchFieldSimilarity.valueB) : formatValue(pair.rowB[matchColumn])}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              {explanation}
            </p>
          </div>

          {/* Similarity Badge */}
          <Badge variant="outline" className={cn('tabular-nums shrink-0', badgeStyles[classification])}>
            {pair.similarity}%
          </Badge>

          <div className={cn(
            'p-1 rounded-md transition-colors',
            isExpanded ? 'bg-muted' : ''
          )}>
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
          </div>
        </button>

        {/* Action Buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          {isReviewed ? (
            <>
              <Badge
                variant="outline"
                className={cn(
                  'text-xs mr-1',
                  pair.status === 'merged'
                    ? 'bg-[hsl(var(--matcher-definite)/0.12)] text-[hsl(var(--matcher-definite))] border-[hsl(var(--matcher-definite)/0.2)]'
                    : 'bg-muted text-muted-foreground border-transparent'
                )}
              >
                {pair.status === 'merged' ? 'Merged' : 'Kept'}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg hover:bg-muted transition-all"
                onClick={onRevertToPending}
                title="Undo decision"
              >
                <Undo2 className="w-4 h-4 text-muted-foreground" />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg hover:bg-[hsl(var(--matcher-definite)/0.1)] transition-all"
                onClick={onMerge}
                title="Review as merge (M)"
              >
                <Check className="w-4 h-4 text-[hsl(var(--matcher-definite))]" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg hover:bg-muted transition-all"
                onClick={onKeepSeparate}
                title="Review as keep (K)"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Expanded: Inline Comparison Table */}
      {isExpanded && (
        <div className="px-4 pb-4">
          {/* Column headers with inline swap */}
          <div className="grid grid-cols-[minmax(100px,0.8fr),minmax(0,1fr),80px,minmax(0,1fr)] gap-x-3 items-center px-3 py-2 mb-1">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Field</span>
            <span className={cn(
              'text-[11px] font-medium uppercase tracking-wider text-right',
              pair.keepRow === 'A'
                ? 'text-[hsl(var(--matcher-definite))]'
                : 'text-muted-foreground/70'
            )}>
              {pair.keepRow === 'A' ? 'Keep' : 'Remove'}
            </span>
            {/* Swap — the visual anchor between the two columns */}
            <button
              className={cn(
                'flex items-center justify-center gap-1.5 px-3 py-1 rounded-full mx-auto',
                'bg-secondary border border-border',
                'hover:bg-accent hover:border-primary/40 hover:text-foreground',
                'text-[11px] font-medium text-muted-foreground',
                'transition-all duration-200',
              )}
              onClick={(e) => {
                e.stopPropagation()
                onSwapKeepRow()
              }}
              title="Swap which row to keep"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              Swap
            </button>
            <span className={cn(
              'text-[11px] font-medium uppercase tracking-wider',
              pair.keepRow === 'B'
                ? 'text-[hsl(var(--matcher-definite))]'
                : 'text-muted-foreground/70'
            )}>
              {pair.keepRow === 'B' ? 'Keep' : 'Remove'}
            </span>
          </div>

          {/* Field rows */}
          <div className="rounded-lg overflow-hidden space-y-px">
            {sortedFields.map((field, index) => {
              const isDifferent = field.status === 'different'
              const isSimilar = field.status === 'similar'
              const isExact = field.status === 'exact'

              return (
                <div
                  key={field.column}
                  className={cn(
                    'grid grid-cols-[minmax(100px,0.8fr),minmax(0,1fr),80px,minmax(0,1fr)] gap-x-3 items-baseline px-3 py-2 rounded-lg',
                    'animate-in fade-in-0 duration-150',
                    // Different: strong visible background
                    isDifferent && 'bg-[hsl(var(--matcher-field-different)/0.12)]',
                    // Similar: moderate visible background
                    isSimilar && 'bg-[hsl(var(--matcher-field-similar)/0.08)]',
                    // Exact: plain, no decoration
                    isExact && 'opacity-60',
                  )}
                  style={{ animationDelay: `${index * 15}ms` }}
                >
                  {/* Field name */}
                  <span className={cn(
                    'text-[12px] truncate',
                    isDifferent && 'text-[hsl(var(--matcher-field-different))] font-semibold',
                    isSimilar && 'text-[hsl(var(--matcher-field-similar))] font-medium',
                    isExact && 'text-muted-foreground',
                    field.column === matchColumn && 'font-bold'
                  )}>
                    {field.column}
                  </span>

                  {/* Value A */}
                  <ValueCell
                    value={field.valueA}
                    isKeep={pair.keepRow === 'A'}
                    status={field.status}
                  />

                  {/* Status glyph */}
                  <div className="flex justify-center">
                    <StatusGlyph status={field.status} />
                  </div>

                  {/* Value B */}
                  <ValueCell
                    value={field.valueB}
                    isKeep={pair.keepRow === 'B'}
                    status={field.status}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})
