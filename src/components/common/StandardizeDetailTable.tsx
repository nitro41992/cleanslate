import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react'
import { getStandardizeAuditDetails } from '@/lib/standardizer-engine'

interface StandardizeDetailTableProps {
  auditEntryId: string
}

interface StandardizeDetail {
  id: string
  fromValue: string
  toValue: string
  rowCount: number
}

const PAGE_SIZE = 20

export function StandardizeDetailTable({ auditEntryId }: StandardizeDetailTableProps) {
  const [allDetails, setAllDetails] = useState<StandardizeDetail[]>([])
  const [page, setPage] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const totalPages = Math.ceil(allDetails.length / PAGE_SIZE)
  const paginatedDetails = allDetails.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const loadDetails = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await getStandardizeAuditDetails(auditEntryId)
      setAllDetails(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load standardization details')
    } finally {
      setIsLoading(false)
    }
  }, [auditEntryId])

  useEffect(() => {
    loadDetails()
  }, [loadDetails])

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

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (allDetails.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        <p>No standardization details available</p>
      </div>
    )
  }

  // Calculate total rows affected
  const totalRowsAffected = allDetails.reduce((sum, d) => sum + d.rowCount, 0)

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="px-4 py-3 bg-muted/30 rounded-lg mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {allDetails.length} value{allDetails.length !== 1 ? 's' : ''} standardized
          </span>
          <span className="text-sm font-medium">
            {totalRowsAffected.toLocaleString()} total rows updated
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-y-auto flex-1" style={{ maxHeight: 'calc(90vh - 320px)' }}>
        <table className="w-full" data-testid="standardize-detail-table">
          <thead className="sticky top-0 bg-background border-b">
            <tr>
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">
                Original Value
              </th>
              <th className="w-10"></th>
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">
                Standardized To
              </th>
              <th className="text-right text-xs font-medium text-muted-foreground py-2 px-3">
                Rows Changed
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {paginatedDetails.map((detail) => (
              <tr key={detail.id} className="hover:bg-muted/30">
                <td className="py-2.5 px-3">
                  <span className="text-sm font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
                    {detail.fromValue || '<empty>'}
                  </span>
                </td>
                <td className="py-2.5 px-2 text-center">
                  <ArrowRight className="h-4 w-4 text-muted-foreground inline-block" />
                </td>
                <td className="py-2.5 px-3">
                  <span className="text-sm font-mono text-green-400 bg-green-500/10 px-2 py-0.5 rounded">
                    {detail.toValue || '<empty>'}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-right text-sm text-muted-foreground">
                  {detail.rowCount.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {allDetails.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, allDetails.length)} of {allDetails.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(page - 1)}
              disabled={page === 0}
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
              disabled={page >= totalPages - 1}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
