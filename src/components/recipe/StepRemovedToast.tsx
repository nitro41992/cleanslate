import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const DURATION = 6000

interface StepRemovedToastProps {
  toastId: string | number
  onUndo: () => void
}

export function StepRemovedToast({ toastId, onUndo }: StepRemovedToastProps) {
  const [started, setStarted] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setStarted(true))
  }, [])

  return (
    <div
      className={cn(
        'bg-card text-foreground border border-border rounded-lg shadow-lg',
        'w-[356px] overflow-hidden'
      )}
      // Prevent Radix DismissableLayer from interpreting toast clicks
      // as "outside click" on the Sheet, which would close the panel
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-sm">Step removed</span>
        <button
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium',
            'text-primary hover:text-primary/80',
            'px-2.5 py-1 rounded-md',
            'hover:bg-primary/10 transition-colors'
          )}
          onClick={() => {
            onUndo()
            toast.dismiss(toastId)
          }}
        >
          <Undo2 className="w-3 h-3" />
          Undo
        </button>
      </div>
      <div className="h-[2px] bg-muted">
        <div
          className="h-full bg-primary/30 ease-linear"
          style={{
            width: started ? '0%' : '100%',
            transitionProperty: 'width',
            transitionDuration: `${DURATION}ms`,
          }}
        />
      </div>
    </div>
  )
}

export { DURATION as STEP_TOAST_DURATION }
