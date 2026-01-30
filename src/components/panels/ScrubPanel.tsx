import { useState } from 'react'
import { Shield, Eye, Loader2, Key, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TableCombobox } from '@/components/ui/table-combobox'
import { ColumnCombobox } from '@/components/ui/combobox'
import { useTableStore } from '@/stores/tableStore'
import { useScrubberStore } from '@/stores/scrubberStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { applyObfuscationRules, OBFUSCATION_METHODS } from '@/lib/obfuscation'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import type { CommandType } from '@/lib/commands'
import type { ObfuscationMethod } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// Map ObfuscationMethod to CommandType for supported methods
const METHOD_TO_COMMAND: Partial<Record<ObfuscationMethod, CommandType>> = {
  hash: 'scrub:hash',
  mask: 'scrub:mask',
  redact: 'scrub:redact',
  year_only: 'scrub:year_only',
}

// Methods that are supported by command pattern (in-place modification)
const SUPPORTED_COMMAND_METHODS = new Set(['hash', 'mask', 'redact', 'year_only'])

// Method examples for the info card
const METHOD_EXAMPLES: Record<string, Array<{ before: string; after: string }>> = {
  hash: [{ before: 'john@email.com', after: 'a8f5e2b1...' }],
  mask: [{ before: '555-123-4567', after: '5**-***-**67' }],
  redact: [{ before: 'John Smith', after: '[REDACTED]' }],
  year_only: [{ before: '1985-03-15', after: '1985-01-01' }],
  faker: [{ before: 'john@email.com', after: 'sara@example.net' }],
  scramble: [{ before: '123456789', after: '918372465' }],
  last4: [{ before: '4532-1234-5678-9012', after: '****-****-****-9012' }],
  zero: [{ before: '$50,000', after: '$0' }],
  jitter: [{ before: '2024-01-15', after: '2024-01-18' }],
}

// Method hints
const METHOD_HINTS: Record<string, string[]> = {
  hash: ['Requires project secret for consistent results', 'One-way transformation - cannot be reversed'],
  mask: ['Preserves first and last characters', 'Good for partial identification'],
  redact: ['Completely removes the value', 'Best for maximum privacy'],
  year_only: ['Converts dates to year only', 'Useful for birth dates'],
}

export function ScrubPanel() {
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)

  const closePanel = usePreviewStore((s) => s.closePanel)

  const { getData } = useDuckDB()

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  const {
    tableId,
    tableName,
    secret,
    rules,
    keyMapEnabled,
    keyMap,
    isProcessing,
    setTable,
    setSecret,
    addRule,
    removeRule,
    updateRule,
    setKeyMapEnabled,
    clearKeyMap,
    setIsProcessing,
  } = useScrubberStore()

  // Local state for the selected rule being edited
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<Record<string, unknown>[]>([])

  const selectedTable = tables.find((t) => t.id === tableId)
  const tableOptions = tables.map(t => ({ id: t.id, name: t.name, rowCount: t.rowCount }))

  // Get columns that don't have rules yet
  const availableColumns = selectedTable?.columns
    .map(c => c.name)
    .filter(col => !rules.some(r => r.column === col)) || []

  // Get the rule for the selected column
  const selectedRule = rules.find(r => r.column === selectedColumn)
  const selectedMethod = selectedRule?.method || null

  const handleTableSelect = (id: string, name: string) => {
    setTable(id, name)
    setPreviewData([])
    clearKeyMap()
    setSelectedColumn(null)
  }

  // Add a column and auto-select it
  const handleAddColumn = (column: string) => {
    if (!column || rules.some(r => r.column === column)) return
    // Add rule with no method initially
    addRule({ column, method: 'redact' }) // Default to redact
    setSelectedColumn(column)
  }

  const handleRemoveColumn = (column: string) => {
    removeRule(column)
    if (selectedColumn === column) {
      setSelectedColumn(null)
    }
  }

  const handleMethodChange = (method: ObfuscationMethod) => {
    if (!selectedColumn) return
    updateRule(selectedColumn, method)
  }

  const handlePreview = async () => {
    if (!tableName || rules.length === 0) return

    setIsProcessing(true)
    try {
      const data = await getData(tableName, 0, 10)
      const obfuscated = await applyObfuscationRules(
        data,
        rules,
        secret,
        keyMapEnabled ? keyMap : undefined
      )
      setPreviewData(obfuscated)
      toast.success('Preview Generated', {
        description: 'Showing first 10 rows with obfuscation applied',
      })
    } catch (error) {
      console.error('Preview failed:', error)
      toast.error('Preview Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleApply = async () => {
    if (!tableName || !tableId || rules.length === 0) return

    // Filter rules to only those supported by command pattern
    const supportedRules = rules.filter((r) => SUPPORTED_COMMAND_METHODS.has(r.method))
    const unsupportedRules = rules.filter((r) => !SUPPORTED_COMMAND_METHODS.has(r.method))

    if (supportedRules.length === 0) {
      toast.error('No Supported Rules', {
        description: 'Select hash, mask, redact, or year_only methods to apply in-place',
      })
      return
    }

    // Hash requires a secret
    const hasHashRule = supportedRules.some((r) => r.method === 'hash')
    if (hasHashRule && !secret) {
      toast.error('Secret Required', {
        description: 'Please enter a project secret for consistent hashing',
      })
      return
    }

    setIsProcessing(true)
    const executor = getCommandExecutor()
    let successCount = 0
    let totalAffected = 0
    let isFirstCommand = true

    try {
      // Execute one command per rule (per-column granularity)
      // First command uses executeWithConfirmation to check for redo states
      // Subsequent commands execute directly (user already confirmed)
      for (const rule of supportedRules) {
        const commandType = METHOD_TO_COMMAND[rule.method]
        if (!commandType) continue

        // Build command params based on method
        const baseParams = { tableId, column: rule.column }
        let command

        switch (rule.method) {
          case 'hash':
            command = createCommand(commandType, { ...baseParams, secret })
            break
          case 'mask':
            command = createCommand(commandType, { ...baseParams, preserveFirst: 1, preserveLast: 1 })
            break
          case 'redact':
            command = createCommand(commandType, { ...baseParams, replacement: '[REDACTED]' })
            break
          case 'year_only':
            command = createCommand(commandType, baseParams)
            break
          default:
            continue
        }

        // First command: use confirmation dialog if there are redo states
        // Subsequent commands: execute directly since user already confirmed
        let result
        if (isFirstCommand) {
          result = await executeWithConfirmation(command, tableId)
          // User cancelled the confirmation dialog
          if (!result) {
            setIsProcessing(false)
            return
          }
          isFirstCommand = false
        } else {
          result = await executor.execute(command)
        }

        if (result.success) {
          successCount++
          totalAffected += result.executionResult?.affected || 0
        } else {
          console.error(`Failed to apply ${rule.method} to ${rule.column}:`, result.error)
          toast.error(`Failed: ${rule.column}`, {
            description: result.error || 'Unknown error',
          })
        }
      }

      // Update table store to refresh UI
      if (successCount > 0) {
        updateTable(tableId, {})

        const message = unsupportedRules.length > 0
          ? `Applied ${successCount} rules (${unsupportedRules.length} unsupported methods skipped)`
          : `Applied ${successCount} rules`

        toast.success('Scrubbing Complete', {
          description: `${message}. ${totalAffected} values modified. Use Ctrl+Z to undo.`,
        })
      }

      if (keyMapEnabled && keyMap.size > 0) {
        exportKeyMap()
      }

      closePanel()
    } catch (error) {
      console.error('Scrubbing failed:', error)
      toast.error('Scrubbing Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const exportKeyMap = () => {
    if (keyMap.size === 0) return

    const csvLines = ['Original,Obfuscated']
    keyMap.forEach((obfuscated, original) => {
      csvLines.push(`"${original.replace(/"/g, '""')}","${obfuscated}"`)
    })

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `keymap_${tableName}_${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    toast.success('Key Map Exported', {
      description: `Saved ${keyMap.size} mappings`,
    })
  }

  const getMethodInfo = (method: ObfuscationMethod | null) => {
    if (!method) return null
    return OBFUSCATION_METHODS.find((m) => m.id === method)
  }

  if (tables.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="font-medium">No tables loaded</p>
          <p className="text-sm mt-1">Import a table first to scrub sensitive data</p>
        </div>
      </div>
    )
  }

  const showRuleEditor = selectedColumn !== null

  return (
    <div className="flex h-full">
      {/* Left Column: Rule Queue */}
      <div className="w-[340px] border-r border-border/50 flex flex-col">
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {/* Table Selection */}
            <div className="space-y-2">
              <Label>Table</Label>
              <TableCombobox
                tables={tableOptions}
                value={tableId}
                onValueChange={handleTableSelect}
                placeholder="Select table..."
                disabled={isProcessing}
                autoFocus
              />
            </div>

            {/* Secret */}
            <div className="space-y-2">
              <Label>
                Project Secret
                <span className="text-xs text-muted-foreground ml-2">
                  (for consistent hashing)
                </span>
              </Label>
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Enter a secret phrase"
                disabled={isProcessing}
              />
              <p className="text-xs text-destructive/80">
                Keep this secret safe! You'll need it to match hashed values later.
              </p>
            </div>

            {/* Add Column */}
            {selectedTable && (
              <div className="space-y-2">
                <Label>Add Column to Scrub</Label>
                <ColumnCombobox
                  columns={availableColumns}
                  value=""
                  onValueChange={handleAddColumn}
                  placeholder="Select column to add..."
                  disabled={isProcessing || availableColumns.length === 0}
                />
              </div>
            )}

            {/* Rules Queue */}
            {rules.length > 0 && (
              <div className="space-y-2">
                <Label>Columns to Scrub ({rules.length})</Label>
                <div className="space-y-2">
                  {rules.map((rule) => {
                    const methodInfo = getMethodInfo(rule.method)
                    const isSelected = selectedColumn === rule.column
                    return (
                      <div
                        key={rule.column}
                        className={cn(
                          'flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors',
                          isSelected
                            ? 'bg-primary/10 border border-primary/30'
                            : 'bg-muted/50 border border-transparent hover:bg-muted/80'
                        )}
                        onClick={() => setSelectedColumn(rule.column)}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-sm font-medium truncate">{rule.column}</span>
                          {methodInfo && (
                            <Badge variant="secondary" className="text-xs shrink-0">
                              {methodInfo.label}
                            </Badge>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRemoveColumn(rule.column)
                          }}
                          disabled={isProcessing}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Key Map Option */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="keymap"
                checked={keyMapEnabled}
                onCheckedChange={(checked) => setKeyMapEnabled(checked === true)}
                disabled={isProcessing}
              />
              <Label htmlFor="keymap" className="text-sm cursor-pointer">
                Generate Key Map (for reversibility)
              </Label>
            </div>
          </div>
        </ScrollArea>

        {/* Action Buttons in Left Column Footer */}
        <div className="p-4 border-t border-border/50 space-y-2">
          {keyMapEnabled && keyMap.size > 0 && (
            <Button variant="outline" className="w-full" onClick={exportKeyMap} disabled={isProcessing}>
              <Key className="w-4 h-4 mr-2" />
              Export Key Map ({keyMap.size})
            </Button>
          )}

          <Button
            variant="outline"
            className="w-full"
            onClick={handlePreview}
            disabled={!tableId || rules.length === 0 || isProcessing}
          >
            <Eye className="w-4 h-4 mr-2" />
            Preview
          </Button>

          <Button
            className="w-full"
            onClick={handleApply}
            disabled={!tableId || rules.length === 0 || isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Apply Scrub Rules
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Right Column: Rule Editor */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col justify-center p-4">
          {showRuleEditor && selectedColumn ? (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Info Card */}
              <div className="bg-muted/30 rounded-lg p-3 space-y-3">
                <div>
                  <h3 className="font-medium flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    Configure Obfuscation
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Column: <span className="font-medium text-foreground">{selectedColumn}</span>
                  </p>
                </div>

                {/* Method Examples */}
                {selectedMethod && METHOD_EXAMPLES[selectedMethod] && (
                  <div className="border-t border-border/50 pt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Example</p>
                    <div className="space-y-1">
                      {METHOD_EXAMPLES[selectedMethod].map((ex, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs font-mono">
                          <span className="text-red-400/80">{ex.before}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-green-400/80">{ex.after}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Method Hints */}
                {selectedMethod && METHOD_HINTS[selectedMethod] && (
                  <div className="border-t border-border/50 pt-2">
                    <ul className="text-xs text-muted-foreground space-y-0.5">
                      {METHOD_HINTS[selectedMethod].map((hint, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="text-blue-400">•</span>
                          {hint}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Method Selector */}
              <div className="space-y-2">
                <Label>Obfuscation Method</Label>
                <Select
                  value={selectedMethod || ''}
                  onValueChange={(v) => handleMethodChange(v as ObfuscationMethod)}
                  disabled={isProcessing}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select method..." />
                  </SelectTrigger>
                  <SelectContent>
                    {/* String Methods */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                      String Methods
                    </div>
                    {OBFUSCATION_METHODS.filter((m) => m.category === 'string').map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <div className="flex flex-col">
                          <span>{m.label}</span>
                          <span className="text-xs text-muted-foreground">{m.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                    {/* Number Methods */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground mt-1">
                      Number Methods
                    </div>
                    {OBFUSCATION_METHODS.filter((m) => m.category === 'number').map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <div className="flex flex-col">
                          <span>{m.label}</span>
                          <span className="text-xs text-muted-foreground">{m.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                    {/* Date Methods */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground mt-1">
                      Date Methods
                    </div>
                    {OBFUSCATION_METHODS.filter((m) => m.category === 'date').map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <div className="flex flex-col">
                          <span>{m.label}</span>
                          <span className="text-xs text-muted-foreground">{m.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Supported Methods Note */}
              {selectedMethod && !SUPPORTED_COMMAND_METHODS.has(selectedMethod) && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
                  <p className="text-sm text-yellow-600 dark:text-yellow-400">
                    Note: {getMethodInfo(selectedMethod)?.label} is preview-only and will be skipped during apply.
                    Only Hash, Mask, Redact, and Year Only are supported for in-place modification.
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Empty State */
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-6">
              <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                <Shield className="w-6 h-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1">Configure Obfuscation</h3>
              <p className="text-sm text-muted-foreground">
                {tableId
                  ? 'Add a column from the left to configure its scrub method'
                  : 'Select a table first, then add columns to scrub'}
              </p>
            </div>
          )}

          {/* Preview Data (shown below editor when available) */}
          {previewData.length > 0 && (
            <div className="mt-4 space-y-2">
              <Label>Preview (First 10 rows)</Label>
              <div className="max-h-40 overflow-auto border rounded-lg p-2 bg-muted/30">
                <pre className="text-xs">
                  {JSON.stringify(previewData.slice(0, 3), (_, v) =>
                    typeof v === 'bigint' ? v.toString() : v, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />
    </div>
  )
}
