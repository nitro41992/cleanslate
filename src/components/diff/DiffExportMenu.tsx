import { useState } from 'react'
import { Download, FileSpreadsheet, FileJson, Copy, ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { streamDiffResults, getModifiedColumns, type DiffRow, type DiffSummary } from '@/lib/diff-engine'
import { toast } from 'sonner'

interface DiffExportMenuProps {
  diffTableName: string
  sourceTableName: string
  targetTableName: string
  keyOrderBy: string
  summary: DiffSummary
  allColumns: string[]
  keyColumns: string[]
  newColumns: string[]
  removedColumns: string[]
  tableAName: string
  tableBName: string
  totalRows: number
  disabled?: boolean
  storageType?: 'memory' | 'snapshot'
}

export function DiffExportMenu({
  diffTableName,
  sourceTableName,
  targetTableName,
  keyOrderBy,
  summary,
  allColumns,
  keyColumns,
  newColumns,
  removedColumns,
  tableAName,
  tableBName,
  totalRows,
  disabled = false,
  storageType = 'memory',
}: DiffExportMenuProps) {
  const [isExporting, setIsExporting] = useState(false)

  const handleExportCSV = async () => {
    setIsExporting(true)
    try {
      const csvLines: string[] = []

      // Header row
      const headers = ['Status', ...allColumns]
      csvLines.push(headers.map(escapeCSV).join(','))

      // Stream chunks
      let exportedCount = 0
      for await (const chunk of streamDiffResults(diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, keyOrderBy, undefined, storageType)) {
        for (const row of chunk) {
          const line = formatRowAsCSV(row, allColumns, keyColumns)
          csvLines.push(line)
          exportedCount++
        }

        // Show progress for large exports
        if (exportedCount % 50000 === 0) {
          toast.info(`Exported ${exportedCount.toLocaleString()} rows...`)
        }
      }

      const csv = csvLines.join('\n')
      const filename = `diff_${tableAName}_vs_${tableBName}_${Date.now()}.csv`
      downloadFile(csv, filename, 'text/csv')

      toast.success('Exported to CSV', {
        description: `${filename} (${exportedCount.toLocaleString()} rows)`,
      })
    } catch (error) {
      console.error('CSV export failed:', error)
      toast.error('Export Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleExportJSON = async () => {
    setIsExporting(true)
    try {
      const results: Array<{
        status: string
        rowA: Record<string, unknown> | null
        rowB: Record<string, unknown> | null
        modifiedColumns: string[] | null
      }> = []

      // Stream chunks
      for await (const chunk of streamDiffResults(diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, keyOrderBy, undefined, storageType)) {
        for (const row of chunk) {
          const status = row.diff_status
          const rowA: Record<string, unknown> = {}
          const rowB: Record<string, unknown> = {}

          for (const col of allColumns) {
            rowA[col] = row[`a_${col}`]
            rowB[col] = row[`b_${col}`]
          }

          results.push({
            status,
            rowA: status !== 'added' ? rowA : null,
            rowB: status !== 'removed' ? rowB : null,
            modifiedColumns: status === 'modified' ? getModifiedColumns(row, allColumns, keyColumns) : null,
          })
        }
      }

      const exportData = {
        meta: {
          exportedAt: new Date().toISOString(),
          tableA: tableAName,
          tableB: tableBName,
          keyColumns,
          columns: allColumns,
        },
        summary: {
          added: summary.added,
          removed: summary.removed,
          modified: summary.modified,
          unchanged: summary.unchanged,
          total: summary.added + summary.removed + summary.modified + summary.unchanged,
        },
        results,
      }

      const json = JSON.stringify(exportData, null, 2)
      const filename = `diff_${tableAName}_vs_${tableBName}_${Date.now()}.json`
      downloadFile(json, filename, 'application/json')

      toast.success('Exported to JSON', {
        description: `${filename} (${results.length.toLocaleString()} rows)`,
      })
    } catch (error) {
      console.error('JSON export failed:', error)
      toast.error('Export Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleCopyToClipboard = async () => {
    setIsExporting(true)
    try {
      const lines: string[] = [
        `Diff Results: ${tableAName} vs ${tableBName}`,
        `${'='.repeat(50)}`,
        `Summary: +${summary.added} added, -${summary.removed} removed, ~${summary.modified} modified, =${summary.unchanged} unchanged`,
        '',
        'Results:',
        '',
      ]

      // Only copy first 100 rows for clipboard
      let count = 0
      outer: for await (const chunk of streamDiffResults(diffTableName, sourceTableName, targetTableName, allColumns, newColumns, removedColumns, keyOrderBy, 100, storageType)) {
        for (const row of chunk) {
          if (count >= 100) break outer

          const status = row.diff_status
          const statusIcon = status === 'added' ? '+' : status === 'removed' ? '-' : '~'
          const keyValues = keyColumns.map(k => getCellValue(row, k, allColumns, keyColumns)).join(', ')
          lines.push(`${statusIcon} [${status.toUpperCase()}] ${keyValues}`)

          if (status === 'modified') {
            const modifiedCols = getModifiedColumns(row, allColumns, keyColumns)
            for (const col of modifiedCols) {
              const oldVal = row[`a_${col}`] ?? ''
              const newVal = row[`b_${col}`] ?? ''
              lines.push(`    ${col}: "${oldVal}" -> "${newVal}"`)
            }
          }
          count++
        }
      }

      if (totalRows > 100) {
        lines.push('')
        lines.push(`... and ${(totalRows - 100).toLocaleString()} more`)
      }

      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success('Copied to clipboard', {
        description: 'Diff results copied as formatted text',
      })
    } catch (error) {
      console.error('Clipboard copy failed:', error)
      toast.error('Copy Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || totalRows === 0 || isExporting}
          className="gap-2"
          data-testid="diff-export-btn"
        >
          {isExporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export
          <ChevronDown className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleExportCSV} disabled={isExporting}>
          <FileSpreadsheet className="w-4 h-4 mr-2" />
          Export as CSV
          {totalRows > 10000 && (
            <span className="ml-2 text-xs text-muted-foreground">
              ({totalRows.toLocaleString()} rows)
            </span>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleExportJSON} disabled={isExporting}>
          <FileJson className="w-4 h-4 mr-2" />
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyToClipboard} disabled={isExporting}>
          <Copy className="w-4 h-4 mr-2" />
          Copy to Clipboard
          <span className="ml-2 text-xs text-muted-foreground">(first 100)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Format a diff row as CSV
 */
function formatRowAsCSV(row: DiffRow, allColumns: string[], keyColumns: string[]): string {
  const values: string[] = [row.diff_status.toUpperCase()]

  for (const col of allColumns) {
    const cellValue = getCellValue(row, col, allColumns, keyColumns)
    values.push(escapeCSV(cellValue))
  }

  return values.join(',')
}

/**
 * Get cell value from diff row
 */
function getCellValue(row: DiffRow, column: string, allColumns: string[], keyColumns: string[]): string {
  const status = row.diff_status
  const valA = row[`a_${column}`]
  const valB = row[`b_${column}`]
  const strA = valA === null || valA === undefined ? '' : String(valA)
  const strB = valB === null || valB === undefined ? '' : String(valB)

  if (status === 'added') {
    return strB
  }
  if (status === 'removed') {
    return strA
  }

  // Modified or unchanged
  const modifiedCols = getModifiedColumns(row, allColumns, keyColumns)
  if (modifiedCols.includes(column)) {
    return `${strA} -> ${strB}`
  }
  return strA
}

/**
 * Escape value for CSV
 */
function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Trigger download of a file
 */
function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
