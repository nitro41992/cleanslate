import { useEffect, useState } from 'react'
import { Plus, Minus, RefreshCw, Equal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDiffStore } from '@/stores/diffStore'

type DiffStatus = 'added' | 'removed' | 'modified'

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
  const statusFilter = useDiffStore((s) => s.statusFilter)
  const toggleStatusFilter = useDiffStore((s) => s.toggleStatusFilter)

  const [displayValues, setDisplayValues] = useState({
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  })

  // Check if a status is currently active in the filter
  const isActive = (status: DiffStatus): boolean => {
    if (statusFilter === null) return false
    return statusFilter.includes(status)
  }

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
      key: 'added' as DiffStatus,
      label: 'Added',
      value: displayValues.added,
      target: targetValues.added,
      icon: Plus,
      bgClass: 'bg-[hsl(var(--diff-added-bg))]',
      borderClass: 'border-[hsl(var(--diff-added-border))]',
      textClass: 'text-[hsl(var(--diff-added-text))]',
      animClass: 'diff-pill-added',
      clickable: true,
    },
    {
      key: 'removed' as DiffStatus,
      label: 'Removed',
      value: displayValues.removed,
      target: targetValues.removed,
      icon: Minus,
      bgClass: 'bg-[hsl(var(--diff-removed-bg))]',
      borderClass: 'border-[hsl(var(--diff-removed-border))]',
      textClass: 'text-[hsl(var(--diff-removed-text))]',
      animClass: 'diff-pill-removed',
      clickable: true,
    },
    {
      key: 'modified' as DiffStatus,
      label: 'Changed',
      value: displayValues.modified,
      target: targetValues.modified,
      icon: RefreshCw,
      bgClass: 'bg-[hsl(var(--diff-modified-bg))]',
      borderClass: 'border-[hsl(var(--diff-modified-border))]',
      textClass: 'text-[hsl(var(--diff-modified-text))]',
      animClass: 'diff-pill-modified',
      clickable: true,
    },
    {
      key: 'unchanged' as const,
      label: 'Same',
      value: displayValues.unchanged,
      target: targetValues.unchanged,
      icon: Equal,
      bgClass: 'bg-[hsl(var(--diff-unchanged-bg))]',
      borderClass: 'border-muted',
      textClass: 'text-[hsl(var(--diff-unchanged-text))]',
      animClass: 'diff-pill-unchanged',
      clickable: false, // "Same" is display only, not filterable
    },
  ]

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {pills.map((pill) => {
        const Icon = pill.icon
        const active = pill.clickable && isActive(pill.key as DiffStatus)

        // Common content for both button and div
        const content = (
          <>
            <Icon className={cn('w-4 h-4', pill.textClass)} />
            <span className={cn('text-xl font-bold tabular-nums', pill.textClass)}>
              {pill.value.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {pill.label}
            </span>
          </>
        )

        // Clickable pills (Added, Removed, Changed)
        if (pill.clickable) {
          return (
            <button
              key={pill.key}
              onClick={() => toggleStatusFilter(pill.key as DiffStatus)}
              className={cn(
                'diff-pill flex items-center gap-2 px-3 py-2 rounded-lg border transition-all',
                'cursor-pointer hover:opacity-80',
                pill.bgClass,
                pill.borderClass,
                pill.animClass,
                // Active state: show ring highlight
                active && 'ring-2 ring-offset-2 ring-offset-background ring-current opacity-100',
                // Inactive when other filters are active: dim slightly
                statusFilter !== null && !active && 'opacity-50'
              )}
              data-testid={`diff-pill-${pill.key}`}
              data-active={active}
            >
              {content}
            </button>
          )
        }

        // Non-clickable pill (Same - display only)
        return (
          <div
            key={pill.key}
            className={cn(
              'diff-pill flex items-center gap-2 px-3 py-2 rounded-lg border',
              pill.bgClass,
              pill.borderClass,
              pill.animClass,
              // Dim when filters are active (since "Same" rows are always hidden in diff view)
              statusFilter !== null && 'opacity-50'
            )}
            data-testid={`diff-pill-${pill.key}`}
          >
            {content}
          </div>
        )
      })}
    </div>
  )
}
