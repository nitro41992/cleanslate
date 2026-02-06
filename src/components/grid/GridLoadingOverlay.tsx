import { useEffect, useState } from 'react'

interface GridLoadingOverlayProps {
  /** Whether data is currently being fetched */
  isLoading: boolean
}

/**
 * Subtle loading indicator that overlays the bottom of the grid
 * when new data pages are being fetched during scroll/drag.
 *
 * Shows a thin animated bar + text to indicate activity without
 * blocking the existing visible data.
 */
export function GridLoadingOverlay({ isLoading }: GridLoadingOverlayProps) {
  // Debounce: only show after a short delay to avoid flicker for fast cache hits
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setVisible(true), 150)
      return () => clearTimeout(timer)
    } else {
      setVisible(false)
    }
  }, [isLoading])

  if (!visible) return null

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-card/90 border border-border/50 shadow-lg backdrop-blur-sm">
        {/* Animated dots */}
        <div className="flex items-center gap-0.5">
          <span className="block w-1 h-1 rounded-full bg-primary animate-[gridDot_1.2s_ease-in-out_infinite]" />
          <span className="block w-1 h-1 rounded-full bg-primary animate-[gridDot_1.2s_ease-in-out_0.2s_infinite]" />
          <span className="block w-1 h-1 rounded-full bg-primary animate-[gridDot_1.2s_ease-in-out_0.4s_infinite]" />
        </div>
        <span className="text-[11px] text-muted-foreground font-medium tracking-wide">
          Loading rows
        </span>
      </div>
    </div>
  )
}
