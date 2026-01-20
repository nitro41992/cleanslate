import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { DiffResult } from '@/types'
import { cn } from '@/lib/utils'

interface DiffGridProps {
  results: DiffResult[]
  columns: string[]
  keyColumns: string[]
  blindMode?: boolean
}

export function DiffGrid({ results, columns, keyColumns, blindMode = false }: DiffGridProps) {
  const displayResults = useMemo(
    () => results.filter((r) => r.status !== 'unchanged').slice(0, 500),
    [results]
  )

  const getCellValue = (result: DiffResult, column: string): string => {
    if (result.status === 'added') {
      const val = result.rowB?.[column]
      return val === null || val === undefined ? '' : String(val)
    }
    if (result.status === 'removed') {
      const val = result.rowA?.[column]
      return val === null || val === undefined ? '' : String(val)
    }
    // Modified - show both values
    const valA = result.rowA?.[column]
    const valB = result.rowB?.[column]
    const strA = valA === null || valA === undefined ? '' : String(valA)
    const strB = valB === null || valB === undefined ? '' : String(valB)

    if (result.modifiedColumns?.includes(column)) {
      return `${strA} → ${strB}`
    }
    return strA
  }

  const getRowClass = (status: DiffResult['status']) => {
    // In blind mode, don't show status-based coloring
    if (blindMode) {
      return 'hover:bg-muted/50'
    }
    switch (status) {
      case 'added':
        return 'bg-green-500/10 hover:bg-green-500/20'
      case 'removed':
        return 'bg-red-500/10 hover:bg-red-500/20'
      case 'modified':
        return 'bg-yellow-500/5 hover:bg-yellow-500/10'
      default:
        return 'hover:bg-muted/50'
    }
  }

  const getCellClass = (result: DiffResult, column: string) => {
    // In blind mode, don't highlight modified cells
    if (blindMode) {
      return ''
    }
    if (result.status === 'modified' && result.modifiedColumns?.includes(column)) {
      return 'bg-yellow-500/20 font-medium'
    }
    return ''
  }

  if (displayResults.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No differences found
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="min-w-max">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted z-10">
            <tr>
              {!blindMode && (
                <th className="px-3 py-2 text-left font-medium text-muted-foreground w-20">
                  Status
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col}
                  className={cn(
                    'px-3 py-2 text-left font-medium',
                    keyColumns.includes(col)
                      ? 'text-primary'
                      : 'text-muted-foreground'
                  )}
                >
                  {col}
                  {keyColumns.includes(col) && ' (key)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayResults.map((result, idx) => (
              <tr
                key={idx}
                className={cn(
                  'border-b border-border/30 transition-colors',
                  getRowClass(result.status)
                )}
              >
                {!blindMode && (
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                        result.status === 'added' &&
                          'bg-green-500/20 text-green-400',
                        result.status === 'removed' &&
                          'bg-red-500/20 text-red-400',
                        result.status === 'modified' &&
                          'bg-yellow-500/20 text-yellow-400'
                      )}
                    >
                      {result.status}
                    </span>
                  </td>
                )}
                {columns.map((col) => (
                  <td
                    key={col}
                    className={cn(
                      'px-3 py-2 max-w-[200px] truncate',
                      getCellClass(result, col)
                    )}
                    title={getCellValue(result, col)}
                  >
                    {getCellValue(result, col)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {results.filter((r) => r.status !== 'unchanged').length > 500 && (
        <div className="text-center py-4 text-sm text-muted-foreground">
          Showing first 500 differences. Export for full results.
        </div>
      )}
    </ScrollArea>
  )
}
