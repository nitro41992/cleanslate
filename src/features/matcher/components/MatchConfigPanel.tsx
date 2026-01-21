import { Play, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TableInfo, BlockingStrategy } from '@/types'

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

const strategyDescriptions: Record<BlockingStrategy, { title: string; description: string; badge?: string }> = {
  first_letter: {
    title: 'First Letter (Fastest)',
    description: 'Only compare records starting with same letter. Best for clean data, 100k+ rows.',
  },
  double_metaphone: {
    title: 'Phonetic - Double Metaphone',
    description: 'Compare records that sound similar. Best for name variations (Smith/Smyth, John/Jon).',
    badge: 'Recommended',
  },
  ngram: {
    title: 'Character Similarity (N-Gram)',
    description: 'Compare records sharing character sequences. Best for typos, misspellings (Jhon/John).',
  },
  none: {
    title: 'Compare All (Slowest)',
    description: 'Compare every record pair. Best for small datasets under 1,000 rows.',
    badge: 'May be slow',
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

  const handleTableSelect = (id: string) => {
    const table = tables.find((t) => t.id === id)
    onTableChange(id, table?.name || null)
    onMatchColumnChange(null)
  }

  const canSearch = tableId && matchColumn && !isMatching

  return (
    <div className="p-4 space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Configuration</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Select a table and column to find potential duplicates
        </p>
      </div>

      {/* Table Selection */}
      <div className="space-y-2">
        <Label>Table</Label>
        <Select value={tableId || ''} onValueChange={handleTableSelect}>
          <SelectTrigger>
            <SelectValue placeholder="Select table" />
          </SelectTrigger>
          <SelectContent>
            {tables.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name} ({t.rowCount.toLocaleString()} rows)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Match Column Selection */}
      {selectedTable && (
        <div className="space-y-2">
          <Label>Match Column</Label>
          <Select value={matchColumn || ''} onValueChange={onMatchColumnChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select column to compare" />
            </SelectTrigger>
            <SelectContent>
              {selectedTable.columns.map((col) => (
                <SelectItem key={col.name} value={col.name}>
                  {col.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            className="space-y-3"
          >
            {(Object.keys(strategyDescriptions) as BlockingStrategy[]).map((strategy) => {
              const info = strategyDescriptions[strategy]
              return (
                <div
                  key={strategy}
                  className="flex items-start space-x-3 rounded-lg border border-border/50 p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => onBlockingStrategyChange(strategy)}
                >
                  <RadioGroupItem value={strategy} id={strategy} className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={strategy}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {info.title}
                      </label>
                      {info.badge && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                          {info.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {info.description}
                    </p>
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
          onClick={onFindDuplicates}
          disabled={!canSearch}
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
    </div>
  )
}
