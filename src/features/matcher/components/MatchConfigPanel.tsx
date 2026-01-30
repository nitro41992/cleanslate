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

// Strategy display order - Fast options first, then accurate, then small-data-only
const STRATEGY_ORDER: BlockingStrategy[] = [
  // Fast SQL-only (no JS preprocessing)
  'first_2_chars',
  'first_letter',
  // Accurate phonetic (requires JS preprocessing - slower but better matching)
  'metaphone_block',
  'token_phonetic_block',
  'fingerprint_block',
  // Small datasets only
  'none',
]

// Maximum row count for 'none' strategy (O(n²) becomes impractical above this)
const MAX_ROWS_FOR_NONE = 1000

const strategyInfo: Record<BlockingStrategy, StrategyInfo> = {
  // Fast SQL-only strategies
  first_2_chars: {
    title: 'First 2 Characters',
    description: 'Groups by first 2 letters. Fast for large datasets.',
    badge: 'Fast',
    badgeVariant: 'secondary',
    examples: [
      { before: 'Smith', after: 'Smyth' },
    ],
  },
  first_letter: {
    title: 'First Letter',
    description: 'Groups by first letter only. Fastest option for very large datasets.',
    badge: 'Fastest',
    badgeVariant: 'secondary',
    examples: [
      { before: 'Smith', after: 'Smythe' },
    ],
  },
  // Accurate phonetic strategies
  metaphone_block: {
    title: 'Phonetic (Sound-Alike)',
    description: 'Groups values that sound similar. More accurate but slower.',
    badge: 'Accurate',
    badgeVariant: 'default',
    examples: [
      { before: 'Smith', after: 'Smyth' },
      { before: 'John', after: 'Jon' },
      { before: 'Catherine', after: 'Katherine' },
    ],
  },
  token_phonetic_block: {
    title: 'Token Phonetic (Full Names)',
    description: 'Phonetic + word order handling. Best accuracy for full names.',
    badge: 'Best for names',
    badgeVariant: 'default',
    examples: [
      { before: 'John Smith', after: 'Smith, Jon' },
      { before: 'Jon Smyth', after: 'John Smith' },
    ],
  },
  fingerprint_block: {
    title: 'Fingerprint (Word-Order Safe)',
    description: 'Groups values with same words regardless of order. Best for addresses.',
    examples: [
      { before: 'John Smith', after: 'Smith, John' },
      { before: 'ACME Inc.', after: 'ACME, Inc' },
    ],
  },
  // Small datasets only
  none: {
    title: 'Compare All Pairs',
    description: `Compares every record pair. Only for tables with ≤${MAX_ROWS_FOR_NONE.toLocaleString()} rows.`,
    badge: 'Small datasets',
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

    // If 'none' is selected but new table exceeds row limit, switch to default
    const newTable = tables.find(t => t.id === id)
    if (blockingStrategy === 'none' && newTable && newTable.rowCount > MAX_ROWS_FOR_NONE) {
      onBlockingStrategyChange('first_2_chars')
    }
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
            {STRATEGY_ORDER.map((strategy) => {
              const info = strategyInfo[strategy]
              const isSelected = blockingStrategy === strategy
              // Disable 'none' strategy for tables with > 1000 rows
              const isDisabled = strategy === 'none' && selectedTable.rowCount > MAX_ROWS_FOR_NONE
              const rowCountExceeded = strategy === 'none' && selectedTable.rowCount > MAX_ROWS_FOR_NONE

              return (
                <div
                  key={strategy}
                  className={cn(
                    'flex items-start space-x-3 rounded-lg border p-3 transition-colors',
                    isDisabled
                      ? 'opacity-50 cursor-not-allowed'
                      : 'cursor-pointer',
                    isSelected && !isDisabled
                      ? 'border-l-2 border-l-primary border-primary bg-accent'
                      : 'border-border',
                    !isDisabled && !isSelected && 'hover:bg-muted'
                  )}
                  onClick={() => !isDisabled && onBlockingStrategyChange(strategy)}
                >
                  <RadioGroupItem
                    value={strategy}
                    id={strategy}
                    className="mt-0.5"
                    disabled={isDisabled}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <label
                        htmlFor={strategy}
                        className={cn(
                          'text-sm font-medium',
                          isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
                        )}
                      >
                        {info.title}
                      </label>
                      {info.badge && !rowCountExceeded && (
                        <Badge variant={info.badgeVariant || 'default'} className="text-xs">
                          {info.badge}
                        </Badge>
                      )}
                      {rowCountExceeded && (
                        <Badge variant="destructive" className="text-xs">
                          {selectedTable.rowCount.toLocaleString()} rows (max {MAX_ROWS_FOR_NONE.toLocaleString()})
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
