import { useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'

export function MemoryIndicator() {
  const { memoryUsage, memoryLimit, setMemoryUsage } = useUIStore()

  useEffect(() => {
    const updateMemory = () => {
      if ('memory' in performance) {
        const mem = (performance as Performance & { memory: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
        setMemoryUsage(mem.usedJSHeapSize, mem.jsHeapSizeLimit)
      }
    }

    updateMemory()
    const interval = setInterval(updateMemory, 5000)
    return () => clearInterval(interval)
  }, [setMemoryUsage])

  const percentage = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0
  const isWarning = percentage > 60
  const isCritical = percentage > 80

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
