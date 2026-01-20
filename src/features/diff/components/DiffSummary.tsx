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
  const items = [
    {
      label: 'Added',
      value: summary.added,
      icon: Plus,
      color: 'text-green-400',
      bg: 'bg-green-500/10',
    },
    {
      label: 'Removed',
      value: summary.removed,
      icon: Minus,
      color: 'text-red-400',
      bg: 'bg-red-500/10',
    },
    {
      label: 'Modified',
      value: summary.modified,
      icon: RefreshCw,
      color: 'text-yellow-400',
      bg: 'bg-yellow-500/10',
    },
    {
      label: 'Unchanged',
      value: summary.unchanged,
      icon: Equal,
      color: 'text-muted-foreground',
      bg: 'bg-muted',
    },
  ]

  const total = summary.added + summary.removed + summary.modified + summary.unchanged

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
