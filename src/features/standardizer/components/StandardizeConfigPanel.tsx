import { AlertCircle, CheckCircle2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { TableCombobox } from '@/components/ui/table-combobox'
import { ColumnCombobox } from '@/components/ui/combobox'
import type { TableInfo, ClusteringAlgorithm } from '@/types'

interface StandardizeConfigPanelProps {
  tables: TableInfo[]
  tableId: string | null
  columnName: string | null
  algorithm: ClusteringAlgorithm
  isAnalyzing: boolean
  hasClusters: boolean
  validationError: string | null
  uniqueValueCount: number
  onTableChange: (tableId: string | null, tableName: string | null) => void
  onColumnChange: (columnName: string | null) => void
  onAlgorithmChange: (algorithm: ClusteringAlgorithm) => void
  onAnalyze: () => void
}

// Algorithm examples
const ALGORITHM_EXAMPLES: Record<ClusteringAlgorithm, Array<{ before: string; after: string }>> = {
  fingerprint: [
    { before: 'John  Smith', after: 'john smith' },
    { before: 'SMITH, JOHN', after: 'john smith' },
  ],
  metaphone: [
    { before: 'Smith', after: 'SMθ' },
    { before: 'Smyth', after: 'SMθ' },
  ],
  token_phonetic: [
    { before: 'John Smith', after: 'JN SMθ' },
    { before: 'Smith, John', after: 'JN SMθ' },
  ],
}

// Algorithm descriptions for the info card
const ALGORITHM_INFO: Record<ClusteringAlgorithm, { title: string; description: string; hints: string[] }> = {
  fingerprint: {
    title: 'Fingerprint (Normalization)',
    description: 'Groups values by normalized form - removes case, punctuation, and extra whitespace',
    hints: [
      'Best for cleaning up inconsistent formatting',
      'Detects: extra spaces, case differences, punctuation variants',
    ],
  },
  metaphone: {
    title: 'Metaphone (Phonetic)',
    description: 'Groups values that sound similar using phonetic encoding',
    hints: [
      'Best for matching names with spelling variations',
      'Detects: Smith/Smyth, John/Jon, Catherine/Katherine',
    ],
  },
  token_phonetic: {
    title: 'Token Phonetic (Names)',
    description: 'Phonetic matching per word - ideal for full names with reordering',
    hints: [
      'Best for full names that may be in different order',
      'Detects: "John Smith" vs "Smith, John"',
    ],
  },
}

export function StandardizeConfigPanel({
  tables,
  tableId,
  columnName,
  algorithm,
  isAnalyzing,
  hasClusters,
  validationError,
  uniqueValueCount,
  onTableChange,
  onColumnChange,
  onAlgorithmChange,
  onAnalyze,
}: StandardizeConfigPanelProps) {
  const selectedTable = tables.find((t) => t.id === tableId)
  const columns = selectedTable?.columns || []
  const stringColumns = columns.filter(
    (c) => c.type.toLowerCase().includes('varchar') || c.type.toLowerCase().includes('text')
  )

  // Prepare table options for combobox
  const tableOptions = tables.map(t => ({ id: t.id, name: t.name, rowCount: t.rowCount }))

  // Get all column names for combobox
  const allColumnNames = columns.map(c => c.name)
  const stringColumnNames = stringColumns.map(c => c.name)

  const handleTableChange = (id: string, name: string) => {
    onTableChange(id, name)
    onColumnChange(null)
  }

  const handleColumnChange = (value: string) => {
    onColumnChange(value || null)
  }

  const canAnalyze = tableId && columnName && !isAnalyzing
  const algorithmInfo = ALGORITHM_INFO[algorithm]
  const algorithmExamples = ALGORITHM_EXAMPLES[algorithm]

  return (
    <div className="p-4 space-y-6">
      {/* Header Info Card */}
      <div className="bg-muted/30 rounded-lg p-3">
        <h2 className="font-medium flex items-center gap-2">
          <Wand2 className="w-4 h-4" />
          Value Standardizer
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Find and fix inconsistent values in a column
        </p>
      </div>

      {/* Table Selection */}
      <div className="space-y-2">
        <Label htmlFor="table-select">Table</Label>
        <TableCombobox
          tables={tableOptions}
          value={tableId}
          onValueChange={handleTableChange}
          placeholder="Select a table..."
          disabled={isAnalyzing}
          autoFocus
        />
      </div>

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

      {/* Algorithm Selection with Info Card */}
      <div className="space-y-2">
        <Label htmlFor="algorithm-select">Clustering Algorithm</Label>
        <Select
          value={algorithm}
          onValueChange={(value) => onAlgorithmChange(value as ClusteringAlgorithm)}
          disabled={isAnalyzing}
        >
          <SelectTrigger id="algorithm-select" data-testid="standardize-algorithm-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fingerprint">
              Fingerprint (Normalization)
            </SelectItem>
            <SelectItem value="metaphone">
              Metaphone (Phonetic)
            </SelectItem>
            <SelectItem value="token_phonetic">
              Token Phonetic (Names)
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Algorithm Info Card */}
        <div className="bg-muted/30 rounded-lg p-3 space-y-3 mt-2">
          <div>
            <p className="text-sm font-medium">{algorithmInfo.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {algorithmInfo.description}
            </p>
          </div>

          {/* Examples */}
          <div className="border-t border-border/50 pt-2">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Examples</p>
            <div className="space-y-1">
              {algorithmExamples.slice(0, 2).map((ex, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-red-400/80">{ex.before}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="text-green-400/80">{ex.after}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Hints */}
          <div className="border-t border-border/50 pt-2">
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {algorithmInfo.hints.map((hint, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-blue-400">•</span>
                  {hint}
                </li>
              ))}
            </ul>
          </div>
        </div>
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
            <span className="text-blue-400">1.</span>
            Select a table and text column
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">2.</span>
            Choose a clustering algorithm
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">3.</span>
            Click &quot;Analyze Values&quot; to find clusters
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">4.</span>
            Review clusters and select values to standardize
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-400">5.</span>
            Click &quot;Apply&quot; to update the data
          </li>
        </ul>
      </div>
    </div>
  )
}
