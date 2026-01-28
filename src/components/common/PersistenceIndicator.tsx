import { Loader2, Check, AlertCircle, Circle } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function PersistenceIndicator() {
  const persistenceStatus = useUIStore((s) => s.persistenceStatus)
  const savingTables = useUIStore((s) => s.savingTables)
  const pendingTables = useUIStore((s) => s.pendingTables)
  const chunkProgress = useUIStore((s) => s.chunkProgress)
  const compactionStatus = useUIStore((s) => s.compactionStatus)
  const pendingChangelogCount = useUIStore((s) => s.pendingChangelogCount)

  // Hide when idle
  if (persistenceStatus === 'idle') return null

  const totalQueueDepth = savingTables.length + pendingTables.length
  const isChunking = chunkProgress !== null

  // Build progress text based on queue state
  const getProgressText = () => {
    if (persistenceStatus === 'saving') {
      if (totalQueueDepth > 1) {
        return `Saving ${savingTables.length} of ${totalQueueDepth}...`
      }
      if (isChunking) {
        return `Saving (${chunkProgress.currentChunk}/${chunkProgress.totalChunks})...`
      }
      return 'Saving...'
    }
    if (persistenceStatus === 'dirty') return 'Unsaved changes'
    if (persistenceStatus === 'saved') return 'All changes saved'
    if (persistenceStatus === 'error') return 'Save failed'
    return ''
  }

  // Tooltip content showing detailed queue state
  const tooltipContent = (
    <div className="space-y-2 min-w-[200px]">
      {savingTables.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Currently saving:
          </div>
          <ul className="text-xs space-y-0.5">
            {savingTables.map((table) => (
              <li key={table} className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                <span>{table}</span>
                {chunkProgress?.tableName === table && (
                  <span className="text-muted-foreground">
                    (chunk {chunkProgress.currentChunk}/{chunkProgress.totalChunks})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pendingTables.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Queued:
          </div>
          <ul className="text-xs space-y-0.5">
            {pendingTables.map((table) => (
              <li key={table} className="flex items-center gap-1.5">
                <Circle className="w-2 h-2 fill-muted-foreground text-muted-foreground" />
                <span>{table}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pendingChangelogCount > 0 && (
        <div className="text-xs text-muted-foreground border-t border-border/50 pt-2">
          {pendingChangelogCount.toLocaleString()} cell edit{pendingChangelogCount !== 1 ? 's' : ''} pending compaction
          {compactionStatus === 'running' && (
            <span className="ml-1 text-amber-500">(compacting...)</span>
          )}
        </div>
      )}

      {persistenceStatus === 'error' && (
        <div className="text-xs text-destructive border-t border-border/50 pt-2">
          Save failed. Will retry automatically.
        </div>
      )}
    </div>
  )

  // Only show tooltip when there's useful detail
  const hasDetail =
    savingTables.length > 0 ||
    pendingTables.length > 0 ||
    pendingChangelogCount > 0 ||
    persistenceStatus === 'error'

  const indicator = (
    <div
      className={cn(
        'flex items-center gap-2 text-xs transition-opacity duration-200',
        persistenceStatus === 'dirty' && 'text-amber-400',
        persistenceStatus === 'saving' && 'text-amber-500',
        persistenceStatus === 'saved' && 'text-green-500',
        persistenceStatus === 'error' && 'text-destructive'
      )}
    >
      {persistenceStatus === 'dirty' && (
        <>
          <Circle className="w-2.5 h-2.5 fill-current animate-pulse" />
          <span>{getProgressText()}</span>
        </>
      )}
      {persistenceStatus === 'saving' && (
        <>
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{getProgressText()}</span>
          {/* Mini progress bar for chunked exports */}
          {isChunking && (
            <div className="w-12 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-amber-500 transition-all"
                style={{
                  width: `${(chunkProgress.currentChunk / chunkProgress.totalChunks) * 100}%`,
                }}
              />
            </div>
          )}
        </>
      )}
      {persistenceStatus === 'saved' && (
        <>
          <Check className="w-3 h-3" />
          <span>{getProgressText()}</span>
        </>
      )}
      {persistenceStatus === 'error' && (
        <>
          <AlertCircle className="w-3 h-3" />
          <span>{getProgressText()}</span>
        </>
      )}
    </div>
  )

  if (!hasDetail) {
    return indicator
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">{indicator}</div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px]">
          {tooltipContent}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
