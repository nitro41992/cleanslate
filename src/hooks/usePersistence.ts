/**
 * @deprecated Auto-persistence is now enabled for OPFS-capable browsers.
 * Manual save is no longer needed. This hook remains for backward compatibility.
 *
 * Migration: DuckDB now uses native OPFS storage with automatic persistence.
 * All data operations auto-save after 1 second of idle time.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  clearAllOPFS,
} from '@/lib/opfs/storage'
import { isDuckDBPersistent } from '@/lib/duckdb'
import { toast } from '@/hooks/use-toast'

export function usePersistence() {
  const [hasShownNotice, setHasShownNotice] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  // Show auto-save migration notice once
  useEffect(() => {
    if (!hasShownNotice && isDuckDBPersistent()) {
      toast({
        title: 'Auto-Save Enabled',
        description: 'Your data now saves automatically. No manual save needed!',
      })
      setHasShownNotice(true)
    }
  }, [hasShownNotice])

  // Deprecated: Manual save no longer needed (auto-save enabled)
  const saveToStorage = useCallback(async () => {
    // No-op - auto-save handles persistence
    return true
  }, [])

  // Deprecated: Manual load no longer needed (auto-restore on init)
  const loadFromStorage = useCallback(async () => {
    // No-op - data loads automatically from OPFS
    return true
  }, [])

  // Deprecated: Table removal handled by DuckDB
  const removeFromStorage = useCallback(async (_tableId: string) => {
    // No-op - DuckDB handles table lifecycle
    return true
  }, [])

  // Keep clearStorage() for manual data clearing
  // This is still useful for users who want to reset their workspace
  const clearStorage = useCallback(async () => {
    setIsLoading(true)
    try {
      // Clear legacy OPFS storage
      await clearAllOPFS()

      // For OPFS-backed DuckDB, need to delete the database file and reload
      if (isDuckDBPersistent()) {
        try {
          const opfsRoot = await navigator.storage.getDirectory()
          await opfsRoot.removeEntry('cleanslate.db')
        } catch (err) {
          console.warn('[Clear Storage] Could not delete cleanslate.db:', err)
        }
      }

      toast({
        title: 'Storage Cleared',
        description: 'All saved data has been removed. Reloading...',
      })

      // Reload page to reinitialize DuckDB
      setTimeout(() => {
        window.location.reload()
      }, 1000)

      return true
    } catch (error) {
      console.error('Failed to clear storage:', error)
      toast({
        title: 'Clear Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
      return false
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Deprecated: Auto-restore handled by initDuckDB()
  const autoRestore = useCallback(async () => {
    return false
  }, [])

  return {
    isAvailable: false, // Deprecated - OPFS handled by DuckDB now
    isLoading,
    hasRestoredData: false, // Deprecated
    saveToStorage, // No-op
    loadFromStorage, // No-op
    removeFromStorage, // No-op
    clearStorage, // Still functional - clears OPFS and reloads
    autoRestore, // No-op
  }
}
