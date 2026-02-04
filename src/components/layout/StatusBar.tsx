import { AlertCircle } from 'lucide-react'
import { usePreviewStore } from '@/stores/previewStore'
import { MemoryIndicator } from '@/components/common/MemoryIndicator'
import { PersistenceIndicator } from '@/components/common/PersistenceIndicator'

export function StatusBar() {
  const isLargeFile = usePreviewStore((s) => s.isLargeFile)
  const estimatedSizeMB = usePreviewStore((s) => s.estimatedSizeMB)

  return (
    <footer className="h-10 flex items-center justify-between px-4 border-t border-border/50 bg-card shrink-0">
      {/* Left: Memory indicator and file size warning */}
      <div className="flex items-center gap-4">
        <MemoryIndicator compact />
        {isLargeFile && (
          <div className="flex items-center gap-1 text-xs text-amber-500">
            <AlertCircle className="w-3 h-3" />
            <span>Large file ({Math.round(estimatedSizeMB)}MB) - using lazy preview</span>
          </div>
        )}
      </div>

      {/* Center: Persistence status indicator */}
      <div className="flex items-center gap-3">
        <PersistenceIndicator />
      </div>

      {/* Right: Empty placeholder for layout balance */}
      <div className="flex items-center gap-2" />
    </footer>
  )
}
