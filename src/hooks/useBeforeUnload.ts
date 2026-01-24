/**
 * useBeforeUnload Hook
 * Ensures pending debounced flush completes before tab closes
 */

import { useEffect } from 'react'
import { flushDuckDB } from '@/lib/duckdb'

/**
 * Hook to flush DuckDB on window.beforeunload
 * Ensures pending debounced writes complete before tab closes
 */
export function useBeforeUnload() {
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Flush immediately (bypasses debounce)
      // This is synchronous in DuckDB-WASM's OPFS backend
      flushDuckDB(true, {
        onStart: () => {
          // Show saving indicator (though tab is closing)
          const { useUIStore } = require('@/stores/uiStore')
          useUIStore.getState().setPersistenceStatus('saving')
        },
        onComplete: () => {
          // Don't set 'saved' - tab is closing
        }
      })

      // Note: We don't prevent default or show confirmation dialog
      // Auto-save is transparent - user doesn't need to confirm
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
}
