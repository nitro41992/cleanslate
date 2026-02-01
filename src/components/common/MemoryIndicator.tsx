import { useEffect, useState } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { useDuckDB } from '@/hooks/useDuckDB'
import { toast } from '@/hooks/use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

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
  const {
    memoryUsage,
    memoryLevel,
    memoryBreakdown,
    jsHeapBytes,
    refreshMemory,
    busyCount,
  } = useUIStore()
  const { isReady, compactMemory } = useDuckDB()
  const isBusy = busyCount > 0
  const [isCompacting, setIsCompacting] = useState(false)

  useEffect(() => {
    // Don't poll until DuckDB is ready
    if (!isReady) return

    // Initial refresh
    refreshMemory()

    // Poll every 5 seconds as a backup for any missed updates
    const interval = setInterval(refreshMemory, 5000)
    return () => clearInterval(interval)
  }, [isReady, refreshMemory])

  const isWarning = memoryLevel === 'warning'
  const isCritical = memoryLevel === 'critical'

  // Calculate max for breakdown bars (use total memory usage as reference)
  const totalBreakdown =
    memoryBreakdown.tableDataBytes +
    memoryBreakdown.timelineBytes +
    memoryBreakdown.diffBytes +
    memoryBreakdown.overheadBytes
  const maxForBars = Math.max(totalBreakdown, memoryUsage, 1) // Avoid division by zero

  // Handle memory compaction
  const handleCompact = async () => {
    setIsCompacting(true)
    try {
      await compactMemory()
      toast({
        title: 'Memory compacted',
        description: 'Database restarted successfully.',
      })
    } catch (error) {
      toast({
        title: 'Compaction failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setIsCompacting(false)
    }
  }

  // Warning thresholds based on JS Heap (more reliable than estimates)
  const JS_HEAP_WARNING = 500 * 1024 * 1024   // 500 MB
  const JS_HEAP_CRITICAL = 1024 * 1024 * 1024 // 1 GB

  const jsHeapLevel = jsHeapBytes === null ? 'healthy' :
    jsHeapBytes > JS_HEAP_CRITICAL ? 'critical' :
    jsHeapBytes > JS_HEAP_WARNING ? 'warning' : 'healthy'

  // Warning message based on JS heap (what we can actually measure)
  const getWarningMessage = () => {
    if (jsHeapLevel === 'critical') {
      return 'JS Heap over 1 GB. Refresh page to reclaim memory.'
    }
    if (jsHeapLevel === 'warning') {
      return 'JS Heap elevated. Consider refreshing if it keeps growing.'
    }
    return null
  }

  // Dropdown content with memory breakdown and compact button
  const dropdownContent = (
    <div className="space-y-3 p-2">
      {/* Memory breakdown bars */}
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

      {/* JS Heap Memory - what we can actually measure */}
      {jsHeapBytes !== null && (
        <div className="pt-2 border-t border-border space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">JS Heap</span>
            <span className={cn(
              'font-medium',
              jsHeapBytes > 500 * 1024 * 1024 ? 'text-destructive' :
              jsHeapBytes > 250 * 1024 * 1024 ? 'text-amber-500' :
              'text-muted-foreground'
            )}>
              {formatBytes(jsHeapBytes)}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Task Manager shows ~2-3x this value (includes WASM, GPU, browser overhead).
            Refresh page to reclaim memory.
          </p>
        </div>
      )}

      {/* Warning message if applicable */}
      {getWarningMessage() && (
        <div
          className={cn(
            'text-xs p-2 rounded-md',
            jsHeapLevel === 'critical'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-amber-500/10 text-amber-500'
          )}
        >
          {getWarningMessage()}
          {jsHeapLevel === 'critical' && (
            <Button
              variant="destructive"
              size="sm"
              className="w-full mt-2"
              onClick={() => window.location.reload()}
            >
              Refresh Page
            </Button>
          )}
        </div>
      )}

      {/* Compact Memory button with confirmation */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isCompacting || !isReady}
          >
            {isCompacting ? 'Compacting...' : 'Compact Memory'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact Memory?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restart the database engine to release unused memory.
              Your data is saved and will reload automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCompact}>Compact</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <p className="text-xs text-muted-foreground">
        WASM memory grows but cannot shrink. Compacting restarts the engine to reclaim memory.
      </p>
    </div>
  )

  // Health dot color based on memory level
  const healthDotColor = isCritical
    ? 'bg-destructive'
    : isWarning
    ? 'bg-amber-500'
    : 'bg-emerald-500'

  // Compact view for status bar
  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div
            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
          >
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                healthDotColor,
                isBusy && 'animate-pulse opacity-50',
                isCompacting && 'animate-pulse'
              )}
            />
            <span>{isCompacting ? '...' : formatBytes(memoryUsage)}</span>
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="flex justify-between">
            <span>Memory Usage</span>
            <span className={cn(
              'font-medium',
              isCritical ? 'text-destructive' : isWarning ? 'text-amber-500' : 'text-emerald-500'
            )}>
              {isCritical ? 'High' : isWarning ? 'Elevated' : 'Healthy'}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {dropdownContent}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Full view (sidebar)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <div className="cursor-pointer group">
          <div className="flex items-center gap-2 text-xs text-muted-foreground group-hover:text-foreground transition-colors">
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                healthDotColor,
                isBusy && 'animate-pulse opacity-50',
                isCompacting && 'animate-pulse'
              )}
            />
            <span>Memory</span>
            <span className="ml-auto">{isCompacting ? '...' : formatBytes(memoryUsage)}</span>
          </div>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-72">
        <DropdownMenuLabel className="flex justify-between">
          <span>Memory Usage</span>
          <span className={cn(
            'font-medium',
            isCritical ? 'text-destructive' : isWarning ? 'text-amber-500' : 'text-emerald-500'
          )}>
            {isCritical ? 'High' : isWarning ? 'Elevated' : 'Healthy'}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {dropdownContent}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
