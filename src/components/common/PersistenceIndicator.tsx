import { Loader2, Check, AlertCircle, Circle } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'

export function PersistenceIndicator() {
  const persistenceStatus = useUIStore((s) => s.persistenceStatus)

  // Hide when idle
  if (persistenceStatus === 'idle') return null

  return (
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
          <span>Unsaved changes</span>
        </>
      )}
      {persistenceStatus === 'saving' && (
        <>
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Saving...</span>
        </>
      )}
      {persistenceStatus === 'saved' && (
        <>
          <Check className="w-3 h-3" />
          <span>All changes saved</span>
        </>
      )}
      {persistenceStatus === 'error' && (
        <>
          <AlertCircle className="w-3 h-3" />
          <span>Save failed</span>
        </>
      )}
    </div>
  )
}
