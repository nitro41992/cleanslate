import { useState, useEffect, useCallback } from 'react'
import {
  initDuckDB,
  loadCSV,
  loadJSON,
  loadParquet,
  loadXLSX,
  getTableData,
  getTableDataWithRowIds,
  exportToCSV,
  dropTable,
  query,
  execute,
  updateCell as updateCellDb,
  duplicateTable as duplicateTableDb,
  isDuckDBPersistent,
  isDuckDBReadOnly,
} from '@/lib/duckdb'
import { checkMemoryCapacity } from '@/lib/duckdb/memory'
import { useTableStore } from '@/stores/tableStore'
import { useAuditStore } from '@/stores/auditStore'
import { useUIStore } from '@/stores/uiStore'
import { toast } from '@/hooks/use-toast'
import { generateId } from '@/lib/utils'
import type { ColumnInfo, CSVIngestionSettings } from '@/types'

export function useDuckDB() {
  const [isReady, setIsReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const addTable = useTableStore((s) => s.addTable)
  const removeTable = useTableStore((s) => s.removeTable)
  const addAuditEntry = useAuditStore((s) => s.addEntry)
  const refreshMemory = useUIStore((s) => s.refreshMemory)
  const setLoadingMessage = useUIStore((s) => s.setLoadingMessage)

  useEffect(() => {
    initDuckDB()
      .then(async () => {
        setIsReady(true)

        // Cleanup any corrupt snapshot files from failed exports
        try {
          const { cleanupCorruptSnapshots } = await import('@/lib/opfs/snapshot-storage')
          await cleanupCorruptSnapshots()
        } catch (e) {
          console.warn('[DuckDB] Failed to run snapshot cleanup:', e)
        }

        // Show persistence status
        const isPersistent = isDuckDBPersistent()
        const isReadOnly = isDuckDBReadOnly()

        // Restore timelines and UI preferences from app-state.json
        // This runs regardless of DuckDB persistence mode since app-state.json uses OPFS directly
        try {
          const { restoreAppState } = await import('@/lib/persistence/state-persistence')
          const savedState = await restoreAppState()

          if (savedState) {
            // Restore timelines (for undo/redo history)
            const { useTimelineStore } = await import('@/stores/timelineStore')
            useTimelineStore.getState().loadTimelines(savedState.timelines)

            // Restore UI preferences
            useUIStore.getState().setSidebarCollapsed(savedState.uiPreferences.sidebarCollapsed)

            // Expose saved table metadata for usePersistence to use
            // This ensures tableIds remain consistent across refreshes
            const tableIdMap: Record<string, string> = {}
            for (const table of savedState.tables) {
              tableIdMap[table.name] = table.id
            }
            ;(window as Window & { __CLEANSLATE_SAVED_TABLE_IDS__?: Record<string, string> }).__CLEANSLATE_SAVED_TABLE_IDS__ = tableIdMap

            console.log('[Persistence] Timelines and UI restored from app-state.json', {
              tableIdMap,
            })
          }
        } catch (error) {
          console.warn('[Persistence] Failed to restore timelines:', error)
        }

        if (isPersistent && !isReadOnly) {
          console.log('[DuckDB] Ready with persistent storage (auto-save enabled)')
        } else if (isPersistent && isReadOnly) {
          console.log('[DuckDB] Ready with persistent storage (read-only mode)')
          // Read-only toast already shown in initDuckDB()
        } else {
          console.log('[DuckDB] Ready (in-memory - data will not persist)')
          toast({
            title: 'In-Memory Mode',
            description: 'Your browser does not support persistent storage. Data will be lost on refresh.',
            variant: 'default',
          })
        }
      })
      .catch((err) => {
        console.error('Failed to initialize DuckDB:', err)
        toast({
          title: 'Database Error',
          description: 'Failed to initialize the data engine',
          variant: 'destructive',
        })
      })
  }, [])

  const loadFile = useCallback(
    async (file: File, csvSettings?: CSVIngestionSettings) => {
      setIsLoading(true)
      setLoadingMessage('Reading file...')
      try {
        // Pre-load capacity check: estimate file size impact (files expand ~2x in memory)
        const estimatedImpact = file.size * 2
        const memCheck = await checkMemoryCapacity(estimatedImpact)

        if (!memCheck.canLoad) {
          // Block loading - would exceed safe limits
          toast({
            title: 'Insufficient Memory',
            description: memCheck.warningMessage || 'Loading this file would exceed available memory',
            variant: 'destructive',
          })
          throw new Error('Insufficient memory to load file safely')
        } else if (memCheck.warningMessage) {
          // Allow but warn
          toast({
            title: 'Memory Warning',
            description: memCheck.warningMessage,
          })
        }

        const tableName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
        let result: { columns: string[]; rowCount: number }

        const ext = file.name.split('.').pop()?.toLowerCase()

        setLoadingMessage('Creating table...')
        if (ext === 'csv') {
          result = await loadCSV(tableName, file, csvSettings)
        } else if (ext === 'json') {
          result = await loadJSON(tableName, file)
        } else if (ext === 'parquet') {
          result = await loadParquet(tableName, file)
        } else if (ext === 'xlsx' || ext === 'xls') {
          result = await loadXLSX(tableName, file)
        } else {
          throw new Error(`Unsupported file type: ${ext}`)
        }

        const columns: ColumnInfo[] = result.columns.map((name) => ({
          name,
          type: 'VARCHAR',
          nullable: true,
        }))

        // Generate tableId BEFORE adding to store so we can create timeline/snapshot first
        const tableId = generateId()

        // Create timeline with original snapshot BEFORE grid rendering
        // This ensures first edit is instant (snapshot already exists)
        // Progress indicator shown via setLoadingMessage
        setLoadingMessage('Creating snapshot...')
        try {
          const { initializeTimeline } = await import('@/lib/timeline-engine')
          await initializeTimeline(tableId, tableName)
          console.log('[Import] Timeline initialized with snapshot')
        } catch (error) {
          console.warn('[Import] Failed to create timeline/snapshot:', error)
          // Non-fatal - timeline will be created on first edit (old behavior)
        }

        // NOW add to store - this triggers grid rendering
        setLoadingMessage('Rendering grid...')
        addTable(tableName, columns, result.rowCount, tableId)

        // Build details string with settings info for CSV
        let details = `Loaded ${file.name} (${result.rowCount} rows, ${result.columns.length} columns)`
        if (ext === 'csv' && csvSettings) {
          const settingsParts: string[] = []
          if (csvSettings.headerRow && csvSettings.headerRow > 1) {
            settingsParts.push(`header row: ${csvSettings.headerRow}`)
          }
          if (csvSettings.delimiter && csvSettings.delimiter !== ',') {
            const delimNames: Record<string, string> = {
              '\t': 'tab',
              '|': 'pipe',
              ';': 'semicolon',
            }
            settingsParts.push(`delimiter: ${delimNames[csvSettings.delimiter] || csvSettings.delimiter}`)
          }
          if (csvSettings.encoding && csvSettings.encoding !== 'utf-8') {
            settingsParts.push(`encoding: ${csvSettings.encoding}`)
          }
          if (settingsParts.length > 0) {
            details += ` [${settingsParts.join(', ')}]`
          }
        }

        addAuditEntry(
          tableId,
          tableName,
          'File Loaded',
          details
        )

        toast({
          title: 'File Loaded',
          description: `${tableName}: ${result.rowCount.toLocaleString()} rows`,
        })

        // Refresh memory indicator after file load
        refreshMemory()

        return { tableId, tableName, ...result }
      } catch (error) {
        console.error('Error loading file:', error)
        toast({
          title: 'Load Error',
          description: error instanceof Error ? error.message : 'Failed to load file',
          variant: 'destructive',
        })
        throw error
      } finally {
        setIsLoading(false)
        setLoadingMessage(null)
      }
    },
    [addTable, addAuditEntry, refreshMemory, setLoadingMessage]
  )

  const getData = useCallback(
    async (tableName: string, offset = 0, limit = 1000) => {
      return getTableData(tableName, offset, limit)
    },
    []
  )

  const getDataWithRowIds = useCallback(
    async (tableName: string, offset = 0, limit = 1000) => {
      return getTableDataWithRowIds(tableName, offset, limit)
    },
    []
  )

  const runQuery = useCallback(async (sql: string) => {
    return query(sql)
  }, [])

  const runExecute = useCallback(async (sql: string) => {
    return execute(sql)
  }, [])

  const exportTable = useCallback(async (tableName: string, filename: string) => {
    const blob = await exportToCSV(tableName)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || `${tableName}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    toast({
      title: 'Export Complete',
      description: `Saved ${filename || tableName + '.csv'}`,
    })
  }, [])

  const deleteTable = useCallback(
    async (tableId: string, tableName: string) => {
      await dropTable(tableName)
      removeTable(tableId)
      addAuditEntry(tableId, tableName, 'Table Deleted', `Removed table ${tableName}`)
    },
    [removeTable, addAuditEntry]
  )

  const updateCell = useCallback(
    async (tableName: string, rowIndex: number, columnName: string, newValue: unknown) => {
      await updateCellDb(tableName, rowIndex, columnName, newValue)
    },
    []
  )

  const duplicateTable = useCallback(
    async (sourceName: string, targetName: string) => {
      const result = await duplicateTableDb(sourceName, targetName)
      return result
    },
    []
  )

  return {
    isReady,
    isLoading,
    loadFile,
    getData,
    getDataWithRowIds,
    runQuery,
    runExecute,
    exportTable,
    deleteTable,
    updateCell,
    duplicateTable,
  }
}
