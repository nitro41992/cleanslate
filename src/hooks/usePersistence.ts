import { useState, useCallback, useEffect } from 'react'
import {
  isOPFSAvailable,
  saveMetadata,
  loadMetadata,
  saveTableToOPFS,
  loadTableFromOPFS,
  removeTableFromOPFS,
  clearAllOPFS,
} from '@/lib/opfs/storage'
import { useTableStore } from '@/stores/tableStore'
import { useUIStore } from '@/stores/uiStore'
import { useAuditStore } from '@/stores/auditStore'
import { toast } from '@/hooks/use-toast'

export function usePersistence() {
  const [isAvailable, setIsAvailable] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [hasRestoredData, setHasRestoredData] = useState(false)

  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)
  const clearTables = useTableStore((s) => s.clearTables)
  const setPersistenceStatus = useUIStore((s) => s.setPersistenceStatus)
  const addAuditEntry = useAuditStore((s) => s.addEntry)

  // Check OPFS availability on mount
  useEffect(() => {
    isOPFSAvailable().then(setIsAvailable)
  }, [])

  // Save all tables to OPFS
  const saveToStorage = useCallback(async () => {
    if (!isAvailable) {
      toast({
        title: 'Storage Unavailable',
        description: 'Your browser does not support persistent storage',
        variant: 'destructive',
      })
      return false
    }

    if (tables.length === 0) {
      toast({
        title: 'Nothing to Save',
        description: 'Load some tables first before saving',
      })
      return false
    }

    setIsLoading(true)
    setPersistenceStatus('saving')

    try {
      // Save each table
      for (const table of tables) {
        await saveTableToOPFS(table.id, table.name)
      }

      // Save metadata
      await saveMetadata(
        tables.map((t) => ({
          id: t.id,
          name: t.name,
          columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
          rowCount: t.rowCount,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        }))
      )

      setPersistenceStatus('saved')
      toast({
        title: 'Data Saved',
        description: `Saved ${tables.length} table(s) to local storage`,
      })

      return true
    } catch (error) {
      console.error('Failed to save to OPFS:', error)
      setPersistenceStatus('error')
      toast({
        title: 'Save Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
      return false
    } finally {
      setIsLoading(false)
    }
  }, [isAvailable, tables, setPersistenceStatus])

  // Load all tables from OPFS
  const loadFromStorage = useCallback(async () => {
    if (!isAvailable) {
      toast({
        title: 'Storage Unavailable',
        description: 'Your browser does not support persistent storage',
        variant: 'destructive',
      })
      return false
    }

    setIsLoading(true)
    setPersistenceStatus('saving')

    try {
      const metadata = await loadMetadata()

      if (!metadata || metadata.tables.length === 0) {
        toast({
          title: 'No Saved Data',
          description: 'No previously saved tables found',
        })
        setPersistenceStatus('idle')
        return false
      }

      // Clear current tables
      clearTables()

      // Load each table
      let loadedCount = 0
      for (const tableMeta of metadata.tables) {
        const success = await loadTableFromOPFS(tableMeta.id, tableMeta.name)
        if (success) {
          addTable(
            tableMeta.name,
            tableMeta.columns.map((c) => ({ name: c.name, type: c.type, nullable: true })),
            tableMeta.rowCount,
            tableMeta.id
          )
          loadedCount++
        }
      }

      if (loadedCount > 0) {
        addAuditEntry(
          'system',
          'System',
          'Data Restored',
          `Loaded ${loadedCount} table(s) from local storage`
        )
      }

      setPersistenceStatus('saved')
      setHasRestoredData(true)
      toast({
        title: 'Data Restored',
        description: `Loaded ${loadedCount} table(s) from local storage`,
      })

      return true
    } catch (error) {
      console.error('Failed to load from OPFS:', error)
      setPersistenceStatus('error')
      toast({
        title: 'Restore Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
      return false
    } finally {
      setIsLoading(false)
    }
  }, [isAvailable, clearTables, addTable, addAuditEntry, setPersistenceStatus])

  // Remove a specific table from OPFS
  const removeFromStorage = useCallback(async (tableId: string) => {
    if (!isAvailable) return false

    try {
      await removeTableFromOPFS(tableId)
      return true
    } catch (error) {
      console.error('Failed to remove from OPFS:', error)
      return false
    }
  }, [isAvailable])

  // Clear all stored data
  const clearStorage = useCallback(async () => {
    if (!isAvailable) return false

    setIsLoading(true)
    try {
      await clearAllOPFS()
      setPersistenceStatus('idle')
      toast({
        title: 'Storage Cleared',
        description: 'All saved data has been removed',
      })
      return true
    } catch (error) {
      console.error('Failed to clear OPFS:', error)
      toast({
        title: 'Clear Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
      return false
    } finally {
      setIsLoading(false)
    }
  }, [isAvailable, setPersistenceStatus])

  // Auto-restore on initial load (optional)
  const autoRestore = useCallback(async () => {
    if (!isAvailable || hasRestoredData) return

    const metadata = await loadMetadata()
    if (metadata && metadata.tables.length > 0 && tables.length === 0) {
      // There's saved data and no current tables - offer to restore
      return true
    }
    return false
  }, [isAvailable, hasRestoredData, tables.length])

  return {
    isAvailable,
    isLoading,
    hasRestoredData,
    saveToStorage,
    loadFromStorage,
    removeFromStorage,
    clearStorage,
    autoRestore,
  }
}
