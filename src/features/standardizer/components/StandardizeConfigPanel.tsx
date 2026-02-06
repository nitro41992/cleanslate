import { AlertCircle, CheckCircle2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ColumnCombobox } from '@/components/ui/combobox'
import { cn } from '@/lib/utils'
import type { TableInfo, ClusteringAlgorithm } from '@/types'

interface StandardizeConfigPanelProps {
  tables: TableInfo[]
  tableId: string | null
  tableName: string | null
  columnName: string | null
  algorithm: ClusteringAlgorithm
  isAnalyzing: boolean
  hasClusters: boolean
  validationError: string | null
  uniqueValueCount: number
  onColumnChange: (columnName: string | null) => void
  onAlgorithmChange: (algorithm: ClusteringAlgorithm) => void
  onAnalyze: () => void
}

interface AlgorithmInfo {
  title: string
  description: string
  badge: string
  badgeVariant: 'default' | 'secondary'
  examples: Array<{ before: string; after: string }>
  hints: string[]
}

const ALGORITHM_ORDER: ClusteringAlgorithm[] = ['fingerprint', 'metaphone', 'token_phonetic']

const ALGORITHM_INFO: Record<ClusteringAlgorithm, AlgorithmInfo> = {
  fingerprint: {
    title: 'Fingerprint (Normalization)',
    description: 'Groups values by normalized form — removes case, punctuation, and extra whitespace',
    badge: 'Recommended',
    badgeVariant: 'default',
    examples: [
      { before: 'John  Smith', after: 'john smith' },
      { before: 'SMITH, JOHN', after: 'john smith' },
    ],
    hints: [
      'Best for cleaning up inconsistent formatting',
      'Detects: extra spaces, case differences, punctuation variants',
    ],
  },
  metaphone: {
    title: 'Metaphone (Phonetic)',
    description: 'Groups values that sound similar using phonetic encoding',
    badge: 'Sound-alike',
    badgeVariant: 'secondary',
    examples: [
      { before: 'Smith', after: 'SMθ' },
      { before: 'Smyth', after: 'SMθ' },
    ],
    hints: [
      'Best for matching names with spelling variations',
      'Detects: Smith/Smyth, John/Jon, Catherine/Katherine',
    ],
  },
  token_phonetic: {
    title: 'Token Phonetic (Names)',
    description: 'Phonetic matching per word — ideal for full names with reordering',
    badge: 'Best for names',
    badgeVariant: 'secondary',
    examples: [
      { before: 'John Smith', after: 'JN SMθ' },
      { before: 'Smith, John', after: 'JN SMθ' },
    ],
    hints: [
      'Best for full names that may be in different order',
      'Detects: "John Smith" vs "Smith, John"',
    ],
  },
}

export function StandardizeConfigPanel({
  tables,
  tableId,
  tableName,
  columnName,
  algorithm,
  isAnalyzing,
  hasClusters,
  validationError,
  uniqueValueCount,
  onColumnChange,
  onAlgorithmChange,
  onAnalyze,
}: StandardizeConfigPanelProps) {
  const selectedTable = tables.find((t) => t.id === tableId)
  const columns = selectedTable?.columns || []
  const stringColumns = columns.filter(
    (c) => c.type.toLowerCase().includes('varchar') || c.type.toLowerCase().includes('text')
  )

  // Get all column names for combobox
  const allColumnNames = columns.map(c => c.name)
  const stringColumnNames = stringColumns.map(c => c.name)

  const handleColumnChange = (value: string) => {
    onColumnChange(value || null)
  }

  const canAnalyze = tableId && columnName && !isAnalyzing

  return (
    <div className="p-4 space-y-6">
      {/* Header Info Card */}
      <div className="bg-muted/30 rounded-lg p-3">
        <h2 className="font-medium flex items-center gap-2">
          <Wand2 className="w-4 h-4" />
          Smart Replace
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Find and fix similar values in a column
        </p>
      </div>

      {/* Active Table Info */}
      {tableName && (
        <div className="space-y-1">
          <Label className="text-muted-foreground text-xs">Table</Label>
          <p className="text-sm font-medium">{tableName}</p>
        </div>
      )}

      {/* Column Selection */}
      <div className="space-y-2">
        <Label htmlFor="column-select">Column to Standardize</Label>
        <ColumnCombobox
          columns={allColumnNames}
          value={columnName || ''}
          onValueChange={handleColumnChange}
          placeholder="Select a column..."
          disabled={!tableId || isAnalyzing}
        />
        {stringColumnNames.length === 0 && columns.length > 0 && (
          <p className="text-xs text-yellow-600 dark:text-yellow-400">
            No text columns found - numeric columns may not cluster well
          </p>
        )}
        {stringColumnNames.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Text columns work best for value standardization
          </p>
        )}
      </div>

      {/* Algorithm Selection */}
      <div className={cn(
        'space-y-3 transition-opacity duration-200',
        !columnName && 'opacity-50 pointer-events-none'
      )}>
        <Label>Clustering Algorithm</Label>
        {!columnName && (
          <p className="text-xs text-muted-foreground italic">
            Select a column above to choose an algorithm
          </p>
        )}
        <RadioGroup
          value={algorithm}
          onValueChange={(v) => onAlgorithmChange(v as ClusteringAlgorithm)}
          className="space-y-2"
        >
          {ALGORITHM_ORDER.map((algo) => {
            const info = ALGORITHM_INFO[algo]
            const isSelected = algorithm === algo

            return (
              <div
                key={algo}
                className={cn(
                  'flex items-start space-x-3 rounded-lg border p-3 transition-colors cursor-pointer',
                  isSelected
                    ? 'border-l-2 border-l-primary border-primary bg-accent'
                    : 'border-border hover:bg-muted'
                )}
                onClick={() => onAlgorithmChange(algo)}
              >
                <RadioGroupItem
                  value={algo}
                  id={`algo-${algo}`}
                  className="mt-0.5"
                  disabled={isAnalyzing}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <label
                      htmlFor={`algo-${algo}`}
                      className="text-sm font-medium cursor-pointer"
                    >
                      {info.title}
                    </label>
                    <Badge variant={info.badgeVariant} className="text-xs">
                      {info.badge}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {info.description}
                  </p>

                  {/* Examples + Hints (expanded when selected) */}
                  {isSelected && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <div className="space-y-1">
                        {info.examples.map((ex, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs font-mono">
                            <span className="text-muted-foreground">e.g.</span>
                            <span className="text-red-600 dark:text-red-400/80">{ex.before}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-green-700 dark:text-green-400/80">{ex.after}</span>
                          </div>
                        ))}
                      </div>
                      <ul className="text-xs text-muted-foreground space-y-0.5 mt-2">
                        {info.hints.map((hint, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-blue-600 dark:text-blue-400">•</span>
                            {hint}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </RadioGroup>
      </div>

      {/* Validation Status */}
      {validationError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {uniqueValueCount > 0 && !validationError && (
        <Alert>
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <AlertDescription>
            {uniqueValueCount.toLocaleString()} unique values found
          </AlertDescription>
        </Alert>
      )}

      {/* Analyze Button */}
      <Button
        onClick={onAnalyze}
        disabled={!canAnalyze}
        className="w-full"
        data-testid="standardize-analyze-btn"
      >
        {isAnalyzing ? 'Analyzing...' : hasClusters ? 'Re-Analyze Values' : 'Analyze Values'}
      </Button>

      {/* How it works */}
      <div className="border-t border-border/50 pt-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">How it works</p>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400">1.</span>
            Select a table and text column
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400">2.</span>
            Choose a clustering algorithm
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400">3.</span>
            Click &quot;Analyze Values&quot; to find clusters
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400">4.</span>
            Review clusters and select values to replace
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400">5.</span>
            Click &quot;Apply&quot; to update the data
          </li>
        </ul>
      </div>
    </div>
  )
}
