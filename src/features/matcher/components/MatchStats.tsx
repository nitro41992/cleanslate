import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Check, X, Clock, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MatchStatsProps {
  stats: {
    total: number
    merged: number
    keptSeparate: number
    pending: number
  }
}

export function MatchStats({ stats }: MatchStatsProps) {
  const reviewed = stats.merged + stats.keptSeparate
  const progress = stats.total > 0 ? (reviewed / stats.total) * 100 : 0

  const items = [
    {
      label: 'Total Pairs',
      value: stats.total,
      icon: Layers,
      color: 'text-muted-foreground',
    },
    {
      label: 'Merged',
      value: stats.merged,
      icon: Check,
      color: 'text-green-400',
    },
    {
      label: 'Kept Separate',
      value: stats.keptSeparate,
      icon: X,
      color: 'text-red-400',
    },
    {
      label: 'Pending',
      value: stats.pending,
      icon: Clock,
      color: 'text-yellow-400',
    },
  ]

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-8">
        <div className="flex items-center gap-6">
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              <item.icon className={cn('w-4 h-4', item.color)} />
              <div>
                <p className="text-lg font-semibold">{item.value}</p>
                <p className="text-xs text-muted-foreground">{item.label}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex-1 max-w-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>Progress</span>
            <span>{reviewed} / {stats.total}</span>
          </div>
          <Progress value={progress} />
        </div>
      </div>
    </Card>
  )
}
