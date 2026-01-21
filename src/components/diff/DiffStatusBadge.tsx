import { Plus, Minus, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DiffResult } from '@/types'

interface DiffStatusBadgeProps {
  status: DiffResult['status']
  showIcon?: boolean
  className?: string
}

export function DiffStatusBadge({ status, showIcon = true, className }: DiffStatusBadgeProps) {
  const config = {
    added: {
      label: 'ADDED',
      icon: Plus,
      bgClass: 'bg-[hsl(var(--diff-added-bg))]',
      textClass: 'text-[hsl(var(--diff-added-text))]',
      borderClass: 'border-[hsl(var(--diff-added-border))]',
    },
    removed: {
      label: 'REMOVED',
      icon: Minus,
      bgClass: 'bg-[hsl(var(--diff-removed-bg))]',
      textClass: 'text-[hsl(var(--diff-removed-text))]',
      borderClass: 'border-[hsl(var(--diff-removed-border))]',
    },
    modified: {
      label: 'CHANGED',
      icon: RefreshCw,
      bgClass: 'bg-[hsl(var(--diff-modified-bg))]',
      textClass: 'text-[hsl(var(--diff-modified-text))]',
      borderClass: 'border-[hsl(var(--diff-modified-border))]',
    },
    unchanged: {
      label: 'SAME',
      icon: null,
      bgClass: 'bg-[hsl(var(--diff-unchanged-bg))]',
      textClass: 'text-[hsl(var(--diff-unchanged-text))]',
      borderClass: 'border-muted',
    },
  }

  const { label, icon: Icon, bgClass, textClass, borderClass } = config[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-semibold tracking-wider',
        bgClass,
        textClass,
        borderClass,
        className
      )}
    >
      {showIcon && Icon && <Icon className="w-3 h-3" />}
      {label}
    </span>
  )
}
