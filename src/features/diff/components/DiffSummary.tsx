import { Card } from '@/components/ui/card'
import { Plus, Minus, RefreshCw, Equal } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DiffSummaryProps {
  summary: {
    added: number
    removed: number
    modified: number
    unchanged: number
  }
}

export function DiffSummary({ summary }: DiffSummaryProps) {
  // Convert BigInt to number if needed (DuckDB returns BigInt for counts)
  const toNum = (val: number | bigint): number =>
    typeof val === 'bigint' ? Number(val) : val

  const added = toNum(summary.added)
  const removed = toNum(summary.removed)
  const modified = toNum(summary.modified)
  const unchanged = toNum(summary.unchanged)

  const items = [
    {
      label: 'Added',
      value: added,
      icon: Plus,
      color: 'text-green-600 dark:text-green-400',
      bg: 'bg-green-500/10',
    },
    {
      label: 'Removed',
      value: removed,
      icon: Minus,
      color: 'text-red-600 dark:text-red-400',
      bg: 'bg-red-500/10',
    },
    {
      label: 'Modified',
      value: modified,
      icon: RefreshCw,
      color: 'text-yellow-600 dark:text-yellow-400',
      bg: 'bg-yellow-500/10',
    },
    {
      label: 'Unchanged',
      value: unchanged,
      icon: Equal,
      color: 'text-muted-foreground',
      bg: 'bg-muted',
    },
  ]

  const total = added + removed + modified + unchanged

  return (
    <div className="grid grid-cols-4 gap-4">
      {items.map((item) => (
        <Card
          key={item.label}
          className={cn('p-4 flex items-center gap-3', item.bg)}
        >
          <div className={cn('p-2 rounded-lg', item.bg)}>
            <item.icon className={cn('w-5 h-5', item.color)} />
          </div>
          <div>
            <p className="text-2xl font-semibold">
              {item.value.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">{item.label}</p>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">
            {total > 0 ? ((item.value / total) * 100).toFixed(1) : 0}%
          </div>
        </Card>
      ))}
    </div>
  )
}
