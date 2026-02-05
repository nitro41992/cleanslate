import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { getAuditRowDetails, type RowDetail } from '@/lib/transformations'

interface AuditDetailTableProps {
  auditEntryId: string
}

const PAGE_SIZE = 500

export function AuditDetailTable({ auditEntryId }: AuditDetailTableProps) {
  const [rows, setRows] = useState<RowDetail[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const loadPage = useCallback(async (pageNum: number) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await getAuditRowDetails(auditEntryId, PAGE_SIZE, pageNum * PAGE_SIZE)
      setRows(result.rows)
      setTotal(result.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load row details')
    } finally {
      setIsLoading(false)
    }
  }, [auditEntryId])

  useEffect(() => {
    loadPage(page)
  }, [page, loadPage])

  const goToPage = (newPage: number) => {
    if (newPage >= 0 && newPage < totalPages) {
      setPage(newPage)
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-destructive">
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Table */}
      <ScrollArea className="h-[400px] border rounded-lg">
        <table className="w-full text-sm" data-testid="audit-detail-table">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr className="border-b">
              <th className="text-left py-2 px-3 font-medium w-20">Row #</th>
              <th className="text-left py-2 px-3 font-medium w-32">Column</th>
              <th className="text-left py-2 px-3 font-medium">Previous Value</th>
              <th className="text-left py-2 px-3 font-medium">New Value</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              // Loading skeleton
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-2 px-3"><Skeleton className="h-4 w-12" /></td>
                  <td className="py-2 px-3"><Skeleton className="h-4 w-24" /></td>
                  <td className="py-2 px-3"><Skeleton className="h-4 w-32" /></td>
                  <td className="py-2 px-3"><Skeleton className="h-4 w-32" /></td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-muted-foreground">
                  No row details available
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr
                  key={`${row.rowIndex}-${idx}`}
                  className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                  data-testid="audit-detail-row"
                >
                  <td className="py-2 px-3 font-mono text-muted-foreground">
                    {row.rowIndex}
                  </td>
                  <td className="py-2 px-3 font-medium">
                    {row.columnName}
                  </td>
                  <td className="py-2 px-3">
                    <span className="inline-block px-2 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 font-mono text-xs">
                      {row.previousValue ?? '<null>'}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <span className="inline-block px-2 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-mono text-xs">
                      {row.newValue ?? '<null>'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollArea>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total} rows
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(0)}
              disabled={page === 0 || isLoading}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(page - 1)}
              disabled={page === 0 || isLoading}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-3 text-sm">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages - 1 || isLoading}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(totalPages - 1)}
              disabled={page >= totalPages - 1 || isLoading}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
