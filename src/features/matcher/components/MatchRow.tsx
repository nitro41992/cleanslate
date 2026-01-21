import { Check, X, ChevronDown, ChevronUp } from 'lucide-react'
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
            {/* Field Headers */}
            <div className="grid grid-cols-[1fr,auto,1fr] gap-2 text-xs font-medium text-muted-foreground mb-2">
              <div className="text-right">Record A</div>
              <div className="text-center">Match</div>
              <div>Record B</div>
            </div>

            {/* Field Comparison */}
            <div className="space-y-2">
              {pair.fieldSimilarities.map((field) => {
                const statusIcon =
                  field.status === 'exact' ? '=' :
                  field.status === 'similar' ? '\u2248' : '\u2260'

                const statusColor =
                  field.status === 'exact' ? 'text-green-400 bg-green-500/10' :
                  field.status === 'similar' ? 'text-yellow-400 bg-yellow-500/10' : 'text-red-400 bg-red-500/10'

                const isMatchColumn = field.column === matchColumn

                return (
                  <div
                    key={field.column}
                    className={cn(
                      'grid grid-cols-[1fr,auto,1fr] gap-2 text-xs items-center py-1.5 px-2 rounded',
                      isMatchColumn && 'bg-muted/50 border border-border/50'
                    )}
                  >
                    <div className="text-right">
                      <span className="text-muted-foreground mr-2">{field.column}:</span>
                      <span className="truncate">{formatValue(field.valueA)}</span>
                    </div>
                    <div className={cn('font-mono text-center px-2 py-0.5 rounded', statusColor)}>
                      {statusIcon}
                    </div>
                    <div className="truncate">{formatValue(field.valueB)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
