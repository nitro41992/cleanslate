/**
 * useBeforeUnload Hook
 * Shows browser warning dialog if there are unsaved changes
 * Also flushes DuckDB on tab close
 */

import { useEffect } from 'react'
import { flushDuckDB } from '@/lib/duckdb'
import { useUIStore } from '@/stores/uiStore'

/**
 * Hook to show warning dialog when user tries to close tab with unsaved changes
 * Also flushes DuckDB to ensure any pending writes complete
 */
export function useBeforeUnload() {
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Get current persistence status and dirty tables
      const { persistenceStatus, dirtyTableIds } = useUIStore.getState()

      // Show browser warning dialog if there are unsaved changes
      // Check both the status AND the dirty set (belt and suspenders)
      const hasUnsavedChanges = persistenceStatus === 'dirty' ||
                                persistenceStatus === 'saving' ||
                                dirtyTableIds.size > 0

      if (hasUnsavedChanges) {
        // Standard way to trigger browser's "Leave site?" dialog
        event.preventDefault()
        // For older browsers, returnValue must be set
        event.returnValue = ''
      }

      // Flush DuckDB immediately (bypasses debounce) as best-effort save
      flushDuckDB(true)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
}
