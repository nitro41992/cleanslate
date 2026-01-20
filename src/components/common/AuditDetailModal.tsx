import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Clock, Table2 } from 'lucide-react'
import { AuditDetailTable } from './AuditDetailTable'
import type { AuditLogEntry } from '@/types'
import { formatDate } from '@/lib/utils'
import { getAuditRowDetails } from '@/lib/transformations'

interface AuditDetailModalProps {
  entry: AuditLogEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AuditDetailModal({ entry, open, onOpenChange }: AuditDetailModalProps) {
  if (!entry || !entry.hasRowDetails || !entry.auditEntryId) {
    return null
  }

  const handleExportCSV = async () => {
    try {
      // Fetch all rows (up to 10k)
      const { rows, total } = await getAuditRowDetails(entry.auditEntryId!, 10000, 0)

      // Build CSV content
      const csvLines = [
        'Row Index,Column,Previous Value,New Value',
        ...rows.map((row) => {
          const prev = row.previousValue?.replace(/"/g, '""') ?? ''
          const newVal = row.newValue?.replace(/"/g, '""') ?? ''
          return `${row.rowIndex},"${row.columnName}","${prev}","${newVal}"`
        }),
      ]

      const csvContent = csvLines.join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit_details_${entry.auditEntryId}_${total}rows.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export CSV:', err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <Table2 className="h-5 w-5" />
                Row-Level Changes
              </DialogTitle>
              <DialogDescription className="mt-1">
                Detailed view of changes made by this transformation
              </DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleExportCSV}>
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </div>
        </DialogHeader>

        {/* Summary */}
        <div className="flex flex-wrap items-center gap-3 py-3 px-4 rounded-lg bg-muted/30 border">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Action:</span>
            <span className="font-medium text-sm">{entry.action}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Table:</span>
            <Badge variant="secondary">{entry.tableName}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Rows Affected:</span>
            <Badge variant="outline">{entry.rowsAffected?.toLocaleString()}</Badge>
          </div>
          <div className="flex items-center gap-2 ml-auto text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span className="text-xs">{formatDate(entry.timestamp)}</span>
          </div>
        </div>

        {/* Detail Table */}
        <div className="flex-1 min-h-0 mt-2">
          <AuditDetailTable auditEntryId={entry.auditEntryId} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
