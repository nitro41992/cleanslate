import { Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'

interface ClusterProgressProps {
  phase: 'idle' | 'validating' | 'clustering' | 'complete'
  progress: number
  currentChunk: number
  totalChunks: number
}

export function ClusterProgress({
  phase,
  progress,
  currentChunk,
  totalChunks,
}: ClusterProgressProps) {
  if (phase === 'idle' || phase === 'complete') {
    return null
  }

  return (
    <div className="flex items-center gap-3 min-w-[280px]">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <div className="flex-1 flex flex-col gap-1">
        <Progress value={progress} className="h-2" />
        <span className="text-xs text-muted-foreground">
          {phase === 'validating' && 'Validating column...'}
          {phase === 'clustering' && (
            <>
              Clustering {currentChunk}/{totalChunks} chunks
              {progress > 0 && ` (${progress}%)`}
            </>
          )}
        </span>
      </div>
    </div>
  )
}
