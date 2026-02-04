import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DiffStatusBadge } from './DiffStatusBadge'
import type { DiffResult } from '@/types'
import { cn } from '@/lib/utils'

interface DiffResultsGridProps {
  results: DiffResult[]
  columns: string[]
  keyColumns: string[]
  blindMode?: boolean
  maxRows?: number
}

export function DiffResultsGrid({
  results,
  columns,
  keyColumns,
  blindMode = false,
  maxRows = 500,
}: DiffResultsGridProps) {
  // Filter out unchanged and limit to maxRows
  const displayResults = useMemo(
    () => results.filter((r) => r.status !== 'unchanged').slice(0, maxRows),
    [results, maxRows]
  )

  const totalDiffs = results.filter((r) => r.status !== 'unchanged').length

  const getCellValue = (result: DiffResult, column: string): { display: string; isModified: boolean } => {
    if (result.status === 'added') {
      const val = result.rowB?.[column]
      return {
        display: val === null || val === undefined ? '' : String(val),
        isModified: false,
      }
    }
    if (result.status === 'removed') {
      const val = result.rowA?.[column]
      return {
        display: val === null || val === undefined ? '' : String(val),
        isModified: false,
      }
    }
    // Modified or unchanged - check if this specific column changed
    const valA = result.rowA?.[column]
    const valB = result.rowB?.[column]
    const strA = valA === null || valA === undefined ? '' : String(valA)
    const strB = valB === null || valB === undefined ? '' : String(valB)
    const isModified = result.modifiedColumns?.includes(column) ?? false

    if (isModified) {
      return { display: `${strA} → ${strB}`, isModified: true }
    }
    return { display: strA, isModified: false }
  }

  const getRowClass = (status: DiffResult['status']) => {
    const base = 'border-b border-border/30 transition-colors'

    if (blindMode) {
      return cn(base, 'hover:bg-muted/50', 'diff-row-animate')
    }

    switch (status) {
      case 'added':
        return cn(base, 'row-added hover:bg-[hsl(var(--diff-added-bg)/0.8)]', 'diff-row-animate')
      case 'removed':
        return cn(base, 'row-removed hover:bg-[hsl(var(--diff-removed-bg)/0.8)]', 'diff-row-animate')
      case 'modified':
        return cn(base, 'row-modified hover:bg-[hsl(var(--diff-modified-bg)/0.8)]', 'diff-row-animate')
      default:
        return cn(base, 'hover:bg-muted/50', 'diff-row-animate')
    }
  }

  if (displayResults.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <span className="text-2xl">✓</span>
        </div>
        <p className="font-medium">No differences found</p>
        <p className="text-sm mt-1">The tables are identical</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <ScrollArea className="flex-1">
        <div className="min-w-max">
          <table className="w-full text-sm" data-testid="diff-results-table">
            <thead className="sticky top-0 bg-card z-10 shadow-sm">
              <tr className="border-b border-border">
                {!blindMode && (
                  <th className="px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider text-muted-foreground w-28">
                    Status
                  </th>
                )}
                {columns.map((col) => (
                  <th
                    key={col}
                    className={cn(
                      'px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider',
                      keyColumns.includes(col)
                        ? 'text-primary'
                        : 'text-muted-foreground'
                    )}
                  >
                    {col}
                    {keyColumns.includes(col) && (
                      <span className="ml-1 text-[10px] opacity-70">(KEY)</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayResults.map((result, idx) => (
                <tr
                  key={idx}
                  className={getRowClass(result.status)}
                  style={{ animationDelay: `${Math.min(idx, 10) * 50}ms` }}
                >
                  {!blindMode && (
                    <td className="px-4 py-2.5">
                      <DiffStatusBadge status={result.status} />
                    </td>
                  )}
                  {columns.map((col) => {
                    const { display, isModified } = getCellValue(result, col)
                    return (
                      <td
                        key={col}
                        className={cn(
                          'px-4 py-2.5 max-w-[250px] truncate font-mono text-xs',
                          !blindMode && isModified && 'cell-modified rounded'
                        )}
                        title={display}
                      >
                        {isModified && !blindMode ? (
                          <span className="flex items-center gap-1">
                            <span className="line-through opacity-50">
                              {display.split(' → ')[0]}
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-[hsl(var(--diff-modified-text))]">
                              {display.split(' → ')[1]}
                            </span>
                          </span>
                        ) : (
                          display
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ScrollArea>

      {/* Footer with info */}
      <div className="px-4 py-2 border-t border-border/50 text-xs text-muted-foreground flex items-center justify-between">
        <span>
          Showing {displayResults.length.toLocaleString()} of {totalDiffs.toLocaleString()} differences
        </span>
        {totalDiffs > maxRows && (
          <span className="text-yellow-500">
            Export for complete results
          </span>
        )}
      </div>
    </div>
  )
}
