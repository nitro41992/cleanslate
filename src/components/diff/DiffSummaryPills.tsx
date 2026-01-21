import { useEffect, useState } from 'react'
import { Plus, Minus, RefreshCw, Equal } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DiffSummaryPillsProps {
  summary: {
    added: number
    removed: number
    modified: number
    unchanged: number
  }
  animate?: boolean
}

export function DiffSummaryPills({ summary, animate = true }: DiffSummaryPillsProps) {
  const [displayValues, setDisplayValues] = useState({
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  })

  // Convert BigInt to number if needed
  const toNum = (val: number | bigint): number =>
    typeof val === 'bigint' ? Number(val) : val

  const targetValues = {
    added: toNum(summary.added),
    removed: toNum(summary.removed),
    modified: toNum(summary.modified),
    unchanged: toNum(summary.unchanged),
  }

  // Animate count-up effect
  useEffect(() => {
    if (!animate) {
      setDisplayValues(targetValues)
      return
    }

    const duration = 600
    const steps = 20
    const interval = duration / steps

    let step = 0
    const timer = setInterval(() => {
      step++
      const progress = step / steps
      const eased = 1 - Math.pow(1 - progress, 3) // ease-out cubic

      setDisplayValues({
        added: Math.round(targetValues.added * eased),
        removed: Math.round(targetValues.removed * eased),
        modified: Math.round(targetValues.modified * eased),
        unchanged: Math.round(targetValues.unchanged * eased),
      })

      if (step >= steps) {
        clearInterval(timer)
        setDisplayValues(targetValues)
      }
    }, interval)

    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.added, summary.removed, summary.modified, summary.unchanged, animate])

  const pills = [
    {
      key: 'added',
      label: 'Added',
      value: displayValues.added,
      target: targetValues.added,
      icon: Plus,
      bgClass: 'bg-[hsl(var(--diff-added-bg))]',
      borderClass: 'border-[hsl(var(--diff-added-border))]',
      textClass: 'text-[hsl(var(--diff-added-text))]',
      animClass: 'diff-pill-added',
    },
    {
      key: 'removed',
      label: 'Removed',
      value: displayValues.removed,
      target: targetValues.removed,
      icon: Minus,
      bgClass: 'bg-[hsl(var(--diff-removed-bg))]',
      borderClass: 'border-[hsl(var(--diff-removed-border))]',
      textClass: 'text-[hsl(var(--diff-removed-text))]',
      animClass: 'diff-pill-removed',
    },
    {
      key: 'modified',
      label: 'Changed',
      value: displayValues.modified,
      target: targetValues.modified,
      icon: RefreshCw,
      bgClass: 'bg-[hsl(var(--diff-modified-bg))]',
      borderClass: 'border-[hsl(var(--diff-modified-border))]',
      textClass: 'text-[hsl(var(--diff-modified-text))]',
      animClass: 'diff-pill-modified',
    },
    {
      key: 'unchanged',
      label: 'Same',
      value: displayValues.unchanged,
      target: targetValues.unchanged,
      icon: Equal,
      bgClass: 'bg-[hsl(var(--diff-unchanged-bg))]',
      borderClass: 'border-muted',
      textClass: 'text-[hsl(var(--diff-unchanged-text))]',
      animClass: 'diff-pill-unchanged',
    },
  ]

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {pills.map((pill) => {
        const Icon = pill.icon
        return (
          <div
            key={pill.key}
            className={cn(
              'diff-pill flex items-center gap-2 px-3 py-2 rounded-lg border',
              pill.bgClass,
              pill.borderClass,
              pill.animClass
            )}
            data-testid={`diff-pill-${pill.key}`}
          >
            <Icon className={cn('w-4 h-4', pill.textClass)} />
            <span className={cn('text-xl font-bold tabular-nums', pill.textClass)}>
              {pill.value.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {pill.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
