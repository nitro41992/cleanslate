import { AlertCircle, CheckCircle2 } from 'lucide-react'
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

  const handleTableChange = (value: string) => {
    if (value === 'none') {
      onTableChange(null, null)
    } else {
      const table = tables.find((t) => t.id === value)
      if (table) {
        onTableChange(table.id, table.name)
      }
    }
  }

  const handleColumnChange = (value: string) => {
    if (value === 'none') {
      onColumnChange(null)
    } else {
      onColumnChange(value)
    }
  }

  const canAnalyze = tableId && columnName && !isAnalyzing

  return (
    <div className="p-4 space-y-6">
      {/* Table Selection */}
      <div className="space-y-2">
        <Label htmlFor="table-select">Table</Label>
        <Select
          value={tableId || 'none'}
          onValueChange={handleTableChange}
          disabled={isAnalyzing}
        >
          <SelectTrigger id="table-select" data-testid="standardize-table-select">
            <SelectValue placeholder="Select a table" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select a table...</SelectItem>
            {tables.map((table) => (
              <SelectItem key={table.id} value={table.id}>
                {table.name} ({table.rowCount.toLocaleString()} rows)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Column Selection */}
      <div className="space-y-2">
        <Label htmlFor="column-select">Column to Standardize</Label>
        <Select
          value={columnName || 'none'}
          onValueChange={handleColumnChange}
          disabled={!tableId || isAnalyzing}
        >
          <SelectTrigger id="column-select" data-testid="standardize-column-select">
            <SelectValue placeholder="Select a column" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select a column...</SelectItem>
            {stringColumns.length === 0 && columns.length > 0 && (
              <SelectItem value="__hint" disabled>
                (No text columns found)
              </SelectItem>
            )}
            {stringColumns.map((col) => (
              <SelectItem key={col.name} value={col.name}>
                {col.name}
              </SelectItem>
            ))}
            {/* Also show non-string columns but indicate they may not work well */}
            {columns
              .filter((c) => !stringColumns.includes(c))
              .map((col) => (
                <SelectItem key={col.name} value={col.name}>
                  {col.name} ({col.type})
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Text columns work best for value standardization
        </p>
      </div>

      {/* Algorithm Selection */}
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
        <p className="text-xs text-muted-foreground">
          {algorithm === 'fingerprint'
            ? 'Groups values by normalized form (case, punctuation, word order)'
            : algorithm === 'metaphone'
            ? 'Groups values by phonetic similarity (sounds-alike matching)'
            : 'Phonetic matching per word - ideal for full names (handles word order + spelling variations)'}
        </p>
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

      {/* Help Text */}
      <div className="text-xs text-muted-foreground space-y-2 pt-4 border-t">
        <p className="font-medium">How it works:</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Select a table and text column</li>
          <li>Choose a clustering algorithm</li>
          <li>Click "Analyze Values" to find clusters</li>
          <li>Review clusters and select values to standardize</li>
          <li>Click "Apply" to update the data</li>
        </ol>
      </div>
    </div>
  )
}
