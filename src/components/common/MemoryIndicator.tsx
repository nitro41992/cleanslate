import { useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { useDuckDB } from '@/hooks/useDuckDB'

interface MemoryIndicatorProps {
  compact?: boolean
}

export function MemoryIndicator({ compact = false }: MemoryIndicatorProps) {
  const { memoryUsage, memoryLimit, memoryLevel, refreshMemory } = useUIStore()
  const { isReady } = useDuckDB()

  useEffect(() => {
    // Don't poll until DuckDB is ready
    if (!isReady) return

    // Initial refresh
    refreshMemory()

    // Poll every 5 seconds as a backup for any missed updates
    const interval = setInterval(refreshMemory, 5000)
    return () => clearInterval(interval)
  }, [isReady, refreshMemory])

  const percentage = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0
  const isWarning = memoryLevel === 'warning'
  const isCritical = memoryLevel === 'critical'

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              isCritical ? 'bg-destructive' : isWarning ? 'bg-amber-500' : 'bg-primary'
            )}
            style={{ width: `${Math.min(percentage, 100)}%` }}
          />
        </div>
        <span>{formatBytes(memoryUsage)}</span>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Memory</span>
        <span>{formatBytes(memoryUsage)} / {formatBytes(memoryLimit)}</span>
      </div>
      <div className="memory-bar">
        <div
          className={cn(
            'memory-bar-fill',
            isWarning && !isCritical && 'warning',
            isCritical && 'critical'
          )}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  )
}
