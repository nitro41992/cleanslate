import { Download, FileSpreadsheet, FileJson, Copy, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  exportDiffToCSV,
  exportDiffToJSON,
  copyDiffToClipboard,
  downloadFile,
} from '@/lib/diff-export'
import { toast } from 'sonner'
import type { DiffResult } from '@/types'

interface DiffExportMenuProps {
  results: DiffResult[]
  summary: {
    added: number
    removed: number
    modified: number
    unchanged: number
  }
  columns: string[]
  keyColumns: string[]
  tableAName: string
  tableBName: string
  disabled?: boolean
}

export function DiffExportMenu({
  results,
  summary,
  columns,
  keyColumns,
  tableAName,
  tableBName,
  disabled = false,
}: DiffExportMenuProps) {
  const options = { columns, keyColumns, tableAName, tableBName }

  const handleExportCSV = () => {
    const csv = exportDiffToCSV(results, options)
    const filename = `diff_${tableAName}_vs_${tableBName}_${Date.now()}.csv`
    downloadFile(csv, filename, 'text/csv')
    toast.success('Exported to CSV', {
      description: filename,
    })
  }

  const handleExportJSON = () => {
    const json = exportDiffToJSON(results, summary, options)
    const filename = `diff_${tableAName}_vs_${tableBName}_${Date.now()}.json`
    downloadFile(json, filename, 'application/json')
    toast.success('Exported to JSON', {
      description: filename,
    })
  }

  const handleCopyToClipboard = async () => {
    await copyDiffToClipboard(results, summary, options)
    toast.success('Copied to clipboard', {
      description: 'Diff results copied as formatted text',
    })
  }

  const diffCount = results.filter(r => r.status !== 'unchanged').length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || diffCount === 0}
          className="gap-2"
          data-testid="diff-export-btn"
        >
          <Download className="w-4 h-4" />
          Export
          <ChevronDown className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleExportCSV}>
          <FileSpreadsheet className="w-4 h-4 mr-2" />
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleExportJSON}>
          <FileJson className="w-4 h-4 mr-2" />
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyToClipboard}>
          <Copy className="w-4 h-4 mr-2" />
          Copy to Clipboard
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
