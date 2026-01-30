import { memo, useMemo } from 'react'
import { Check, X, ChevronDown, ChevronUp, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { MatchPair, FieldSimilarity } from '@/types'
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
}

const classStyles = {
  definite: 'ring-green-500/30 bg-gradient-to-br from-green-500/5 to-transparent',
  maybe: 'ring-yellow-500/30 bg-gradient-to-br from-yellow-500/5 to-transparent',
  not_match: 'ring-red-500/30 bg-gradient-to-br from-red-500/5 to-transparent',
}

const similarityBadgeStyles = {
  definite: 'bg-green-500/15 text-green-400 ring-1 ring-green-500/30',
  maybe: 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30',
  not_match: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30',
}

// Color-coded border styles for field comparison
const fieldBorderStyles = {
  exact: 'border-l-2 border-l-green-500/60',
  similar: 'border-l-2 border-l-amber-500/60',
  different: 'border-l-2 border-l-red-500/60',
}

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}

function getFieldBorderStyle(field: FieldSimilarity): string {
  if (field.status === 'exact') return fieldBorderStyles.exact
  if (field.status === 'similar') return fieldBorderStyles.similar
  return fieldBorderStyles.different
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
}: MatchRowProps) {
  // Memoize expensive lookups
  const matchFieldSimilarity = useMemo(
    () => pair.fieldSimilarities.find((f) => f.column === matchColumn),
    [pair.fieldSimilarities, matchColumn]
  )

  // Memoize explanation calculation
  const explanation = useMemo(() => {
    const exactFields = pair.fieldSimilarities.filter((f) => f.status === 'exact')
    const similarFields = pair.fieldSimilarities.filter((f) => f.status === 'similar')
    const differentFields = pair.fieldSimilarities.filter((f) => f.status === 'different')

    const parts: string[] = []
    if (exactFields.length > 0) {
      parts.push(`${exactFields.length} field${exactFields.length > 1 ? 's' : ''} match exactly`)
    }
    if (similarFields.length > 0) {
      parts.push(`${similarFields.length} similar`)
    }
    if (differentFields.length > 0) {
      parts.push(`${differentFields.length} different`)
    }

    return parts.join(', ')
  }, [pair.fieldSimilarities])

  return (
    <div className={cn(
      'rounded-xl transition-all duration-200 ring-1 overflow-hidden',
      classStyles[classification],
      isExpanded && 'shadow-lg shadow-black/5'
    )}>
      {/* Summary Row */}
      <div className="flex items-center gap-2 p-3">
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
              <span className="text-sm font-medium truncate">
                {matchFieldSimilarity ? formatValue(matchFieldSimilarity.valueA) : formatValue(pair.rowA[matchColumn])}
              </span>
              <span className="text-muted-foreground/60 text-xs">vs</span>
              <span className="text-sm font-medium truncate">
                {matchFieldSimilarity ? formatValue(matchFieldSimilarity.valueB) : formatValue(pair.rowB[matchColumn])}
              </span>
            </div>
            {isExpanded && (
              <p className="text-xs text-muted-foreground mt-1">
                {explanation}
              </p>
            )}
          </div>

          {/* Similarity Badge - Enhanced */}
          <div
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium shrink-0 tabular-nums',
              similarityBadgeStyles[classification]
            )}
          >
            {pair.similarity}% Similar
          </div>

          <div className={cn(
            'p-1.5 rounded-md transition-colors',
            isExpanded ? 'bg-muted/50' : 'bg-transparent'
          )}>
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
          </div>
        </button>

        {/* Action Buttons - Enhanced with glow */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg hover:bg-green-500/20 hover:shadow-sm hover:shadow-green-500/20 transition-all"
            onClick={onMerge}
            title="Merge (M)"
          >
            <Check className="w-4 h-4 text-green-500" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg hover:bg-red-500/20 hover:shadow-sm hover:shadow-red-500/20 transition-all"
            onClick={onKeepSeparate}
            title="Keep Separate (K)"
          >
            <X className="w-4 h-4 text-red-500" />
          </Button>
        </div>
      </div>

      {/* Expanded Detail - Glass morphic container */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border/20">
          <div className="pt-4">
            {/* Side-by-Side Comparison with Swap Button */}
            <div className="grid grid-cols-[1fr,auto,1fr] gap-3">
              {/* Left Column - KEEPING or REMOVING */}
              <div
                className={cn(
                  'rounded-lg p-3 backdrop-blur-sm ring-1 transition-all',
                  pair.keepRow === 'A'
                    ? 'bg-green-500/5 ring-green-500/20'
                    : 'bg-red-500/5 ring-red-500/20'
                )}
              >
                <div className={cn(
                  'text-xs font-semibold mb-3 flex items-center gap-1.5 pb-2 border-b',
                  pair.keepRow === 'A'
                    ? 'text-green-400 border-green-500/20'
                    : 'text-red-400 border-red-500/20'
                )}>
                  <div className={cn(
                    'p-1 rounded',
                    pair.keepRow === 'A' ? 'bg-green-500/20' : 'bg-red-500/20'
                  )}>
                    {pair.keepRow === 'A' ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <X className="w-3 h-3" />
                    )}
                  </div>
                  {pair.keepRow === 'A' ? 'KEEPING' : 'REMOVING'}
                </div>
                <div className="space-y-1.5">
                  {pair.fieldSimilarities.map((field, index) => (
                    <div
                      key={field.column}
                      className={cn(
                        'pl-2 py-0.5 rounded-r text-xs animate-in fade-in-0 slide-in-from-left-1',
                        getFieldBorderStyle(field),
                        pair.keepRow === 'B' && 'opacity-60'
                      )}
                      style={{ animationDelay: `${index * 20}ms` }}
                    >
                      <span className="text-muted-foreground text-[11px]">{field.column}:</span>{' '}
                      <span className={cn(
                        'text-foreground',
                        field.column === matchColumn && 'font-medium'
                      )}>
                        {formatValue(field.valueA)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Swap Button - Circular glass effect */}
              <div className="flex items-center justify-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-10 w-10 rounded-full',
                    'bg-muted/30 backdrop-blur-sm ring-1 ring-border/30',
                    'hover:bg-muted/50 hover:ring-primary/30 hover:shadow-lg hover:shadow-primary/10',
                    'transition-all duration-200'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSwapKeepRow()
                  }}
                  title="Swap which row to keep"
                >
                  <ArrowLeftRight className="w-4 h-4 text-muted-foreground" />
                </Button>
              </div>

              {/* Right Column - KEEPING or REMOVING */}
              <div
                className={cn(
                  'rounded-lg p-3 backdrop-blur-sm ring-1 transition-all',
                  pair.keepRow === 'B'
                    ? 'bg-green-500/5 ring-green-500/20'
                    : 'bg-red-500/5 ring-red-500/20'
                )}
              >
                <div className={cn(
                  'text-xs font-semibold mb-3 flex items-center gap-1.5 pb-2 border-b',
                  pair.keepRow === 'B'
                    ? 'text-green-400 border-green-500/20'
                    : 'text-red-400 border-red-500/20'
                )}>
                  <div className={cn(
                    'p-1 rounded',
                    pair.keepRow === 'B' ? 'bg-green-500/20' : 'bg-red-500/20'
                  )}>
                    {pair.keepRow === 'B' ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <X className="w-3 h-3" />
                    )}
                  </div>
                  {pair.keepRow === 'B' ? 'KEEPING' : 'REMOVING'}
                </div>
                <div className="space-y-1.5">
                  {pair.fieldSimilarities.map((field, index) => (
                    <div
                      key={field.column}
                      className={cn(
                        'pl-2 py-0.5 rounded-r text-xs animate-in fade-in-0 slide-in-from-right-1',
                        getFieldBorderStyle(field),
                        pair.keepRow === 'A' && 'opacity-60'
                      )}
                      style={{ animationDelay: `${index * 20}ms` }}
                    >
                      <span className="text-muted-foreground text-[11px]">{field.column}:</span>{' '}
                      <span className={cn(
                        'text-foreground',
                        field.column === matchColumn && 'font-medium'
                      )}>
                        {formatValue(field.valueB)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Summary with legend */}
            <div className="mt-3 pt-3 border-t border-border/20 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-green-500/60" />
                <span>exact</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-amber-500/60" />
                <span>similar</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-red-500/60" />
                <span>different</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
