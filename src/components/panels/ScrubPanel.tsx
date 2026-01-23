import { useState } from 'react'
import { Shield, Eye, Loader2, Key, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ColumnRuleTable } from '@/features/scrubber/components/ColumnRuleTable'
import { useTableStore } from '@/stores/tableStore'
import { useScrubberStore } from '@/stores/scrubberStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { applyObfuscationRules } from '@/lib/obfuscation'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import type { CommandType } from '@/lib/commands'
import type { ObfuscationMethod } from '@/types'
import { toast } from 'sonner'

// Map ObfuscationMethod to CommandType for supported methods
const METHOD_TO_COMMAND: Partial<Record<ObfuscationMethod, CommandType>> = {
  hash: 'scrub:hash',
  mask: 'scrub:mask',
  redact: 'scrub:redact',
  year_only: 'scrub:year_only',
}

// Methods that are supported by command pattern (in-place modification)
const SUPPORTED_COMMAND_METHODS = new Set(['hash', 'mask', 'redact', 'year_only'])

export function ScrubPanel() {
  const tables = useTableStore((s) => s.tables)
  const updateTable = useTableStore((s) => s.updateTable)

  const closePanel = usePreviewStore((s) => s.closePanel)

  const { getData } = useDuckDB()

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
    setKeyMapEnabled,
    clearKeyMap,
    setIsProcessing,
  } = useScrubberStore()

  const [previewData, setPreviewData] = useState<Record<string, unknown>[]>([])

  const selectedTable = tables.find((t) => t.id === tableId)

  const handleTableSelect = (id: string) => {
    const table = tables.find((t) => t.id === id)
    setTable(id, table?.name || null)
    setPreviewData([])
    clearKeyMap()
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

    try {
      // Execute one command per rule (per-column granularity)
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

        const result = await executor.execute(command)

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

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
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
                    {t.name} ({t.rowCount} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            />
            <p className="text-xs text-destructive/80">
              Keep this secret safe! You'll need it to match hashed values later.
            </p>
          </div>

          {/* Key Map Option */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="keymap"
              checked={keyMapEnabled}
              onCheckedChange={(checked) => setKeyMapEnabled(checked === true)}
            />
            <Label htmlFor="keymap" className="text-sm cursor-pointer">
              Generate Key Map (for reversibility)
            </Label>
          </div>

          {/* Column Rules */}
          {selectedTable && (
            <div className="space-y-2">
              <Label>Column Rules</Label>
              <div className="border rounded-lg overflow-hidden">
                <ColumnRuleTable columns={selectedTable.columns} rules={rules} />
              </div>
            </div>
          )}

          {/* Preview Data */}
          {previewData.length > 0 && (
            <div className="space-y-2">
              <Label>Preview (First 10 rows)</Label>
              <div className="max-h-40 overflow-auto border rounded-lg p-2 bg-muted/30">
                <pre className="text-xs">
                  {JSON.stringify(previewData.slice(0, 3), null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <Separator />

      {/* Actions */}
      <div className="p-4 space-y-2">
        {keyMapEnabled && keyMap.size > 0 && (
          <Button variant="outline" className="w-full" onClick={exportKeyMap}>
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
          disabled={!tableId || rules.length === 0 || !secret || isProcessing}
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
  )
}
