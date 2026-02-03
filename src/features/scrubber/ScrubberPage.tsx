import { useState } from 'react'
import { Shield, Download, Eye, Loader2, Key } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ColumnRuleTable } from './components/ColumnRuleTable'
import { PreviewPanel } from './components/PreviewPanel'
import { useTableStore } from '@/stores/tableStore'
import { useScrubberStore } from '@/stores/scrubberStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { useAuditStore } from '@/stores/auditStore'
import { applyObfuscationRules } from '@/lib/obfuscation'
import { toast } from '@/hooks/use-toast'

export function ScrubberPage() {
  const tables = useTableStore((s) => s.tables)
  const isContextSwitching = useTableStore((s) => s.isContextSwitching)
  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const { getData, runExecute } = useDuckDB()

  const {
    tableId,
    tableName,
    secret,
    rules,
    previewData,
    keyMapEnabled,
    keyMap,
    isProcessing,
    setTable,
    setSecret,
    setPreviewData,
    setKeyMapEnabled,
    clearKeyMap,
    setIsProcessing,
    reset: _reset,
  } = useScrubberStore()

  const [showPreview, setShowPreview] = useState(false)
  const selectedTable = tables.find((t) => t.id === tableId)

  const handleTableSelect = (id: string) => {
    const table = tables.find((t) => t.id === id)
    setTable(id, table?.name || null)
    setPreviewData([])
    clearKeyMap()
  }

  const handlePreview = async () => {
    if (!tableName || rules.length === 0 || isContextSwitching) return

    setIsProcessing(true)
    try {
      const data = await getData(tableName, 0, 10)
      // Note: applyObfuscationRules doesn't support the new keyMap structure
      // Key map generation is handled separately in ScrubPanel
      const obfuscated = await applyObfuscationRules(
        data,
        rules,
        secret,
        undefined
      )
      setPreviewData(obfuscated)
      setShowPreview(true)
    } catch (error) {
      console.error('Preview failed:', error)
      toast({
        title: 'Preview Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleApply = async () => {
    if (!tableName || !tableId || rules.length === 0 || isContextSwitching) return

    if (!secret) {
      toast({
        title: 'Secret Required',
        description: 'Please enter a project secret for consistent hashing',
        variant: 'destructive',
      })
      return
    }

    setIsProcessing(true)
    try {
      // Get all data
      const allData = await getData(tableName, 0, 100000)

      // Apply obfuscation
      // Note: applyObfuscationRules doesn't support the new keyMap structure
      // Key map generation is handled separately in ScrubPanel
      const obfuscated = await applyObfuscationRules(
        allData,
        rules,
        secret,
        undefined
      )

      // Create new table with obfuscated data
      const scrubbed_table = `${tableName}_scrubbed`
      const columns = selectedTable?.columns.map((c) => c.name) || []

      // Create table
      const columnDefs = columns.map((c) => `"${c}" VARCHAR`).join(', ')
      await runExecute(`DROP TABLE IF EXISTS "${scrubbed_table}"`)
      await runExecute(`CREATE TABLE "${scrubbed_table}" (${columnDefs})`)

      // Insert data in batches
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

      toast({
        title: 'Scrubbing Complete',
        description: `Created scrubbed table: ${scrubbed_table}`,
      })

      // Export key map if enabled
      if (keyMapEnabled && keyMap.size > 0) {
        exportKeyMap()
      }
    } catch (error) {
      console.error('Scrubbing failed:', error)
      toast({
        title: 'Scrubbing Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const exportKeyMap = () => {
    if (keyMap.size === 0) return

    const csvLines = ['column,original,obfuscated']

    // Sort columns for consistent output
    const sortedColumns = Array.from(keyMap.keys()).sort()

    let totalEntries = 0
    for (const column of sortedColumns) {
      const entries = keyMap.get(column) || []
      for (const entry of entries) {
        // Escape CSV values
        const escapeCSV = (val: string) => {
          if (val.includes(',') || val.includes('"') || val.includes('\n')) {
            return `"${val.replace(/"/g, '""')}"`
          }
          return val
        }
        csvLines.push(`${escapeCSV(column)},${escapeCSV(entry.original)},${escapeCSV(entry.obfuscated)}`)
        totalEntries++
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

    toast({
      title: 'Key Map Exported',
      description: `Saved ${totalEntries} mappings across ${keyMap.size} column(s)`,
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-6 border-b border-border/50 bg-card/30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-semibold">Smart Scrubber</h1>
            <p className="text-xs text-muted-foreground">
              Obfuscate sensitive data
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {keyMapEnabled && keyMap.size > 0 && (
            <Button variant="outline" size="sm" onClick={exportKeyMap}>
              <Key className="w-4 h-4 mr-2" />
              Export Key Map ({keyMap.size} columns)
            </Button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 p-4 gap-4">
        {/* Configuration Panel */}
        <Card className="w-80 flex flex-col">
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col space-y-4">
            {tables.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
                <p className="text-sm">
                  Load a table in the Laundromat to scrub it
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>Table</Label>
                  <Select value={tableId || ''} onValueChange={handleTableSelect}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select table" />
                    </SelectTrigger>
                    <SelectContent>
                      {tables.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

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

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="keymap"
                    checked={keyMapEnabled}
                    onCheckedChange={(checked) =>
                      setKeyMapEnabled(checked === true)
                    }
                  />
                  <Label htmlFor="keymap" className="text-sm cursor-pointer">
                    Generate Key Map (for reversibility)
                  </Label>
                </div>

                <div className="pt-4 mt-auto space-y-2">
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
              </>
            )}
          </CardContent>
        </Card>

        {/* Rules & Preview */}
        <div className="flex-1 flex flex-col min-w-0 gap-4">
          {/* Column Rules */}
          {selectedTable && (
            <Card className="flex-1 min-h-0 flex flex-col">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Column Rules</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 pb-0">
                <ColumnRuleTable
                  columns={selectedTable.columns}
                  rules={rules}
                />
              </CardContent>
            </Card>
          )}

          {/* Preview Panel */}
          {showPreview && previewData.length > 0 && (
            <Card className="h-64">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center justify-between">
                  <span>Preview (First 10 rows)</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPreview(false)}
                  >
                    Close
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="h-full pb-4">
                <PreviewPanel
                  data={previewData}
                  columns={selectedTable?.columns.map((c) => c.name) || []}
                  rules={rules}
                />
              </CardContent>
            </Card>
          )}

          {!selectedTable && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Select a table to configure obfuscation rules</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
