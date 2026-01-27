import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Clock, Table2, GitMerge, Edit3, Link2 } from 'lucide-react'
import { AuditDetailTable } from './AuditDetailTable'
import { MergeDetailTable } from './MergeDetailTable'
import { ManualEditDetailView } from './ManualEditDetailView'
import { StandardizeDetailTable } from './StandardizeDetailTable'
import type { AuditLogEntry } from '@/types'
import { formatDate } from '@/lib/utils'
import { getAuditRowDetails } from '@/lib/transformations'
import { getMergeAuditDetails } from '@/lib/fuzzy-matcher'
import { getStandardizeAuditDetails } from '@/lib/standardizer-engine'

interface AuditDetailModalProps {
  entry: AuditLogEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AuditDetailModal({ entry, open, onOpenChange }: AuditDetailModalProps) {
  if (!entry || !entry.hasRowDetails || !entry.auditEntryId) {
    return null
  }

  // Parse details JSON to check the structured type field for reliable action detection
  const parsedDetails = (() => {
    try {
      return typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details
    } catch {
      return null
    }
  })()

  const isMergeAction = parsedDetails?.type === 'merge' || entry.action === 'Apply Merges' || entry.action === 'Merge Duplicates'
  const isStandardizeAction = parsedDetails?.type === 'standardize'
  const isManualEdit = entry.entryType === 'B'

  const handleExportCSV = async () => {
    try {
      if (isMergeAction) {
        // Export merge details
        const details = await getMergeAuditDetails(entry.auditEntryId!)

        // Build CSV content for merge pairs
        const csvLines = [
          'Pair Index,Similarity,Match Column,Kept Data,Deleted Data',
          ...details.map((detail) => {
            const keptData = JSON.stringify(detail.keptRowData).replace(/"/g, '""')
            const deletedData = JSON.stringify(detail.deletedRowData).replace(/"/g, '""')
            return `${detail.pairIndex},${detail.similarity},"${detail.matchColumn}","${keptData}","${deletedData}"`
          }),
        ]

        const csvContent = csvLines.join('\n')
        const blob = new Blob([csvContent], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `merge_details_${entry.auditEntryId}_${details.length}pairs.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } else if (isStandardizeAction) {
        // Export standardize details
        const details = await getStandardizeAuditDetails(entry.auditEntryId!)

        const csvLines = [
          'Original Value,Standardized To,Rows Changed',
          ...details.map((detail) => {
            const fromVal = detail.fromValue.replace(/"/g, '""')
            const toVal = detail.toValue.replace(/"/g, '""')
            return `"${fromVal}","${toVal}",${detail.rowCount}`
          }),
        ]

        const csvContent = csvLines.join('\n')
        const blob = new Blob([csvContent], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `standardize_details_${entry.auditEntryId}_${details.length}values.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } else if (isManualEdit) {
        // Export manual edit details (single row from entry data)
        const formatValue = (value: unknown): string => {
          if (value === null) return '<null>'
          if (value === undefined) return '<undefined>'
          if (value === '') return '<empty>'
          return String(value)
        }
        const prev = formatValue(entry.previousValue).replace(/"/g, '""')
        const newVal = formatValue(entry.newValue).replace(/"/g, '""')

        const csvLines = [
          'Row Index,Column,Previous Value,New Value',
          `${entry.rowIndex},"${entry.columnName}","${prev}","${newVal}"`,
        ]

        const csvContent = csvLines.join('\n')
        const blob = new Blob([csvContent], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `manual_edit_${entry.auditEntryId}_1row.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } else {
        // Export regular audit details
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
      }
    } catch (err) {
      console.error('Failed to export CSV:', err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] w-[1200px] max-h-[90vh] flex flex-col" data-testid="audit-detail-modal">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2">
                {isMergeAction ? (
                  <GitMerge className="h-5 w-5" />
                ) : isStandardizeAction ? (
                  <Link2 className="h-5 w-5" />
                ) : isManualEdit ? (
                  <Edit3 className="h-5 w-5" />
                ) : (
                  <Table2 className="h-5 w-5" />
                )}
                {isMergeAction
                  ? 'Merge Details'
                  : isStandardizeAction
                    ? 'Standardization Details'
                    : isManualEdit
                      ? 'Manual Edit Details'
                      : 'Row-Level Changes'}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {isMergeAction
                  ? 'Detailed view of merged duplicate pairs'
                  : isStandardizeAction
                    ? 'Detailed view of standardized values'
                    : isManualEdit
                      ? 'Details of the manual cell edit'
                      : 'Detailed view of changes made by this transformation'}
              </DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleExportCSV} data-testid="audit-detail-export-csv-btn" className="mr-8">
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
            <span className="text-sm text-muted-foreground">
              {isMergeAction ? 'Pairs:' : isStandardizeAction ? 'Values:' : 'Rows Affected:'}
            </span>
            <Badge variant="outline">{entry.rowsAffected?.toLocaleString()}</Badge>
          </div>
          <div className="flex items-center gap-2 ml-auto text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span className="text-xs">{formatDate(entry.timestamp)}</span>
          </div>
        </div>

        {/* Capped audit banner */}
        {entry.isCapped && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
            <p className="text-xs text-amber-400">
              Audit log capped at 50,000 rows for performance.
              Total affected: {entry.rowsAffected?.toLocaleString()}
            </p>
          </div>
        )}

        {/* Detail Table - Conditional rendering */}
        <div className="flex-1 min-h-0 mt-2 overflow-hidden">
          {isMergeAction ? (
            <MergeDetailTable auditEntryId={entry.auditEntryId} />
          ) : isStandardizeAction ? (
            <StandardizeDetailTable auditEntryId={entry.auditEntryId} />
          ) : isManualEdit ? (
            <ManualEditDetailView entry={entry} />
          ) : (
            <AuditDetailTable auditEntryId={entry.auditEntryId} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
