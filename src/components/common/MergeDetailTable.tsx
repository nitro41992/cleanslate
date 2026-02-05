import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChevronLeft, ChevronRight, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMergeAuditDetails } from '@/lib/fuzzy-matcher'

interface MergeDetailTableProps {
  auditEntryId: string
}

interface MergeDetail {
  id: string
  pairIndex: number
  similarity: number
  matchColumn: string
  keptRowData: Record<string, unknown>
  deletedRowData: Record<string, unknown>
}

const PAGE_SIZE = 10

function formatValue(value: unknown): string {
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (value === '') return '<empty>'
  return String(value)
}

function getSimilarityClass(similarity: number): string {
  if (similarity >= 85) return 'bg-green-500/20 text-green-600 dark:text-green-400'
  if (similarity >= 60) return 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
  return 'bg-red-500/20 text-red-600 dark:text-red-400'
}

export function MergeDetailTable({ auditEntryId }: MergeDetailTableProps) {
  const [allDetails, setAllDetails] = useState<MergeDetail[]>([])
  const [page, setPage] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const totalPages = Math.ceil(allDetails.length / PAGE_SIZE)
  const paginatedDetails = allDetails.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const loadDetails = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await getMergeAuditDetails(auditEntryId)
      setAllDetails(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load merge details')
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
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border rounded-lg p-4">
            <div className="flex justify-between mb-4">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (allDetails.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        <p>No merge details available</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="overflow-y-auto" style={{ height: 'calc(90vh - 250px)' }}>
        <div className="space-y-4 pr-2" data-testid="merge-detail-cards">
          {paginatedDetails.map((detail) => {
            const columns = Object.keys(detail.keptRowData || {})

            // Handle parse errors or empty data
            if (columns.length === 0 || detail.keptRowData._parseError) {
              return (
                <div
                  key={detail.id}
                  className="border border-amber-500/30 rounded-lg p-4"
                  data-testid="merge-detail-card"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Pair {detail.pairIndex + 1}</span>
                    <span className={cn(
                      'px-2.5 py-1 rounded-full text-xs font-medium',
                      getSimilarityClass(detail.similarity)
                    )}>
                      {detail.similarity}% Similar
                    </span>
                  </div>
                  <div className="text-amber-600 dark:text-amber-400 text-sm">
                    <p>Unable to display row data - parsing failed</p>
                    {'_rawData' in detail.keptRowData && detail.keptRowData._rawData ? (
                      <p className="mt-1 text-xs text-muted-foreground font-mono truncate">
                        Raw: {String(detail.keptRowData._rawData).substring(0, 100)}...
                      </p>
                    ) : null}
                  </div>
                </div>
              )
            }

            return (
              <div
                key={detail.id}
                className="border border-border/50 rounded-lg overflow-hidden"
                data-testid="merge-detail-card"
              >
                {/* Card Header */}
                <div className="flex items-center justify-between px-4 py-2 bg-muted/30 border-b border-border/50">
                  <span className="text-sm font-medium">
                    Pair {detail.pairIndex + 1}
                  </span>
                  <span
                    className={cn(
                      'px-2.5 py-1 rounded-full text-xs font-medium',
                      getSimilarityClass(detail.similarity)
                    )}
                  >
                    {detail.similarity}% Similar
                  </span>
                </div>

                {/* Card Body - Side by Side */}
                <div className="grid grid-cols-2 divide-x divide-border/50">
                  {/* Kept Row */}
                  <div className="p-3">
                    <div className="flex items-center gap-1 text-xs font-semibold text-green-600 dark:text-green-400 mb-2">
                      <Check className="w-3 h-3" />
                      KEPT
                    </div>
                    <div className="border-l-4 border-green-500 bg-green-500/5 rounded-r-lg p-2">
                      <div className="space-y-1">
                        {columns.map((col) => (
                          <div key={col} className="text-xs">
                            <span className="text-muted-foreground">{col}:</span>{' '}
                            <span className={cn(
                              col === detail.matchColumn && 'font-medium'
                            )}>
                              {formatValue(detail.keptRowData[col])}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Deleted Row */}
                  <div className="p-3">
                    <div className="flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400 mb-2">
                      <X className="w-3 h-3" />
                      DELETED
                    </div>
                    <div className="border-l-4 border-red-500 bg-red-500/5 rounded-r-lg p-2">
                      <div className="space-y-1 text-muted-foreground">
                        {columns.map((col) => (
                          <div key={col} className="text-xs">
                            <span className="text-muted-foreground/70">{col}:</span>{' '}
                            <span className={cn(
                              col === detail.matchColumn && 'font-medium',
                              'line-through'
                            )}>
                              {formatValue(detail.deletedRowData[col])}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Pagination */}
      {allDetails.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            Showing pairs {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, allDetails.length)} of {allDetails.length}
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
