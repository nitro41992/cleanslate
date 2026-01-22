/**
 * DuckDB Memory Tracking Utilities
 *
 * Tracks actual DuckDB WASM memory usage by querying DuckDB's internal
 * memory functions (duckdb_memory(), duckdb_tables()) rather than relying
 * on performance.memory which only tracks the main thread's JS heap.
 */

import { query } from './index'

// Memory limit: 3GB (75% of 4GB WASM ceiling)
// Leaves 1GB headroom for temp query buffers, sorts, joins, GC pressure
export const MEMORY_LIMIT_BYTES = 3 * 1024 * 1024 * 1024

// Conservative estimate for average bytes per cell (VARCHAR, numbers, etc.)
export const AVG_BYTES_PER_CELL = 50

// Warning thresholds
export const WARNING_THRESHOLD = 0.6 // 60%
export const CRITICAL_THRESHOLD = 0.8 // 80%
export const BLOCK_THRESHOLD = 0.95 // 95%

export interface DuckDBMemoryInfo {
  totalBytes: number
  byTag: Record<string, { memoryBytes: number; tempStorageBytes: number }>
}

export interface TableSizeInfo {
  tableName: string
  estimatedRows: number
  columnCount: number
  estimatedBytes: number
}

export interface MemoryStatus {
  usedBytes: number
  limitBytes: number
  percentage: number
  level: 'normal' | 'warning' | 'critical'
  estimatedTableBytes: number
  duckdbReportedBytes: number
}

export interface MemoryCapacityCheck {
  canLoad: boolean
  currentUsageBytes: number
  projectedUsageBytes: number
  limitBytes: number
  warningMessage?: string
}

/**
 * Query DuckDB's internal memory usage by component tag
 */
export async function getDuckDBMemoryUsage(): Promise<DuckDBMemoryInfo> {
  try {
    const result = await query<{
      tag: string
      memory_usage_bytes: number
      temporary_storage_bytes: number
    }>('SELECT * FROM duckdb_memory()')

    const byTag: Record<string, { memoryBytes: number; tempStorageBytes: number }> = {}
    let totalBytes = 0

    for (const row of result) {
      byTag[row.tag] = {
        memoryBytes: Number(row.memory_usage_bytes),
        tempStorageBytes: Number(row.temporary_storage_bytes),
      }
      totalBytes += Number(row.memory_usage_bytes)
    }

    return { totalBytes, byTag }
  } catch (error) {
    console.warn('Failed to query duckdb_memory():', error)
    return { totalBytes: 0, byTag: {} }
  }
}

/**
 * Get estimated sizes for all user tables (excluding internal/system tables)
 */
export async function getEstimatedTableSizes(): Promise<TableSizeInfo[]> {
  try {
    const result = await query<{
      table_name: string
      estimated_size: number
      column_count: number
    }>(`
      SELECT table_name, estimated_size, column_count
      FROM duckdb_tables()
      WHERE NOT internal
        AND table_name NOT LIKE '_timeline_%'
        AND table_name NOT LIKE '_audit_%'
        AND table_name NOT LIKE '_diff_%'
        AND table_name NOT LIKE '_original_%'
    `)

    return result.map((row) => ({
      tableName: row.table_name,
      estimatedRows: Number(row.estimated_size),
      columnCount: Number(row.column_count),
      estimatedBytes:
        Number(row.estimated_size) * Number(row.column_count) * AVG_BYTES_PER_CELL,
    }))
  } catch (error) {
    console.warn('Failed to query duckdb_tables():', error)
    return []
  }
}

/**
 * Get total estimated table data size
 */
export async function getTotalEstimatedTableSize(): Promise<number> {
  const tableSizes = await getEstimatedTableSizes()
  return tableSizes.reduce((sum, t) => sum + t.estimatedBytes, 0)
}

/**
 * Get combined memory status for UI display
 * Uses the larger of: DuckDB reported memory OR estimated table sizes
 * This handles cases where DuckDB may use lazy loading
 */
export async function getMemoryStatus(): Promise<MemoryStatus> {
  const [memInfo, tableSizes] = await Promise.all([
    getDuckDBMemoryUsage(),
    getEstimatedTableSizes(),
  ])

  const estimatedTableBytes = tableSizes.reduce((sum, t) => sum + t.estimatedBytes, 0)
  const duckdbReportedBytes = memInfo.totalBytes

  // Use the larger value for conservative estimation
  const usedBytes = Math.max(duckdbReportedBytes, estimatedTableBytes)
  const percentage = MEMORY_LIMIT_BYTES > 0 ? (usedBytes / MEMORY_LIMIT_BYTES) * 100 : 0

  let level: 'normal' | 'warning' | 'critical' = 'normal'
  if (percentage >= CRITICAL_THRESHOLD * 100) {
    level = 'critical'
  } else if (percentage >= WARNING_THRESHOLD * 100) {
    level = 'warning'
  }

  return {
    usedBytes,
    limitBytes: MEMORY_LIMIT_BYTES,
    percentage,
    level,
    estimatedTableBytes,
    duckdbReportedBytes,
  }
}

/**
 * Check if there's enough capacity to load new data
 * @param estimatedNewBytes - Estimated size of new data to load
 */
export async function checkMemoryCapacity(
  estimatedNewBytes: number
): Promise<MemoryCapacityCheck> {
  const status = await getMemoryStatus()
  const projectedUsageBytes = status.usedBytes + estimatedNewBytes
  const projectedPercentage = (projectedUsageBytes / MEMORY_LIMIT_BYTES) * 100

  let canLoad = true
  let warningMessage: string | undefined

  if (projectedPercentage >= BLOCK_THRESHOLD * 100) {
    canLoad = false
    warningMessage = `Loading this file would exceed safe memory limits (${projectedPercentage.toFixed(0)}% of ${formatBytes(MEMORY_LIMIT_BYTES)}). Please delete some tables first.`
  } else if (projectedPercentage >= CRITICAL_THRESHOLD * 100) {
    canLoad = true // Allow but warn
    warningMessage = `Loading this file will push memory usage to ${projectedPercentage.toFixed(0)}%. Consider deleting unused tables.`
  } else if (projectedPercentage >= WARNING_THRESHOLD * 100) {
    canLoad = true
    warningMessage = `Memory usage will be at ${projectedPercentage.toFixed(0)}% after loading.`
  }

  return {
    canLoad,
    currentUsageBytes: status.usedBytes,
    projectedUsageBytes,
    limitBytes: MEMORY_LIMIT_BYTES,
    warningMessage,
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}
