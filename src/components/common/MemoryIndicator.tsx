import { useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { useDuckDB } from '@/hooks/useDuckDB'
import { query } from '@/lib/duckdb'

interface MemoryIndicatorProps {
  compact?: boolean
}

export function MemoryIndicator({ compact = false }: MemoryIndicatorProps) {
  const { memoryUsage, memoryLimit, memoryLevel, refreshMemory, busyCount } = useUIStore()
  const { isReady } = useDuckDB()
  const isBusy = busyCount > 0

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

  // Diagnostic function to log memory details to console
  const runDiagnostics = async () => {
    console.group('🕵️‍♀️ DuckDB Memory Diagnostics')
    try {
      // 1. Check active tables
      const tables = await query<{ name: string; rows: number }>(`
        SELECT
          table_name as name,
          estimated_size as rows
        FROM duckdb_tables()
        WHERE NOT internal
        ORDER BY rows DESC
      `)

      console.log('📊 Active Tables:')
      if (tables.length === 0) {
        console.log('   (No user tables found)')
      } else {
        console.table(tables)
      }

      // 2. Check total heap usage
      const sizeInfo = await query('CALL pragma_database_size()')
      console.log('💾 Heap Allocation:', sizeInfo[0])

      // 3. Log UI Store stats
      console.log('🧠 App State:', {
        memoryUsage: formatBytes(memoryUsage),
        memoryLimit: formatBytes(memoryLimit),
        percentage: percentage.toFixed(1) + '%'
      })

    } catch (err) {
      console.error('Diagnostic failed:', err)
    }
    console.groupEnd()
  }

  if (compact) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
        onClick={runDiagnostics}
        title="Click to log memory diagnostics"
      >
        <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              isCritical ? 'bg-destructive' : isWarning ? 'bg-amber-500' : 'bg-primary',
              isBusy && 'animate-pulse opacity-50'
            )}
            style={{ width: `${Math.min(percentage, 100)}%` }}
          />
        </div>
        <span>{formatBytes(memoryUsage)}</span>
      </div>
    )
  }

  return (
    <div
      className="space-y-1.5 cursor-pointer group"
      onClick={runDiagnostics}
      title="Click to log memory diagnostics to console"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground group-hover:text-foreground transition-colors">
        <span>Memory</span>
        <span>{formatBytes(memoryUsage)} / {formatBytes(memoryLimit)}</span>
      </div>
      <div className="memory-bar">
        <div
          className={cn(
            'memory-bar-fill',
            isWarning && !isCritical && 'warning',
            isCritical && 'critical',
            isBusy && 'animate-pulse opacity-50'
          )}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  )
}
