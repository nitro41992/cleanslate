import { useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { useDuckDB } from '@/hooks/useDuckDB'
import { query } from '@/lib/duckdb'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface MemoryIndicatorProps {
  compact?: boolean
}

/**
 * Progress bar component for memory breakdown display
 */
function BreakdownBar({
  label,
  bytes,
  maxBytes,
  color,
}: {
  label: string
  bytes: number
  maxBytes: number
  color: string
}) {
  const percentage = maxBytes > 0 ? (bytes / maxBytes) * 100 : 0

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-20 truncate">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-16 text-right">
        {formatBytes(bytes)}
      </span>
    </div>
  )
}

export function MemoryIndicator({ compact = false }: MemoryIndicatorProps) {
  const { memoryUsage, memoryLimit, memoryLevel, memoryBreakdown, refreshMemory, busyCount } =
    useUIStore()
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

  // Calculate max for breakdown bars (use total memory usage as reference)
  const totalBreakdown =
    memoryBreakdown.tableDataBytes +
    memoryBreakdown.timelineBytes +
    memoryBreakdown.diffBytes +
    memoryBreakdown.overheadBytes
  const maxForBars = Math.max(totalBreakdown, memoryUsage, 1) // Avoid division by zero

  // Diagnostic function to log memory details to console
  const runDiagnostics = async () => {
    console.group('DuckDB Memory Diagnostics')
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

      console.log('Active Tables:')
      if (tables.length === 0) {
        console.log('   (No user tables found)')
      } else {
        console.table(tables)
      }

      // 2. Check total heap usage
      const sizeInfo = await query('CALL pragma_database_size()')
      console.log('Heap Allocation:', sizeInfo[0])

      // 3. Log UI Store stats
      console.log('App State:', {
        memoryUsage: formatBytes(memoryUsage),
        memoryLimit: formatBytes(memoryLimit),
        percentage: percentage.toFixed(1) + '%',
      })

      // 4. Log breakdown
      console.log('Memory Breakdown:', {
        tableData: formatBytes(memoryBreakdown.tableDataBytes),
        timeline: formatBytes(memoryBreakdown.timelineBytes),
        diff: formatBytes(memoryBreakdown.diffBytes),
        overhead: formatBytes(memoryBreakdown.overheadBytes),
      })
    } catch (err) {
      console.error('Diagnostic failed:', err)
    }
    console.groupEnd()
  }

  // Warning message based on level
  const getWarningMessage = () => {
    if (isCritical) {
      return 'Memory usage is high. Consider deleting unused tables.'
    }
    if (isWarning) {
      return 'Memory usage is elevated.'
    }
    return null
  }

  // Tooltip content with memory breakdown
  const tooltipContent = (
    <div className="space-y-3 min-w-[240px]">
      {/* Header with total */}
      <div className="flex justify-between text-xs font-medium">
        <span>DuckDB Memory</span>
        <span>{formatBytes(memoryUsage)}</span>
      </div>

      {/* Breakdown bars */}
      <div className="space-y-1.5">
        <BreakdownBar
          label="Your Data"
          bytes={memoryBreakdown.tableDataBytes}
          maxBytes={maxForBars}
          color="bg-primary"
        />
        <BreakdownBar
          label="Undo History"
          bytes={memoryBreakdown.timelineBytes}
          maxBytes={maxForBars}
          color="bg-blue-500"
        />
        <BreakdownBar
          label="Diff View"
          bytes={memoryBreakdown.diffBytes}
          maxBytes={maxForBars}
          color="bg-purple-500"
        />
        <BreakdownBar
          label="Engine"
          bytes={memoryBreakdown.overheadBytes}
          maxBytes={maxForBars}
          color="bg-muted-foreground"
        />
      </div>

      {/* Warning message if applicable */}
      {getWarningMessage() && (
        <div
          className={cn(
            'text-xs border-t border-border/50 pt-2',
            isCritical ? 'text-destructive' : 'text-amber-500'
          )}
        >
          {getWarningMessage()}
        </div>
      )}

      {/* Click hint */}
      <div className="text-xs text-muted-foreground border-t border-border/50 pt-2">
        Click for detailed diagnostics
      </div>
    </div>
  )

  // Compact view for status bar
  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
              onClick={runDiagnostics}
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
              <span>{Math.round(percentage)}%</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipContent}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // Full view (sidebar)
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="space-y-1.5 cursor-pointer group"
            onClick={runDiagnostics}
          >
            <div className="flex items-center justify-between text-xs text-muted-foreground group-hover:text-foreground transition-colors">
              <span>Memory</span>
              <span>{Math.round(percentage)}%</span>
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
        </TooltipTrigger>
        <TooltipContent side="right">{tooltipContent}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
