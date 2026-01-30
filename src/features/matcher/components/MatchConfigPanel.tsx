import { Play, Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { TableCombobox } from '@/components/ui/table-combobox'
import { ColumnCombobox } from '@/components/ui/combobox'
import type { TableInfo, BlockingStrategy } from '@/types'
import { cn } from '@/lib/utils'

interface MatchConfigPanelProps {
  tables: TableInfo[]
  tableId: string | null
  matchColumn: string | null
  blockingStrategy: BlockingStrategy
  isMatching: boolean
  hasPairs: boolean
  onTableChange: (tableId: string | null, tableName: string | null) => void
  onMatchColumnChange: (column: string | null) => void
  onBlockingStrategyChange: (strategy: BlockingStrategy) => void
  onFindDuplicates: () => void
}

interface StrategyInfo {
  title: string
  description: string
  badge?: string
  badgeVariant?: 'default' | 'secondary' | 'destructive' | 'outline'
  examples: Array<{ before: string; after: string }>
}

const strategyInfo: Record<BlockingStrategy, StrategyInfo> = {
  first_letter: {
    title: 'First Letter (Fastest)',
    description: 'Only compare records starting with same letter. Best for clean data, 100k+ rows.',
    examples: [
      { before: 'Smith', after: 'Smythe' },
    ],
  },
  double_metaphone: {
    title: 'Phonetic - Double Metaphone',
    description: 'Compare records that sound similar. Best for name variations.',
    badge: 'Recommended',
    badgeVariant: 'default',
    examples: [
      { before: 'Smith', after: 'Smyth' },
      { before: 'John', after: 'Jon' },
    ],
  },
  ngram: {
    title: 'Character Similarity (N-Gram)',
    description: 'Compare records sharing character sequences. Best for typos, misspellings.',
    examples: [
      { before: 'Jhon', after: 'John' },
    ],
  },
  none: {
    title: 'Compare All (Slowest)',
    description: 'Compare every record pair. Best for small datasets under 1,000 rows.',
    badge: 'May be slow',
    badgeVariant: 'secondary',
    examples: [],
  },
}

export function MatchConfigPanel({
  tables,
  tableId,
  matchColumn,
  blockingStrategy,
  isMatching,
  hasPairs,
  onTableChange,
  onMatchColumnChange,
  onBlockingStrategyChange,
  onFindDuplicates,
}: MatchConfigPanelProps) {
  const selectedTable = tables.find((t) => t.id === tableId)

  // Prepare table options for combobox
  const tableOptions = tables.map(t => ({ id: t.id, name: t.name, rowCount: t.rowCount }))

  // Get column names for combobox
  const columnNames = selectedTable?.columns.map(c => c.name) || []

  const handleTableSelect = (id: string, name: string) => {
    onTableChange(id, name)
    onMatchColumnChange(null)
  }

  const handleColumnChange = (column: string) => {
    onMatchColumnChange(column || null)
  }

  const canSearch = tableId && matchColumn && !isMatching

  return (
    <div className="p-4 space-y-6">
      {/* Header Info Card */}
      <div className="bg-muted rounded-lg p-3">
        <h2 className="font-medium flex items-center gap-2">
          <Users className="w-4 h-4" />
          Find Duplicates
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Detect and merge duplicate records based on similarity
        </p>
      </div>

      {/* Table Selection */}
      <div className="space-y-2">
        <Label>Table</Label>
        <TableCombobox
          tables={tableOptions}
          value={tableId}
          onValueChange={handleTableSelect}
          placeholder="Select table..."
          disabled={isMatching}
          autoFocus
        />
      </div>

      {/* Match Column Selection */}
      {selectedTable && (
        <div className="space-y-2">
          <Label>Match Column</Label>
          <ColumnCombobox
            columns={columnNames}
            value={matchColumn || ''}
            onValueChange={handleColumnChange}
            placeholder="Select column to compare..."
            disabled={isMatching}
          />
          <p className="text-xs text-muted-foreground">
            Records will be compared based on similarity of this column
          </p>
        </div>
      )}

      {/* Blocking Strategy */}
      {selectedTable && (
        <div className="space-y-3">
          <Label>Grouping Strategy</Label>
          <RadioGroup
            value={blockingStrategy}
            onValueChange={(v) => onBlockingStrategyChange(v as BlockingStrategy)}
            className="space-y-2"
          >
            {(Object.keys(strategyInfo) as BlockingStrategy[]).map((strategy) => {
              const info = strategyInfo[strategy]
              const isSelected = blockingStrategy === strategy
              return (
                <div
                  key={strategy}
                  className={cn(
                    'flex items-start space-x-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    isSelected
                      ? 'border-l-2 border-l-primary border-primary bg-accent'
                      : 'border-border hover:bg-muted'
                  )}
                  onClick={() => onBlockingStrategyChange(strategy)}
                >
                  <RadioGroupItem value={strategy} id={strategy} className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <label
                        htmlFor={strategy}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {info.title}
                      </label>
                      {info.badge && (
                        <Badge variant={info.badgeVariant || 'default'} className="text-xs">
                          {info.badge}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {info.description}
                    </p>

                    {/* Strategy Examples */}
                    {info.examples.length > 0 && isSelected && (
                      <div className="mt-2 pt-2 border-t border-border">
                        <div className="space-y-1">
                          {info.examples.map((ex, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs font-mono">
                              <span className="text-muted-foreground">e.g.</span>
                              <span className="text-red-400/80">{ex.before}</span>
                              <span className="text-muted-foreground">↔</span>
                              <span className="text-green-400/80">{ex.after}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </RadioGroup>
        </div>
      )}

      {/* Find Duplicates Button */}
      {!hasPairs && (
        <Button
          className="w-full"
          onClick={() => {
            console.log('[DEBUG] Find Duplicates button clicked!')
            onFindDuplicates()
          }}
          disabled={!canSearch}
          data-testid="find-duplicates-btn"
        >
          {isMatching ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Finding Matches...
            </>
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" />
              Find Duplicates
            </>
          )}
        </Button>
      )}

      {/* How it works */}
      <div className="border-t border-border pt-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">How it works</p>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">1.</span>
            Select a table and column to match on
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">2.</span>
            Choose a grouping strategy for your data size
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">3.</span>
            Review potential duplicates by similarity
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">4.</span>
            Mark pairs to merge or keep separate
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">5.</span>
            Apply merges to deduplicate your data
          </li>
        </ul>
      </div>
    </div>
  )
}
