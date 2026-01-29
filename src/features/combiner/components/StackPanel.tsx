import { useState } from 'react'
import { Layers, Play, Loader2, X, Check } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ValidationWarnings } from './ValidationWarnings'
import { useTableStore } from '@/stores/tableStore'
import { useCombinerStore } from '@/stores/combinerStore'
import { validateStack, stackTables } from '@/lib/combiner-engine'
import { getTableColumns } from '@/lib/duckdb'
import { toast } from '@/hooks/use-toast'
import { markTableAsRecentlySaved } from '@/hooks/usePersistence'

export function StackPanel() {
  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)

  const {
    stackTableIds,
    stackValidation,
    resultTableName,
    isProcessing,
    addStackTable,
    removeStackTable,
    setStackValidation,
    setResultTableName,
    setIsProcessing,
    setError,
  } = useCombinerStore()

  const [selectedTable, setSelectedTable] = useState<string>('')

  const handleAddTable = () => {
    if (selectedTable && !stackTableIds.includes(selectedTable)) {
      addStackTable(selectedTable)
      setSelectedTable('')
      setStackValidation(null)
    }
  }

  const handleRemoveTable = (id: string) => {
    removeStackTable(id)
    setStackValidation(null)
  }

  const handleValidate = async () => {
    if (stackTableIds.length < 2) return

    const tableA = tables.find((t) => t.id === stackTableIds[0])
    const tableB = tables.find((t) => t.id === stackTableIds[1])

    if (!tableA || !tableB) return

    try {
      const validation = await validateStack(tableA.name, tableB.name)
      setStackValidation(validation)
    } catch (error) {
      console.error('Validation failed:', error)
    }
  }

  const handleStack = async () => {
    if (stackTableIds.length < 2 || !resultTableName.trim()) return

    const tableA = tables.find((t) => t.id === stackTableIds[0])
    const tableB = tables.find((t) => t.id === stackTableIds[1])

    if (!tableA || !tableB) return

    setIsProcessing(true)
    try {
      const { rowCount } = await stackTables(
        tableA.name,
        tableB.name,
        resultTableName.trim()
      )

      // Get columns for the new table
      const columns = await getTableColumns(resultTableName.trim())

      // Add to table store
      const newTableId = addTable(
        resultTableName.trim(),
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount
      )

      // Prevent race condition with auto-save subscription
      // Without this, the table gets stuck in "unsaved" state due to multiple
      // subscription callbacks firing during save and re-marking the table dirty
      markTableAsRecentlySaved(newTableId)

      toast({
        title: 'Tables Stacked',
        description: `Created "${resultTableName}" with ${rowCount} rows`,
      })

      // Reset form
      setResultTableName('')
      setStackValidation(null)
    } catch (error) {
      console.error('Stack failed:', error)
      setError(error instanceof Error ? error.message : 'Stack operation failed')
      toast({
        title: 'Stack Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const selectedTables = stackTableIds
    .map((id) => tables.find((t) => t.id === id))
    .filter(Boolean)

  const availableTables = tables.filter((t) => !stackTableIds.includes(t.id))

  return (
    <Card className="flex-1 flex flex-col">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="w-4 h-4" />
          Stack Tables (UNION ALL)
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col space-y-4">
        <p className="text-sm text-muted-foreground">
          Combine rows from multiple tables vertically. Columns with matching names
          will be aligned; missing columns will be filled with NULL.
        </p>

        {/* Table Selection */}
        <div className="space-y-2">
          <Label>Select Tables to Stack</Label>
          <div className="flex gap-2">
            <Select value={selectedTable} onValueChange={setSelectedTable}>
              <SelectTrigger className="flex-1" data-testid="stack-table-select">
                <SelectValue placeholder="Select a table" />
              </SelectTrigger>
              <SelectContent>
                {availableTables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.rowCount} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={handleAddTable}
              disabled={!selectedTable || stackTableIds.length >= 2}
            >
              Add
            </Button>
          </div>
        </div>

        {/* Selected Tables */}
        {selectedTables.length > 0 && (
          <div className="space-y-2">
            <Label>Selected Tables</Label>
            <div className="space-y-2">
              {selectedTables.map((table, index) => (
                <div
                  key={table!.id}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{index + 1}</Badge>
                    <span className="text-sm">{table!.name}</span>
                    <span className="text-xs text-muted-foreground">
                      ({table!.rowCount} rows)
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleRemoveTable(table!.id)}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Validate Button - stays visible, changes style when validated */}
        {stackTableIds.length === 2 && (
          <Button
            variant={stackValidation ? 'default' : 'outline'}
            className={stackValidation ? 'bg-green-600 hover:bg-green-700' : ''}
            onClick={handleValidate}
          >
            {stackValidation ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Validated
              </>
            ) : (
              'Validate Compatibility'
            )}
          </Button>
        )}

        {/* Validation Results */}
        {stackValidation && (
          <ValidationWarnings warnings={stackValidation.warnings} />
        )}

        {/* Result Table Name */}
        {stackTableIds.length === 2 && (
          <div className="space-y-2">
            <Label htmlFor="stack-result-name">Result Table Name</Label>
            <Input
              id="stack-result-name"
              data-testid="stack-result-name-input"
              value={resultTableName}
              onChange={(e) => setResultTableName(e.target.value)}
              placeholder="e.g., combined_sales"
            />
          </div>
        )}

        {/* Stack Button */}
        <div className="pt-4 mt-auto">
          <Button
            className="w-full"
            onClick={handleStack}
            disabled={
              stackTableIds.length < 2 ||
              !resultTableName.trim() ||
              isProcessing
            }
            data-testid="combiner-stack-btn"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Stacking...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Stack Tables
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
