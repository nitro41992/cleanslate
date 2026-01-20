import { useState, useEffect, useCallback } from 'react'
import {
  initDuckDB,
  loadCSV,
  loadJSON,
  loadParquet,
  loadXLSX,
  getTableData,
  exportToCSV,
  dropTable,
  query,
  execute,
  updateCell as updateCellDb,
} from '@/lib/duckdb'
import { useTableStore } from '@/stores/tableStore'
import { useAuditStore } from '@/stores/auditStore'
import { toast } from '@/hooks/use-toast'
import type { ColumnInfo, CSVIngestionSettings } from '@/types'

export function useDuckDB() {
  const [isReady, setIsReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const addTable = useTableStore((s) => s.addTable)
  const removeTable = useTableStore((s) => s.removeTable)
  const addAuditEntry = useAuditStore((s) => s.addEntry)

  useEffect(() => {
    initDuckDB()
      .then(() => {
        setIsReady(true)
        console.log('DuckDB ready')
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
      try {
        const tableName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
        let result: { columns: string[]; rowCount: number }

        const ext = file.name.split('.').pop()?.toLowerCase()

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

        const tableId = addTable(tableName, columns, result.rowCount)

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
      }
    },
    [addTable, addAuditEntry]
  )

  const getData = useCallback(
    async (tableName: string, offset = 0, limit = 1000) => {
      return getTableData(tableName, offset, limit)
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

  return {
    isReady,
    isLoading,
    loadFile,
    getData,
    runQuery,
    runExecute,
    exportTable,
    deleteTable,
    updateCell,
  }
}
