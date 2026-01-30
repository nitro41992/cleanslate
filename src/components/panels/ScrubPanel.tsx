import { useState, useCallback } from 'react'
import { Shield, Loader2, Key, Play, X, Info, Lock, EyeOff, Hash, Calendar, Shuffle, Download, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { TableCombobox } from '@/components/ui/table-combobox'
import { ColumnCombobox } from '@/components/ui/combobox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useTableStore } from '@/stores/tableStore'
import { useScrubberStore } from '@/stores/scrubberStore'
import { usePreviewStore } from '@/stores/previewStore'
import { ScrubPreview } from '@/components/scrub/ScrubPreview'
import { OBFUSCATION_METHODS, obfuscateValue } from '@/lib/obfuscation'
import { useDuckDB } from '@/hooks/useDuckDB'
import type { KeyMapEntry } from '@/stores/scrubberStore'
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

// Method icons for visual clarity
const METHOD_ICONS: Record<string, React.ReactNode> = {
  redact: <EyeOff className="w-4 h-4" />,
  mask: <Shield className="w-4 h-4" />,
  hash: <Hash className="w-4 h-4" />,
  faker: <Shuffle className="w-4 h-4" />,
  scramble: <Shuffle className="w-4 h-4" />,
  last4: <Lock className="w-4 h-4" />,
  zero: <span className="font-mono text-xs">0</span>,
  year_only: <Calendar className="w-4 h-4" />,
  jitter: <Calendar className="w-4 h-4" />,
}

// Method examples for the info card
const METHOD_EXAMPLES: Record<string, { before: string; after: string }> = {
  hash: { before: 'john@email.com', after: 'a8f5e2b1c9d3...' },
  mask: { before: '555-123-4567', after: '5*****7' },
  redact: { before: 'John Smith', after: '[REDACTED]' },
  year_only: { before: '1985-03-15', after: '1985-01-01' },
  faker: { before: 'john@email.com', after: 'sara@example.net' },
  scramble: { before: '123456789', after: '918372465' },
  last4: { before: '4532-1234-5678-9012', after: '****9012' },
  zero: { before: '$50,000', after: '$00,000' },
  jitter: { before: '2024-01-15', after: '2024-01-18' },
}

export function ScrubPanel() {
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)

  const closePanel = usePreviewStore((s) => s.closePanel)

  // Hook for executing commands with confirmation when discarding redo states
  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

  const {
    tableId,
    tableName,
    secret,
    rules,
    keyMapEnabled,
    keyMap,
    keyMapDownloaded,
    isGeneratingKeyMap,
    isProcessing,
    setTable,
    setSecret,
    addRule,
    removeRule,
    updateRule,
    setKeyMapEnabled,
    setColumnKeyMap,
    clearKeyMap,
    setKeyMapDownloaded,
    setIsGeneratingKeyMap,
    setIsProcessing,
  } = useScrubberStore()

  const { runQuery } = useDuckDB()

  // Local state for the selected rule being edited
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [secretInfoOpen, setSecretInfoOpen] = useState(false)
  const [keyMapInfoOpen, setKeyMapInfoOpen] = useState(false)

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

  /**
   * Generate key map for all configured rules.
   * Queries DISTINCT values for each column and computes obfuscated versions.
   */
  const generateKeyMap = useCallback(async () => {
    if (!tableName || rules.length === 0) return

    // Filter to supported rules only
    const supportedRules = rules.filter((r) => SUPPORTED_COMMAND_METHODS.has(r.method))
    if (supportedRules.length === 0) {
      toast.error('No Supported Rules', {
        description: 'Add columns with hash, mask, redact, or year_only methods to generate a key map',
      })
      return
    }

    // Validate hash secret if needed
    const MIN_SECRET_LENGTH = 5
    const hasHashRule = supportedRules.some((r) => r.method === 'hash')
    if (hasHashRule && (!secret || secret.length < MIN_SECRET_LENGTH)) {
      toast.error('Secret Required', {
        description: 'Enter a secret (min 5 characters) for hash method before generating key map',
      })
      return
    }

    setIsGeneratingKeyMap(true)
    clearKeyMap()

    try {
      // Process each rule sequentially
      for (const rule of supportedRules) {
        // Query distinct non-null values for this column
        const distinctQuery = `SELECT DISTINCT "${rule.column}" AS val FROM "${tableName}" WHERE "${rule.column}" IS NOT NULL`
        const distinctValues = await runQuery(distinctQuery) as Array<{ val: unknown }>

        // Generate obfuscated values for each
        const entries: KeyMapEntry[] = []
        for (const row of distinctValues) {
          const originalValue = String(row.val)
          const obfuscatedValue = await obfuscateValue(originalValue, rule.method, secret)
          entries.push({ original: originalValue, obfuscated: obfuscatedValue })
        }

        // Store in key map
        setColumnKeyMap(rule.column, entries)
      }

      toast.success('Key Map Generated', {
        description: `Generated mappings for ${supportedRules.length} column(s)`,
      })
    } catch (error) {
      console.error('Key map generation failed:', error)
      toast.error('Generation Failed', {
        description: error instanceof Error ? error.message : 'Failed to generate key map',
      })
      clearKeyMap()
    } finally {
      setIsGeneratingKeyMap(false)
    }
  }, [tableName, rules, secret, runQuery, setColumnKeyMap, clearKeyMap, setIsGeneratingKeyMap])

  /**
   * Download the key map as a CSV file.
   * Format: column,original,obfuscated
   */
  const downloadKeyMap = useCallback(() => {
    if (keyMap.size === 0) return

    const csvLines = ['column,original,obfuscated']

    // Sort columns for consistent output
    const sortedColumns = Array.from(keyMap.keys()).sort()

    for (const column of sortedColumns) {
      const entries = keyMap.get(column) || []
      for (const entry of entries) {
        // Escape CSV values (double quotes -> two double quotes, wrap in quotes if needed)
        const escapeCSV = (val: string) => {
          if (val.includes(',') || val.includes('"') || val.includes('\n')) {
            return `"${val.replace(/"/g, '""')}"`
          }
          return val
        }
        csvLines.push(`${escapeCSV(column)},${escapeCSV(entry.original)},${escapeCSV(entry.obfuscated)}`)
      }
    }

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `keymap_${tableName}_${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    // Count total entries
    let totalEntries = 0
    keyMap.forEach((entries) => {
      totalEntries += entries.length
    })

    setKeyMapDownloaded(true)
    toast.success('Key Map Downloaded', {
      description: `Saved ${totalEntries} mappings across ${keyMap.size} column(s)`,
    })
  }, [keyMap, tableName, setKeyMapDownloaded])

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

    // If key map is enabled, it must be downloaded before applying
    if (keyMapEnabled && !keyMapDownloaded) {
      toast.error('Key Map Required', {
        description: 'Download the key map before applying scrub rules',
      })
      return
    }

    // Hash requires a secret with minimum length
    const MIN_SECRET_LENGTH = 5
    const hasHashRule = supportedRules.some((r) => r.method === 'hash')
    if (hasHashRule && !secret) {
      toast.error('Secret Required', {
        description: 'Please enter a project secret for consistent hashing',
      })
      return
    }
    if (hasHashRule && secret.length < MIN_SECRET_LENGTH) {
      toast.error('Secret Too Short', {
        description: `Secret must be at least ${MIN_SECRET_LENGTH} characters for security`,
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

  const getMethodInfo = (method: ObfuscationMethod | null) => {
    if (!method) return null
    return OBFUSCATION_METHODS.find((m) => m.id === method)
  }

  // Group methods by category
  const stringMethods = OBFUSCATION_METHODS.filter(m => m.category === 'string')
  const numberMethods = OBFUSCATION_METHODS.filter(m => m.category === 'number')
  const dateMethods = OBFUSCATION_METHODS.filter(m => m.category === 'date')

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
                    const isSupported = SUPPORTED_COMMAND_METHODS.has(rule.method)
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
                            <Badge
                              variant={isSupported ? "secondary" : "outline"}
                              className={cn(
                                "text-xs shrink-0",
                                !isSupported && "text-muted-foreground"
                              )}
                            >
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
            <Collapsible open={keyMapInfoOpen} onOpenChange={setKeyMapInfoOpen}>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="keymap"
                    checked={keyMapEnabled}
                    onCheckedChange={(checked) => setKeyMapEnabled(checked === true)}
                    disabled={isProcessing}
                  />
                  <Label htmlFor="keymap" className="text-sm cursor-pointer">
                    Generate Key Map
                  </Label>
                </div>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                    <Info className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="mt-2">
                <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-xs">
                  <p className="font-medium text-foreground">What is a Key Map?</p>
                  <p className="text-muted-foreground">
                    A CSV file that maps <strong>original values → obfuscated values</strong>.
                    Use it to look up what values were before obfuscation.
                  </p>
                  <div className="border-t border-border/50 pt-2 mt-2">
                    <p className="font-medium text-foreground mb-1">Key points:</p>
                    <ul className="text-muted-foreground space-y-1">
                      <li className="flex items-start gap-1.5">
                        <span className="text-blue-400">•</span>
                        Works with <strong>any</strong> obfuscation method (not just Hash)
                      </li>
                      <li className="flex items-start gap-1.5">
                        <span className="text-blue-400">•</span>
                        Enables reversibility via lookup table
                      </li>
                      <li className="flex items-start gap-1.5">
                        <span className="text-amber-400">•</span>
                        Store securely - contains original sensitive data
                      </li>
                    </ul>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>

        {/* Action Buttons in Left Column Footer */}
        <div className="p-4 border-t border-border/50 space-y-2">
          {/* Key Map Download Section - Only shown when checkbox enabled and rules exist */}
          {keyMapEnabled && rules.filter(r => SUPPORTED_COMMAND_METHODS.has(r.method)).length > 0 && (
            <>
              {keyMapDownloaded ? (
                // Key map already downloaded - show confirmation
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>Key map downloaded</span>
                </div>
              ) : keyMap.size > 0 ? (
                // Key map generated - ready to download
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={downloadKeyMap}
                  disabled={isProcessing || isGeneratingKeyMap}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download Key Map ({keyMap.size} columns)
                </Button>
              ) : (
                // Need to generate key map first
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={generateKeyMap}
                  disabled={isProcessing || isGeneratingKeyMap}
                >
                  {isGeneratingKeyMap ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Key className="w-4 h-4 mr-2" />
                      Generate Key Map
                    </>
                  )}
                </Button>
              )}
            </>
          )}

          <Button
            className="w-full"
            onClick={handleApply}
            disabled={
              !tableId ||
              rules.length === 0 ||
              isProcessing ||
              isGeneratingKeyMap ||
              (keyMapEnabled && !keyMapDownloaded)
            }
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

          {/* Hint when key map blocks Apply */}
          {keyMapEnabled && !keyMapDownloaded && rules.filter(r => SUPPORTED_COMMAND_METHODS.has(r.method)).length > 0 && (
            <p className="text-xs text-muted-foreground text-center">
              Download key map before applying
            </p>
          )}
        </div>
      </div>

      {/* Right Column: Rule Editor */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="flex-1 p-4 flex flex-col">
          {showRuleEditor && selectedColumn ? (
            <div className="space-y-4 animate-in fade-in duration-200 my-auto">
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

                {/* Method Example */}
                {selectedMethod && METHOD_EXAMPLES[selectedMethod] && (
                  <div className="border-t border-border/50 pt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Example</p>
                    <div className="flex items-center gap-2 text-xs font-mono">
                      <span className="text-red-400/80">{METHOD_EXAMPLES[selectedMethod].before}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="text-green-400/80">{METHOD_EXAMPLES[selectedMethod].after}</span>
                    </div>
                  </div>
                )}

                {/* Method Description */}
                {selectedMethod && (
                  <div className="border-t border-border/50 pt-2">
                    <p className="text-xs text-muted-foreground">
                      {getMethodInfo(selectedMethod)?.description}
                    </p>
                  </div>
                )}
              </div>

              {/* Live Preview */}
              {tableName && selectedColumn && selectedMethod && (
                <ScrubPreview
                  tableName={tableName}
                  column={selectedColumn}
                  method={selectedMethod}
                  secret={secret}
                />
              )}

              {/* Method Selector - Radio buttons grouped by category */}
              <div className="space-y-4">
                <Label>Obfuscation Method</Label>
                <RadioGroup
                  value={selectedMethod || ''}
                  onValueChange={(v) => handleMethodChange(v as ObfuscationMethod)}
                  className="space-y-4"
                >
                  {/* String Methods */}
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Text</p>
                    <div className="grid grid-cols-2 gap-2">
                      {stringMethods.map((m) => {
                        const isSupported = SUPPORTED_COMMAND_METHODS.has(m.id)
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              'flex items-center space-x-2 rounded-md border p-2.5 cursor-pointer transition-all',
                              selectedMethod === m.id
                                ? 'border-primary bg-primary/10 shadow-sm'
                                : 'border-border/40 bg-background hover:bg-muted/50 hover:border-border',
                              !isSupported && 'opacity-50'
                            )}
                            onClick={() => handleMethodChange(m.id)}
                          >
                            <RadioGroupItem value={m.id} id={m.id} className="sr-only" />
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <div className={cn(
                                "shrink-0",
                                selectedMethod === m.id ? "text-primary" : "text-muted-foreground"
                              )}>
                                {METHOD_ICONS[m.id]}
                              </div>
                              <div className="min-w-0">
                                <label htmlFor={m.id} className="text-sm font-medium cursor-pointer block truncate">
                                  {m.label}
                                </label>
                                <span className={cn(
                                  "text-[10px] block h-3.5",
                                  isSupported ? "invisible" : "text-amber-500/80"
                                )}>
                                  {isSupported ? "\u00A0" : "Preview only"}
                                </span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Hash Secret Input - Animated appearance when Hash is selected */}
                  <Collapsible open={selectedMethod === 'hash'}>
                    <CollapsibleContent>
                      <Collapsible open={secretInfoOpen} onOpenChange={setSecretInfoOpen}>
                        <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="flex items-center gap-1.5 text-sm font-medium">
                              <Key className="w-3.5 h-3.5" />
                              Hash Secret
                              <span className="text-destructive">*</span>
                            </Label>
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                                <Info className="w-3.5 h-3.5 text-muted-foreground" />
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                          <Input
                            type="password"
                            value={secret}
                            onChange={(e) => setSecret(e.target.value)}
                            placeholder="Min 5 characters"
                            disabled={isProcessing}
                            className={cn((!secret || secret.length < 5) && "border-amber-500/50")}
                          />
                          {!secret ? (
                            <p className="text-xs text-amber-500">Enter a secret phrase (min 5 chars)</p>
                          ) : secret.length < 5 && (
                            <p className="text-xs text-amber-500">
                              {5 - secret.length} more character{5 - secret.length !== 1 ? 's' : ''} needed
                            </p>
                          )}
                        </div>
                        <CollapsibleContent className="mt-2">
                          <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-xs">
                            <p className="font-medium text-foreground">Why is this needed?</p>
                            <p className="text-muted-foreground">
                              The secret ensures <strong>consistent, secure hashing</strong>.
                              Same value + same secret = same hash every time.
                            </p>
                            <div className="border-t border-border/50 pt-2 mt-2">
                              <ul className="text-muted-foreground space-y-1">
                                <li className="flex items-start gap-1.5">
                                  <span className="text-blue-400">•</span>
                                  Enables matching hashed values across different tables
                                </li>
                                <li className="flex items-start gap-1.5">
                                  <span className="text-blue-400">•</span>
                                  Adds security - hashes can&apos;t be reproduced without it
                                </li>
                                <li className="flex items-start gap-1.5">
                                  <span className="text-amber-400">•</span>
                                  Store it safely - you&apos;ll need it for future operations
                                </li>
                              </ul>
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Number Methods */}
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Numbers</p>
                    <div className="grid grid-cols-2 gap-2">
                      {numberMethods.map((m) => {
                        const isSupported = SUPPORTED_COMMAND_METHODS.has(m.id)
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              'flex items-center space-x-2 rounded-md border p-2.5 cursor-pointer transition-all',
                              selectedMethod === m.id
                                ? 'border-primary bg-primary/10 shadow-sm'
                                : 'border-border/40 bg-background hover:bg-muted/50 hover:border-border',
                              !isSupported && 'opacity-50'
                            )}
                            onClick={() => handleMethodChange(m.id)}
                          >
                            <RadioGroupItem value={m.id} id={m.id} className="sr-only" />
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <div className={cn(
                                "shrink-0",
                                selectedMethod === m.id ? "text-primary" : "text-muted-foreground"
                              )}>
                                {METHOD_ICONS[m.id]}
                              </div>
                              <div className="min-w-0">
                                <label htmlFor={m.id} className="text-sm font-medium cursor-pointer block truncate">
                                  {m.label}
                                </label>
                                <span className={cn(
                                  "text-[10px] block h-3.5",
                                  isSupported ? "invisible" : "text-amber-500/80"
                                )}>
                                  {isSupported ? "\u00A0" : "Preview only"}
                                </span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Date Methods */}
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Dates</p>
                    <div className="grid grid-cols-2 gap-2">
                      {dateMethods.map((m) => {
                        const isSupported = SUPPORTED_COMMAND_METHODS.has(m.id)
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              'flex items-center space-x-2 rounded-md border p-2.5 cursor-pointer transition-all',
                              selectedMethod === m.id
                                ? 'border-primary bg-primary/10 shadow-sm'
                                : 'border-border/40 bg-background hover:bg-muted/50 hover:border-border',
                              !isSupported && 'opacity-50'
                            )}
                            onClick={() => handleMethodChange(m.id)}
                          >
                            <RadioGroupItem value={m.id} id={m.id} className="sr-only" />
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <div className={cn(
                                "shrink-0",
                                selectedMethod === m.id ? "text-primary" : "text-muted-foreground"
                              )}>
                                {METHOD_ICONS[m.id]}
                              </div>
                              <div className="min-w-0">
                                <label htmlFor={m.id} className="text-sm font-medium cursor-pointer block truncate">
                                  {m.label}
                                </label>
                                <span className={cn(
                                  "text-[10px] block h-3.5",
                                  isSupported ? "invisible" : "text-amber-500/80"
                                )}>
                                  {isSupported ? "\u00A0" : "Preview only"}
                                </span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </RadioGroup>
              </div>

              {/* Unsupported Method Note */}
              {selectedMethod && !SUPPORTED_COMMAND_METHODS.has(selectedMethod) && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    <strong>{getMethodInfo(selectedMethod)?.label}</strong> is preview-only and will be skipped during apply.
                    Only Redact, Mask, Hash, and Year Only support in-place modification.
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Empty State */
            <div className="flex flex-col items-center justify-center my-auto min-h-[300px] text-center p-6">
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
        </div>
      </div>

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />
    </div>
  )
}
