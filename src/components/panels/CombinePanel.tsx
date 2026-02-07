import { Layers, Link2, Play, Loader2, X, Sparkles, Merge, Check, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TableCombobox } from '@/components/ui/table-combobox'
import { ColumnCombobox } from '@/components/ui/combobox'
import { ValidationWarnings } from '@/features/combiner/components/ValidationWarnings'
import { useTableStore } from '@/stores/tableStore'
import { useCombinerStore } from '@/stores/combinerStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { validateStack, validateJoin, autoCleanKeys, validateStackFromMetadata, validateJoinFromMetadata } from '@/lib/combiner-engine'
import { getTableColumns, tableExists } from '@/lib/duckdb'
import { createCommand } from '@/lib/commands'
import { isInternalColumn } from '@/lib/commands/utils/column-ordering'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import { toast } from 'sonner'
import type { JoinType, TableInfo } from '@/types'
import { useOperationStore } from '@/stores/operationStore'

export function CombinePanel() {
  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)
  const updateTable = useTableStore((s) => s.updateTable)
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
    combineProgress,
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
    setCombineProgress,
    setError,
  } = useCombinerStore()

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()


  // Handle mode change - clear validation state
  const handleModeChange = (newMode: 'stack' | 'join') => {
    setMode(newMode)
    // Clear validation state when switching modes
    setStackValidation(null)
    setJoinValidation(null)
  }

  // Stack handlers
  const handleAddTable = (tableId: string, _tableName: string) => {
    if (tableId && !stackTableIds.includes(tableId) && stackTableIds.length < 2) {
      addStackTable(tableId)
      setStackValidation(null)
    }
  }

  const handleRemoveTable = (id: string) => {
    removeStackTable(id)
    setStackValidation(null)
  }

  // Reorder tables for stack
  const moveTableUp = (index: number) => {
    if (index <= 0) return
    // Need to swap by removing and re-adding in correct order
    const currentIds = [...stackTableIds]
    const temp = currentIds[index]
    currentIds[index] = currentIds[index - 1]
    currentIds[index - 1] = temp
    // Clear and re-add
    stackTableIds.forEach(id => removeStackTable(id))
    currentIds.forEach(id => addStackTable(id))
    setStackValidation(null)
  }

  const moveTableDown = (index: number) => {
    if (index >= stackTableIds.length - 1) return
    const currentIds = [...stackTableIds]
    const temp = currentIds[index]
    currentIds[index] = currentIds[index + 1]
    currentIds[index + 1] = temp
    // Clear and re-add
    stackTableIds.forEach(id => removeStackTable(id))
    currentIds.forEach(id => addStackTable(id))
    setStackValidation(null)
  }

  const handleValidateStack = async () => {
    if (stackTableIds.length < 2) return
    const tableA = tables.find((t) => t.id === stackTableIds[0])
    const tableB = tables.find((t) => t.id === stackTableIds[1])
    if (!tableA || !tableB) return

    try {
      // Check if both tables are in DuckDB
      const aInDuckDB = await tableExists(tableA.name)
      const bInDuckDB = await tableExists(tableB.name)

      if (aInDuckDB && bInDuckDB) {
        // Both in DuckDB — use original validation (queries actual data)
        const validation = await validateStack(tableA.name, tableB.name)
        setStackValidation(validation)
      } else {
        // At least one frozen — use metadata-based validation
        const validation = validateStackFromMetadata(
          tableA.columns,
          tableB.columns,
          tableA.name,
          tableB.name
        )
        setStackValidation(validation)
      }
    } catch (error) {
      console.error('Validation failed:', error)
    }
  }

  const handleStack = async () => {
    if (stackTableIds.length < 2 || !resultTableName.trim()) return

    const tableA = tables.find((t) => t.id === stackTableIds[0])
    const tableB = tables.find((t) => t.id === stackTableIds[1])
    if (!tableA || !tableB) return

    const opId = useOperationStore.getState().registerOperation('combine', `Stacking "${tableA.name}" + "${tableB.name}"`)
    setIsProcessing(true)
    try {
      // Create and execute command via CommandExecutor with confirmation if discarding redo states
      const command = createCommand('combine:stack', {
        tableId: tableA.id,
        sourceTableA: tableA.name,
        sourceTableB: tableB.name,
        resultTableName: resultTableName.trim(),
      })

      const result = await executeWithConfirmation(command, tableA.id, {
        skipAudit: true, // We'll log audit to result table manually
      })

      // User cancelled the confirmation dialog
      if (!result) {
        setIsProcessing(false)
        useOperationStore.getState().deregisterOperation(opId)
        return
      }

      if (!result.success) {
        throw new Error(result.error || 'Stack operation failed')
      }

      const rowCount = result.executionResult?.rowCount || 0
      const columns = await getTableColumns(resultTableName.trim())

      // Calculate column order: union of source table columns (first appearance)
      const sourceTableInfos = stackTableIds.map(id =>
        tables.find(t => t.id === id)
      ).filter(Boolean) as TableInfo[]

      const columnOrder: string[] = []
      const seen = new Set<string>()

      for (const table of sourceTableInfos) {
        const tableOrder = table.columnOrder || table.columns.map(c => c.name)
        for (const col of tableOrder) {
          if (!seen.has(col) && !isInternalColumn(col)) {
            columnOrder.push(col)
            seen.add(col)
          }
        }
      }

      const newTableId = addTable(
        resultTableName.trim(),
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount
      )

      // Immediately update with columnOrder
      updateTable(newTableId, { columnOrder })

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
      setCombineProgress(null)
      useOperationStore.getState().deregisterOperation(opId)
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
      const leftInDuckDB = await tableExists(leftTable.name)
      const rightInDuckDB = await tableExists(rightTable.name)

      if (leftInDuckDB && rightInDuckDB) {
        // Both in DuckDB — use original validation (includes whitespace check)
        const validation = await validateJoin(leftTable.name, rightTable.name, keyColumn)
        setJoinValidation(validation)
      } else {
        // At least one frozen — use metadata-based validation (no whitespace check)
        const validation = validateJoinFromMetadata(
          leftTable.columns,
          rightTable.columns,
          leftTable.name,
          rightTable.name,
          keyColumn
        )
        setJoinValidation(validation)
      }
    } catch (error) {
      console.error('Validation failed:', error)
    }
  }

  const handleAutoClean = async () => {
    if (!leftTable || !rightTable || !keyColumn) return
    // Auto-clean requires both tables in DuckDB (modifies source data)
    const leftInDB = await tableExists(leftTable.name)
    const rightInDB = await tableExists(rightTable.name)
    if (!leftInDB || !rightInDB) {
      toast.error('Auto-Clean Not Available', {
        description: 'Load both tables first to auto-clean keys.',
      })
      return
    }
    const opId = useOperationStore.getState().registerOperation('combine', 'Auto-cleaning join keys')
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
      useOperationStore.getState().deregisterOperation(opId)
    }
  }

  const handleJoin = async () => {
    if (!leftTable || !rightTable || !keyColumn || !resultTableName.trim()) return

    const opId = useOperationStore.getState().registerOperation('combine', `Joining "${leftTable.name}" + "${rightTable.name}"`)
    setIsProcessing(true)
    try {
      // Create and execute command via CommandExecutor with confirmation if discarding redo states
      const command = createCommand('combine:join', {
        tableId: leftTable.id,
        leftTableName: leftTable.name,
        rightTableName: rightTable.name,
        keyColumn,
        joinType,
        resultTableName: resultTableName.trim(),
      })

      const result = await executeWithConfirmation(command, leftTable.id, {
        skipAudit: true, // We'll log audit to result table manually
      })

      // User cancelled the confirmation dialog
      if (!result) {
        setIsProcessing(false)
        useOperationStore.getState().deregisterOperation(opId)
        return
      }

      if (!result.success) {
        throw new Error(result.error || 'Join operation failed')
      }

      const rowCount = result.executionResult?.rowCount || 0
      const columns = await getTableColumns(resultTableName.trim())

      // Calculate column order: left + right (excluding duplicate join key)
      // Use leftTable and rightTable from closure (already validated at function entry)
      const leftOrder = leftTable.columnOrder || leftTable.columns.map(c => c.name)
      const rightOrder = rightTable.columnOrder || rightTable.columns.map(c => c.name)

      const columnOrder = [
        ...leftOrder.filter(col => !isInternalColumn(col)),
        ...rightOrder.filter(col => col !== keyColumn && !isInternalColumn(col))
      ]

      const newTableId = addTable(
        resultTableName.trim(),
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount
      )

      // Immediately update with columnOrder
      updateTable(newTableId, { columnOrder })

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
      setCombineProgress(null)
      useOperationStore.getState().deregisterOperation(opId)
    }
  }

  const selectedTables = stackTableIds.map((id) => tables.find((t) => t.id === id)).filter(Boolean)
  const hasWhitespaceWarning = joinValidation?.warnings.some((w) => w.includes('whitespace'))

  // Prepare table options for combobox
  const tableOptions = tables.map(t => ({ id: t.id, name: t.name, rowCount: t.rowCount }))

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

  // Determine if right column should show config (stack: 2 tables, join: both tables selected)
  const showStackConfig = mode === 'stack' && stackTableIds.length === 2
  const showJoinConfig = mode === 'join' && leftTableId && rightTableId

  return (
    <Tabs value={mode} onValueChange={(v) => handleModeChange(v as 'stack' | 'join')} className="flex h-full">
      {/* Left Column: Mode Selection & Table Selection */}
      <div className="w-[340px] border-r border-border/50 flex flex-col">
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
          {/* Stack Tab - Left Column */}
          <TabsContent value="stack" className="mt-0 p-4 space-y-4">
            <div className="space-y-2">
              <Label>Add Tables to Stack</Label>
              <TableCombobox
                tables={tableOptions}
                value={null}
                onValueChange={handleAddTable}
                placeholder="Select a table to add..."
                disabled={stackTableIds.length >= 2 || isProcessing}
                excludeIds={stackTableIds}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Select 2 tables to combine their rows
              </p>
            </div>

            {selectedTables.length > 0 && (
              <div className="space-y-2">
                <Label>Selected Tables ({selectedTables.length}/2)</Label>
                <div className="space-y-2">
                  {selectedTables.map((table, index) => (
                    <div key={table!.id} className="flex items-center justify-between p-2 bg-muted rounded-lg">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Badge variant="outline" className="shrink-0">{index + 1}</Badge>
                        <span className="text-sm truncate">{table!.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          ({table!.rowCount.toLocaleString()} rows)
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        {stackTableIds.length === 2 && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => moveTableUp(index)}
                              disabled={index === 0 || isProcessing}
                            >
                              <ArrowUp className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => moveTableDown(index)}
                              disabled={index === stackTableIds.length - 1 || isProcessing}
                            >
                              <ArrowDown className="w-3 h-3" />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleRemoveTable(table!.id)}
                          disabled={isProcessing}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* Join Tab - Left Column */}
          <TabsContent value="join" className="mt-0 p-4 space-y-4">
            <div className="space-y-2">
              <Label>Left Table</Label>
              <TableCombobox
                tables={tableOptions}
                value={leftTableId}
                onValueChange={(id, _name) => {
                  setLeftTableId(id)
                  setKeyColumn(null)
                  setJoinValidation(null)
                }}
                placeholder="Select left table..."
                disabled={isProcessing}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label>Right Table</Label>
              <TableCombobox
                tables={tableOptions}
                value={rightTableId}
                onValueChange={(id, _name) => {
                  setRightTableId(id)
                  setKeyColumn(null)
                  setJoinValidation(null)
                }}
                placeholder="Select right table..."
                disabled={isProcessing}
                excludeIds={leftTableId ? [leftTableId] : []}
              />
            </div>
          </TabsContent>
        </ScrollArea>
      </div>

      {/* Right Column: Configuration */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col justify-center p-4">
          {/* Stack Config */}
          {mode === 'stack' && showStackConfig && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Stack Info Card */}
              <div className="bg-muted rounded-lg p-3 space-y-3">
                <div>
                  <h3 className="font-medium flex items-center gap-2">
                    <Layers className="w-4 h-4" />
                    Stack Tables (UNION ALL)
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Combine rows from both tables vertically
                  </p>
                </div>

                <div className="border-t border-border/50 pt-2">
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Preview</p>
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-muted-foreground">{selectedTables[0]?.name}</span>
                    <span className="text-muted-foreground">({selectedTables[0]?.rowCount} rows)</span>
                    <span className="text-muted-foreground">+</span>
                    <span className="text-muted-foreground">{selectedTables[1]?.name}</span>
                    <span className="text-muted-foreground">({selectedTables[1]?.rowCount} rows)</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-mono mt-1">
                    <span className="text-muted-foreground">→</span>
                    <span className="text-green-700 dark:text-green-400/80">
                      {(selectedTables[0]?.rowCount || 0) + (selectedTables[1]?.rowCount || 0)} rows
                    </span>
                  </div>
                </div>

                <div className="border-t border-border/50 pt-2">
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    <li className="flex items-start gap-1.5">
                      <span className="text-blue-600 dark:text-blue-400">•</span>
                      Tables can have different columns - missing values become NULL
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-blue-600 dark:text-blue-400">•</span>
                      Reorder tables above to control row order in result
                    </li>
                  </ul>
                </div>
              </div>

              {/* Validate Button */}
              <Button
                variant="outline"
                onClick={handleValidateStack}
                className={`w-full ${stackValidation ? 'bg-green-600 hover:bg-green-700 text-white border-green-600' : ''}`}
                disabled={isProcessing}
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

              {stackValidation && <ValidationWarnings warnings={stackValidation.warnings} />}

              {/* Result Table Name */}
              <div className="space-y-2">
                <Label>Result Table Name</Label>
                <Input
                  value={resultTableName}
                  onChange={(e) => setResultTableName(e.target.value)}
                  placeholder="e.g., combined_sales"
                  disabled={isProcessing}
                />
              </div>

              {/* Stack Button */}
              <Button
                className="w-full"
                onClick={handleStack}
                disabled={!resultTableName.trim() || isProcessing}
                data-testid="combiner-stack-btn"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {combineProgress ? (
                      combineProgress.phase === 'schema' ? 'Analyzing schemas...' :
                      combineProgress.phase === 'hydrating' ? `Processing shard ${combineProgress.current}/${combineProgress.total}...` :
                      combineProgress.phase === 'finalizing' ? 'Importing result...' :
                      'Stacking...'
                    ) : 'Stacking...'}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Stack Tables
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Join Config */}
          {mode === 'join' && showJoinConfig && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Join Info Card */}
              <div className="bg-muted rounded-lg p-3 space-y-3">
                <div>
                  <h3 className="font-medium flex items-center gap-2">
                    <Link2 className="w-4 h-4" />
                    Join Tables
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Combine tables horizontally by matching rows on a key column
                  </p>
                </div>

                <div className="border-t border-border/50 pt-2">
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Example</p>
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-red-600 dark:text-red-400/80">orders.customer_id</span>
                    <span className="text-muted-foreground">=</span>
                    <span className="text-green-700 dark:text-green-400/80">customers.customer_id</span>
                  </div>
                </div>
              </div>

              {/* Key Column */}
              {commonColumns.length > 0 ? (
                <div className="space-y-2">
                  <Label>Key Column</Label>
                  <ColumnCombobox
                    columns={commonColumns}
                    value={keyColumn || ''}
                    onValueChange={(v) => {
                      setKeyColumn(v)
                      setJoinValidation(null)
                    }}
                    placeholder="Select key column..."
                    disabled={isProcessing}
                  />
                  <p className="text-xs text-muted-foreground">
                    {commonColumns.length} column{commonColumns.length !== 1 ? 's' : ''} shared between tables
                  </p>
                </div>
              ) : (
                <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  <p className="text-sm text-destructive">
                    No common columns found between the selected tables
                  </p>
                </div>
              )}

              {/* Join Type */}
              {keyColumn && (
                <div className="space-y-2">
                  <Label>Join Type</Label>
                  <RadioGroup
                    value={joinType}
                    onValueChange={(v) => setJoinType(v as JoinType)}
                    className="space-y-2"
                  >
                    <div
                      className={`flex items-start space-x-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        joinType === 'inner' ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/50'
                      }`}
                      onClick={() => setJoinType('inner')}
                    >
                      <RadioGroupItem value="inner" id="inner" className="mt-0.5" />
                      <div className="flex-1">
                        <label htmlFor="inner" className="text-sm font-medium cursor-pointer">Inner Join</label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Only rows with matching keys in both tables
                        </p>
                      </div>
                    </div>
                    <div
                      className={`flex items-start space-x-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        joinType === 'left' ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/50'
                      }`}
                      onClick={() => setJoinType('left')}
                    >
                      <RadioGroupItem value="left" id="left" className="mt-0.5" />
                      <div className="flex-1">
                        <label htmlFor="left" className="text-sm font-medium cursor-pointer">Left Join</label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          All rows from left table, matching from right
                        </p>
                      </div>
                    </div>
                    <div
                      className={`flex items-start space-x-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        joinType === 'full_outer' ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/50'
                      }`}
                      onClick={() => setJoinType('full_outer')}
                    >
                      <RadioGroupItem value="full_outer" id="full_outer" className="mt-0.5" />
                      <div className="flex-1">
                        <label htmlFor="full_outer" className="text-sm font-medium cursor-pointer">Full Outer Join</label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          All rows from both tables, NULLs where no match
                        </p>
                      </div>
                    </div>
                  </RadioGroup>
                </div>
              )}

              {/* Validate Button */}
              {keyColumn && (
                <Button
                  variant="outline"
                  onClick={handleValidateJoin}
                  className={`w-full ${joinValidation ? 'bg-green-600 hover:bg-green-700 text-white border-green-600' : ''}`}
                  disabled={isProcessing}
                >
                  {joinValidation ? (
                    <>
                      <Check className="w-4 h-4 mr-2" />
                      Validated
                    </>
                  ) : (
                    'Validate Join'
                  )}
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

              {/* Result Table Name */}
              {keyColumn && (
                <div className="space-y-2">
                  <Label>Result Table Name</Label>
                  <Input
                    value={resultTableName}
                    onChange={(e) => setResultTableName(e.target.value)}
                    placeholder="e.g., orders_with_customers"
                    disabled={isProcessing}
                  />
                </div>
              )}

              {/* Join Button */}
              {keyColumn && (
                <Button
                  className="w-full"
                  onClick={handleJoin}
                  disabled={!resultTableName.trim() || isProcessing}
                  data-testid="combiner-join-btn"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {combineProgress ? (
                        combineProgress.phase === 'schema' ? 'Analyzing schemas...' :
                        combineProgress.phase === 'indexing' ? `Building key index (${combineProgress.current}/${combineProgress.total})...` :
                        combineProgress.phase === 'joining' ? 'Matching keys...' :
                        combineProgress.phase === 'hydrating' ? `Building result (${combineProgress.current}/${combineProgress.total})...` :
                        combineProgress.phase === 'finalizing' ? 'Importing result...' :
                        'Joining...'
                      ) : 'Joining...'}
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
          )}

          {/* Stack Empty State */}
          {mode === 'stack' && !showStackConfig && (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-6">
              <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                <Layers className="w-6 h-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1">Stack Tables</h3>
              <p className="text-sm text-muted-foreground">
                Select at least 2 tables from the left to stack
              </p>
            </div>
          )}

          {/* Join Empty State */}
          {mode === 'join' && !showJoinConfig && (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-6">
              <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                <Link2 className="w-6 h-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1">Join Tables</h3>
              <p className="text-sm text-muted-foreground">
                Select Left and Right tables from the left to configure join
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />
    </Tabs>
  )
}
