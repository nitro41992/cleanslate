import { useState } from 'react'
import { Layers, Link2, Play, Loader2, X, Sparkles, Merge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ValidationWarnings } from '@/features/combiner/components/ValidationWarnings'
import { useTableStore } from '@/stores/tableStore'
import { useCombinerStore } from '@/stores/combinerStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { validateStack, validateJoin, autoCleanKeys } from '@/lib/combiner-engine'
import { getTableColumns } from '@/lib/duckdb'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import { toast } from 'sonner'
import type { JoinType } from '@/types'

export function CombinePanel() {
  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)
  const setActiveTable = useTableStore((s) => s.setActiveTable)

  const setPreviewActiveTable = usePreviewStore((s) => s.setActiveTable)
  const closePanel = usePreviewStore((s) => s.closePanel)

  const addAuditEntry = useAuditStore((s) => s.addTransformationEntry)

  const {
    mode,
    stackTableIds,
    stackValidation,
    leftTableId,
    rightTableId,
    keyColumn,
    joinType,
    joinValidation,
    resultTableName,
    isProcessing,
    setMode,
    addStackTable,
    removeStackTable,
    setStackValidation,
    setLeftTableId,
    setRightTableId,
    setKeyColumn,
    setJoinType,
    setJoinValidation,
    setResultTableName,
    setIsProcessing,
    setError,
  } = useCombinerStore()

  const [selectedTable, setSelectedTable] = useState<string>('')

  // Stack handlers
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

  const handleValidateStack = async () => {
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
      // Create and execute command via CommandExecutor
      const command = createCommand('combine:stack', {
        tableId: tableA.id,
        sourceTableA: tableA.name,
        sourceTableB: tableB.name,
        resultTableName: resultTableName.trim(),
      })

      const executor = getCommandExecutor()
      const result = await executor.execute(command, {
        skipAudit: true, // We'll log audit to result table manually
      })

      if (!result.success) {
        throw new Error(result.error || 'Stack operation failed')
      }

      const rowCount = result.executionResult?.rowCount || 0
      const columns = await getTableColumns(resultTableName.trim())
      const newTableId = addTable(
        resultTableName.trim(),
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount
      )

      // Add audit entry to the result table
      addAuditEntry({
        tableId: newTableId,
        tableName: resultTableName.trim(),
        action: 'Stack Tables',
        details: `Stacked "${tableA.name}" + "${tableB.name}" → ${rowCount} rows`,
        rowsAffected: rowCount,
        hasRowDetails: false,
        auditEntryId: command.id,
      })

      toast.success('Tables Stacked', {
        description: `Created "${resultTableName}" with ${rowCount} rows`,
      })

      // Set as active table and close panel
      setActiveTable(newTableId)
      setPreviewActiveTable(newTableId, resultTableName.trim())
      setResultTableName('')
      setStackValidation(null)
      closePanel()
    } catch (error) {
      console.error('Stack failed:', error)
      setError(error instanceof Error ? error.message : 'Stack operation failed')
      toast.error('Stack Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  // Join handlers
  const leftTable = tables.find((t) => t.id === leftTableId)
  const rightTable = tables.find((t) => t.id === rightTableId)
  const commonColumns = leftTable && rightTable
    ? leftTable.columns.map((c) => c.name).filter((c) => rightTable.columns.some((rc) => rc.name === c))
    : []

  const handleValidateJoin = async () => {
    if (!leftTable || !rightTable || !keyColumn) return
    try {
      const validation = await validateJoin(leftTable.name, rightTable.name, keyColumn)
      setJoinValidation(validation)
    } catch (error) {
      console.error('Validation failed:', error)
    }
  }

  const handleAutoClean = async () => {
    if (!leftTable || !rightTable || !keyColumn) return
    setIsProcessing(true)
    try {
      const { cleanedA, cleanedB } = await autoCleanKeys(leftTable.name, rightTable.name, keyColumn)
      toast.success('Keys Cleaned', {
        description: `Trimmed whitespace from ${cleanedA} rows in ${leftTable.name} and ${cleanedB} rows in ${rightTable.name}`,
      })
      await handleValidateJoin()
    } catch (error) {
      console.error('Auto-clean failed:', error)
      toast.error('Auto-Clean Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleJoin = async () => {
    if (!leftTable || !rightTable || !keyColumn || !resultTableName.trim()) return

    setIsProcessing(true)
    try {
      // Create and execute command via CommandExecutor
      const command = createCommand('combine:join', {
        tableId: leftTable.id,
        leftTableName: leftTable.name,
        rightTableName: rightTable.name,
        keyColumn,
        joinType,
        resultTableName: resultTableName.trim(),
      })

      const executor = getCommandExecutor()
      const result = await executor.execute(command, {
        skipAudit: true, // We'll log audit to result table manually
      })

      if (!result.success) {
        throw new Error(result.error || 'Join operation failed')
      }

      const rowCount = result.executionResult?.rowCount || 0
      const columns = await getTableColumns(resultTableName.trim())
      const newTableId = addTable(
        resultTableName.trim(),
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount
      )

      const joinTypeLabel = joinType === 'inner' ? 'Inner' : joinType === 'left' ? 'Left' : 'Full Outer'

      // Add audit entry to the result table
      addAuditEntry({
        tableId: newTableId,
        tableName: resultTableName.trim(),
        action: `${joinTypeLabel} Join Tables`,
        details: `Joined "${leftTable.name}" + "${rightTable.name}" on "${keyColumn}" → ${rowCount} rows`,
        rowsAffected: rowCount,
        hasRowDetails: false,
        auditEntryId: command.id,
      })

      toast.success('Tables Joined', {
        description: `Created "${resultTableName}" with ${rowCount} rows (${joinTypeLabel} Join)`,
      })

      // Set as active table and close panel
      setActiveTable(newTableId)
      setPreviewActiveTable(newTableId, resultTableName.trim())
      setResultTableName('')
      setJoinValidation(null)
      closePanel()
    } catch (error) {
      console.error('Join failed:', error)
      setError(error instanceof Error ? error.message : 'Join operation failed')
      toast.error('Join Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const selectedTables = stackTableIds.map((id) => tables.find((t) => t.id === id)).filter(Boolean)
  const availableTables = tables.filter((t) => !stackTableIds.includes(t.id))
  const hasWhitespaceWarning = joinValidation?.warnings.some((w) => w.includes('whitespace'))

  if (tables.length < 2) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <Merge className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="font-medium">Load at least 2 tables to combine</p>
          <p className="text-sm mt-1">Import tables first to stack or join them</p>
        </div>
      </div>
    )
  }

  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as 'stack' | 'join')} className="flex flex-col h-full">
      <div className="px-4 pt-4">
        <TabsList className="w-full">
          <TabsTrigger value="stack" className="flex-1" data-testid="combiner-stack-tab">
            <Layers className="w-4 h-4 mr-2" />
            Stack
          </TabsTrigger>
          <TabsTrigger value="join" className="flex-1" data-testid="combiner-join-tab">
            <Link2 className="w-4 h-4 mr-2" />
            Join
          </TabsTrigger>
        </TabsList>
      </div>

      <ScrollArea className="flex-1">
        {/* Stack Tab */}
        <TabsContent value="stack" className="mt-0 p-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Combine rows from multiple tables vertically (UNION ALL).
          </p>

          <div className="space-y-2">
            <Label>Select Tables to Stack</Label>
            <div className="flex gap-2">
              <Select value={selectedTable} onValueChange={setSelectedTable}>
                <SelectTrigger className="flex-1">
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
              <Button variant="outline" onClick={handleAddTable} disabled={!selectedTable || stackTableIds.length >= 2}>
                Add
              </Button>
            </div>
          </div>

          {selectedTables.length > 0 && (
            <div className="space-y-2">
              <Label>Selected Tables</Label>
              <div className="space-y-2">
                {selectedTables.map((table, index) => (
                  <div key={table!.id} className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{index + 1}</Badge>
                      <span className="text-sm">{table!.name}</span>
                      <span className="text-xs text-muted-foreground">({table!.rowCount} rows)</span>
                    </div>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleRemoveTable(table!.id)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stackTableIds.length === 2 && !stackValidation && (
            <Button variant="outline" onClick={handleValidateStack} className="w-full">
              Validate Compatibility
            </Button>
          )}

          {stackValidation && <ValidationWarnings warnings={stackValidation.warnings} />}

          {stackTableIds.length === 2 && (
            <div className="space-y-2">
              <Label>Result Table Name</Label>
              <Input
                value={resultTableName}
                onChange={(e) => setResultTableName(e.target.value)}
                placeholder="e.g., combined_sales"
              />
            </div>
          )}
        </TabsContent>

        {/* Join Tab */}
        <TabsContent value="join" className="mt-0 p-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Combine tables horizontally by matching rows on a key column.
          </p>

          <div className="space-y-2">
            <Label>Left Table</Label>
            <Select
              value={leftTableId || ''}
              onValueChange={(v) => {
                setLeftTableId(v)
                setKeyColumn(null)
                setJoinValidation(null)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select left table" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.rowCount} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Right Table</Label>
            <Select
              value={rightTableId || ''}
              onValueChange={(v) => {
                setRightTableId(v)
                setKeyColumn(null)
                setJoinValidation(null)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select right table" />
              </SelectTrigger>
              <SelectContent>
                {tables.filter((t) => t.id !== leftTableId).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.rowCount} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {commonColumns.length > 0 && (
            <div className="space-y-2">
              <Label>Key Column</Label>
              <Select
                value={keyColumn || ''}
                onValueChange={(v) => {
                  setKeyColumn(v)
                  setJoinValidation(null)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select key column" />
                </SelectTrigger>
                <SelectContent>
                  {commonColumns.map((col) => (
                    <SelectItem key={col} value={col}>
                      {col}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {keyColumn && (
            <div className="space-y-2">
              <Label>Join Type</Label>
              <RadioGroup
                value={joinType}
                onValueChange={(v) => setJoinType(v as JoinType)}
                className="grid grid-cols-3 gap-2"
              >
                <div className="flex items-center space-x-2 p-2 border rounded-lg">
                  <RadioGroupItem value="inner" id="inner" />
                  <Label htmlFor="inner" className="cursor-pointer text-sm">Inner</Label>
                </div>
                <div className="flex items-center space-x-2 p-2 border rounded-lg">
                  <RadioGroupItem value="left" id="left" />
                  <Label htmlFor="left" className="cursor-pointer text-sm">Left</Label>
                </div>
                <div className="flex items-center space-x-2 p-2 border rounded-lg">
                  <RadioGroupItem value="full_outer" id="full_outer" />
                  <Label htmlFor="full_outer" className="cursor-pointer text-sm">Full</Label>
                </div>
              </RadioGroup>
            </div>
          )}

          {keyColumn && !joinValidation && (
            <Button variant="outline" onClick={handleValidateJoin} className="w-full">
              Validate Join
            </Button>
          )}

          {joinValidation && (
            <>
              <ValidationWarnings warnings={joinValidation.warnings} />
              {hasWhitespaceWarning && (
                <Button variant="outline" onClick={handleAutoClean} disabled={isProcessing} className="w-full">
                  <Sparkles className="w-4 h-4 mr-2" />
                  Auto-Clean Keys
                </Button>
              )}
            </>
          )}

          {keyColumn && (
            <div className="space-y-2">
              <Label>Result Table Name</Label>
              <Input
                value={resultTableName}
                onChange={(e) => setResultTableName(e.target.value)}
                placeholder="e.g., orders_with_customers"
              />
            </div>
          )}
        </TabsContent>
      </ScrollArea>

      <Separator />

      {/* Action Button */}
      <div className="p-4">
        {mode === 'stack' ? (
          <Button
            className="w-full"
            onClick={handleStack}
            disabled={stackTableIds.length < 2 || !resultTableName.trim() || isProcessing}
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
        ) : (
          <Button
            className="w-full"
            onClick={handleJoin}
            disabled={!leftTableId || !rightTableId || !keyColumn || !resultTableName.trim() || isProcessing}
            data-testid="combiner-join-btn"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Joining...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Join Tables
              </>
            )}
          </Button>
        )}
      </div>
    </Tabs>
  )
}
