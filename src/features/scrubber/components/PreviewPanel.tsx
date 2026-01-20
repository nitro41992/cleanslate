import { ScrollArea } from '@/components/ui/scroll-area'
import type { ObfuscationRule } from '@/types'
import { cn } from '@/lib/utils'

interface PreviewPanelProps {
  data: Record<string, unknown>[]
  columns: string[]
  rules: ObfuscationRule[]
}

export function PreviewPanel({ data, columns, rules }: PreviewPanelProps) {
  const obfuscatedColumns = rules.map((r) => r.column)

  return (
    <ScrollArea className="h-full">
      <div className="min-w-max">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card z-10">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className={cn(
                    'px-3 py-2 text-left font-medium border-b border-border/50',
                    obfuscatedColumns.includes(col)
                      ? 'text-primary bg-primary/5'
                      : 'text-muted-foreground'
                  )}
                >
                  {col}
                  {obfuscatedColumns.includes(col) && (
                    <span className="ml-1 text-xs">(scrubbed)</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr key={idx} className="border-b border-border/30">
                {columns.map((col) => {
                  const value = row[col]
                  const isObfuscated = obfuscatedColumns.includes(col)
                  return (
                    <td
                      key={col}
                      className={cn(
                        'px-3 py-2 max-w-[150px] truncate',
                        isObfuscated && 'text-primary/80 font-mono text-xs'
                      )}
                      title={String(value ?? '')}
                    >
                      {value === null || value === undefined
                        ? ''
                        : String(value)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ScrollArea>
  )
}
