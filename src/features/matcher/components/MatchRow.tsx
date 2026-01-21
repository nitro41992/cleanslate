import { Check, X, ChevronDown, ChevronUp, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
}

const classStyles = {
  definite: 'border-green-500/30 bg-green-500/5',
  maybe: 'border-yellow-500/30 bg-yellow-500/5',
  not_match: 'border-red-500/30 bg-red-500/5',
}

const similarityBadgeStyles = {
  definite: 'bg-green-500/20 text-green-400',
  maybe: 'bg-yellow-500/20 text-yellow-400',
  not_match: 'bg-red-500/20 text-red-400',
}

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}

export function MatchRow({
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
  const matchFieldSimilarity = pair.fieldSimilarities.find(
    (f) => f.column === matchColumn
  )

  // Generate human-readable explanation
  const getExplanation = (): string => {
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
  }

  return (
    <div className={cn('border rounded-lg transition-colors', classStyles[classification])}>
      {/* Summary Row */}
      <div className="flex items-center gap-2 p-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
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
              <span className="text-muted-foreground text-xs">vs</span>
              <span className="text-sm font-medium truncate">
                {matchFieldSimilarity ? formatValue(matchFieldSimilarity.valueB) : formatValue(pair.rowB[matchColumn])}
              </span>
            </div>
            {isExpanded && (
              <p className="text-xs text-muted-foreground mt-1">
                {getExplanation()}
              </p>
            )}
          </div>

          {/* Similarity Badge */}
          <div
            className={cn(
              'px-2.5 py-1 rounded-full text-sm font-medium shrink-0',
              similarityBadgeStyles[classification]
            )}
          >
            {pair.similarity}% Similar
          </div>

          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
        </button>

        {/* Action Buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-green-500/20"
            onClick={onMerge}
            title="Merge (M)"
          >
            <Check className="w-4 h-4 text-green-500" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-red-500/20"
            onClick={onKeepSeparate}
            title="Keep Separate (K)"
          >
            <X className="w-4 h-4 text-red-500" />
          </Button>
        </div>
      </div>

      {/* Expanded Detail */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border/50">
          <div className="pt-3">
            {/* Side-by-Side Comparison with Swap Button */}
            <div className="grid grid-cols-[1fr,auto,1fr] gap-4">
              {/* Left Column - KEEPING */}
              <div
                className={cn(
                  'rounded-lg p-3',
                  pair.keepRow === 'A'
                    ? 'border-l-4 border-green-500 bg-green-500/5'
                    : 'border-l-4 border-red-500 bg-red-500/5'
                )}
              >
                <div className={cn(
                  'text-xs font-semibold mb-2 flex items-center gap-1',
                  pair.keepRow === 'A' ? 'text-green-400' : 'text-red-400'
                )}>
                  {pair.keepRow === 'A' ? (
                    <><Check className="w-3 h-3" /> KEEPING</>
                  ) : (
                    <><X className="w-3 h-3" /> DELETING</>
                  )}
                </div>
                <div className="space-y-1">
                  {pair.fieldSimilarities.map((field) => (
                    <div
                      key={field.column}
                      className={cn(
                        'text-xs',
                        pair.keepRow === 'B' && 'text-muted-foreground'
                      )}
                    >
                      <span className="text-muted-foreground">{field.column}:</span>{' '}
                      <span className={cn(
                        field.column === matchColumn && 'font-medium'
                      )}>
                        {formatValue(field.valueA)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Swap Button */}
              <div className="flex items-center justify-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full hover:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSwapKeepRow()
                  }}
                  title="Swap which row to keep"
                >
                  <ArrowLeftRight className="w-5 h-5 text-muted-foreground" />
                </Button>
              </div>

              {/* Right Column - DELETING */}
              <div
                className={cn(
                  'rounded-lg p-3',
                  pair.keepRow === 'B'
                    ? 'border-l-4 border-green-500 bg-green-500/5'
                    : 'border-l-4 border-red-500 bg-red-500/5'
                )}
              >
                <div className={cn(
                  'text-xs font-semibold mb-2 flex items-center gap-1',
                  pair.keepRow === 'B' ? 'text-green-400' : 'text-red-400'
                )}>
                  {pair.keepRow === 'B' ? (
                    <><Check className="w-3 h-3" /> KEEPING</>
                  ) : (
                    <><X className="w-3 h-3" /> DELETING</>
                  )}
                </div>
                <div className="space-y-1">
                  {pair.fieldSimilarities.map((field) => (
                    <div
                      key={field.column}
                      className={cn(
                        'text-xs',
                        pair.keepRow === 'A' && 'text-muted-foreground'
                      )}
                    >
                      <span className="text-muted-foreground">{field.column}:</span>{' '}
                      <span className={cn(
                        field.column === matchColumn && 'font-medium'
                      )}>
                        {formatValue(field.valueB)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Summary */}
            <p className="text-xs text-muted-foreground mt-3 text-center">
              {getExplanation()}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
