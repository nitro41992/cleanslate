import { useState } from 'react'
import { Shield, Eye, Loader2, Key, Download } from 'lucide-react'
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
import { useAuditStore } from '@/stores/auditStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { applyObfuscationRules } from '@/lib/obfuscation'
import { toast } from 'sonner'

export function ScrubPanel() {
  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)
  const setActiveTable = useTableStore((s) => s.setActiveTable)

  const setPreviewActiveTable = usePreviewStore((s) => s.setActiveTable)
  const closePanel = usePreviewStore((s) => s.closePanel)

  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const { getData, runExecute } = useDuckDB()

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

    if (!secret) {
      toast.error('Secret Required', {
        description: 'Please enter a project secret for consistent hashing',
      })
      return
    }

    setIsProcessing(true)
    try {
      const allData = await getData(tableName, 0, 100000)
      const obfuscated = await applyObfuscationRules(
        allData,
        rules,
        secret,
        keyMapEnabled ? keyMap : undefined
      )

      const scrubbed_table = `${tableName}_scrubbed`
      const columns = selectedTable?.columns.map((c) => c.name) || []

      const columnDefs = columns.map((c) => `"${c}" VARCHAR`).join(', ')
      await runExecute(`DROP TABLE IF EXISTS "${scrubbed_table}"`)
      await runExecute(`CREATE TABLE "${scrubbed_table}" (${columnDefs})`)

      const batchSize = 100
      for (let i = 0; i < obfuscated.length; i += batchSize) {
        const batch = obfuscated.slice(i, i + batchSize)
        const values = batch
          .map((row) => {
            const vals = columns.map((c) => {
              const val = row[c]
              if (val === null || val === undefined) return 'NULL'
              return `'${String(val).replace(/'/g, "''")}'`
            })
            return `(${vals.join(', ')})`
          })
          .join(', ')

        await runExecute(`INSERT INTO "${scrubbed_table}" VALUES ${values}`)
      }

      addAuditEntry(
        tableId,
        tableName,
        'Data Scrubbed',
        `Applied ${rules.length} obfuscation rules. Created ${scrubbed_table} with ${obfuscated.length} rows.`
      )

      // Add new table to store
      const newColumns = selectedTable?.columns.map((c) => ({ ...c, nullable: true })) || []
      const newTableId = addTable(scrubbed_table, newColumns, obfuscated.length)

      toast.success('Scrubbing Complete', {
        description: `Created scrubbed table: ${scrubbed_table}`,
      })

      // Set as active and close panel
      setActiveTable(newTableId)
      setPreviewActiveTable(newTableId, scrubbed_table)

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
              <Download className="w-4 h-4 mr-2" />
              Apply & Create Scrubbed Table
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
