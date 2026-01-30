/**
 * Command Context Builder
 *
 * Creates the CommandContext object needed to execute commands.
 * Provides database access and table metadata.
 */

import type { CommandContext, ColumnVersionInfo } from './types'
import type { ColumnInfo } from '@/types'
import {
  query,
  execute,
  getTableColumns,
  tableExists,
} from '@/lib/duckdb'
import { useTableStore } from '@/stores/tableStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { scanForBackupColumns } from './column-versions'
import { reorderColumns } from './utils/column-ordering'
import { registerMemoryCleanup } from '@/lib/memory-manager'

// Global column version store per table
// Key: tableId, Value: Map<columnName, ColumnVersionInfo>
const tableColumnVersions = new Map<string, Map<string, ColumnVersionInfo>>()

/**
 * Build a CommandContext for executing commands on a table
 */
export async function buildCommandContext(
  tableId: string
): Promise<CommandContext> {
  // Get table info from store
  const tableStore = useTableStore.getState()
  const table = tableStore.tables.find((t) => t.id === tableId)

  if (!table) {
    throw new Error(`Table not found: ${tableId}`)
  }

  // Get timeline info
  const timelineStore = useTimelineStore.getState()
  const timeline = timelineStore.getTimeline(tableId)

  // Get or initialize column version store for this table
  let columnVersions = tableColumnVersions.get(tableId)
  if (!columnVersions) {
    // Scan table for existing backup columns (recovery/migration)
    columnVersions = await scanForBackupColumns(
      { query },
      table.name
    )
    tableColumnVersions.set(tableId, columnVersions)
    if (columnVersions.size > 0) {
      console.log(`[Context] Scanned and found ${columnVersions.size} versioned column(s):`, Array.from(columnVersions.keys()))
    } else {
      console.log(`[Context] Scanned table, no existing __base columns found`)
    }
  }

  // Build context
  const ctx: CommandContext = {
    db: {
      query: async <T>(sql: string): Promise<T[]> => {
        return query<T>(sql)
      },
      execute: async (sql: string): Promise<void> => {
        return execute(sql)
      },
      getTableColumns: async (tableName: string): Promise<ColumnInfo[]> => {
        return getTableColumns(tableName)
      },
      tableExists: async (tableName: string): Promise<boolean> => {
        return tableExists(tableName)
      },
    },
    table: {
      id: table.id,
      name: table.name,
      columns: table.columns,
      rowCount: table.rowCount,
    },
    columnVersions,
    timelineId: timeline?.id,
  }

  return ctx
}

/**
 * Get the column version store for a table (for testing/debugging)
 */
export function getColumnVersionStore(
  tableId: string
): Map<string, ColumnVersionInfo> | undefined {
  return tableColumnVersions.get(tableId)
}

/**
 * Set the column version store for a table (for testing/migration)
 */
export function setColumnVersionStore(
  tableId: string,
  versions: Map<string, ColumnVersionInfo>
): void {
  tableColumnVersions.set(tableId, versions)
}

/**
 * Clear the column version store for a table (when table is deleted)
 */
export function clearColumnVersionStore(tableId: string): void {
  tableColumnVersions.delete(tableId)
}

/**
 * Refresh table metadata in context (after schema changes)
 *
 * @param ctx - Current command context
 * @param renameMappings - Optional rename mappings for column order preservation
 * @param columnOrderOverride - Optional pre-calculated column order to prevent race conditions
 */
export async function refreshTableContext(
  ctx: CommandContext,
  renameMappings?: Record<string, string>,
  columnOrderOverride?: string[]
): Promise<CommandContext> {
  const fetchedColumns = await ctx.db.getTableColumns(ctx.table.name)

  // Apply column reordering if override provided
  const columns = columnOrderOverride
    ? reorderColumns(fetchedColumns, columnOrderOverride, renameMappings)
    : fetchedColumns

  const rowCountResult = await ctx.db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${ctx.table.name}"`
  )
  const rowCount = Number(rowCountResult[0]?.count ?? 0)

  return {
    ...ctx,
    table: {
      ...ctx.table,
      columns,
      rowCount,
    },
  }
}

/**
 * Create a minimal context for testing
 */
export function createTestContext(
  tableName: string,
  columns: ColumnInfo[],
  rowCount: number,
  db: CommandContext['db']
): CommandContext {
  return {
    db,
    table: {
      id: 'test-table-id',
      name: tableName,
      columns,
      rowCount,
    },
    columnVersions: new Map(),
  }
}

/**
 * Clean up orphaned column version entries.
 * Called during memory pressure to remove entries for tables that no longer exist.
 */
export function cleanupOrphanedColumnVersions(): void {
  const tableStore = useTableStore.getState()
  const activeTableIds = new Set(tableStore.tables.map(t => t.id))

  let cleaned = 0
  for (const tableId of tableColumnVersions.keys()) {
    if (!activeTableIds.has(tableId)) {
      tableColumnVersions.delete(tableId)
      cleaned++
    }
  }

  if (cleaned > 0) {
    console.log(`[Context] Cleaned up ${cleaned} orphaned column version entries`)
  }
}

// Register cleanup callback for memory pressure situations
if (typeof window !== 'undefined') {
  registerMemoryCleanup('column-versions', cleanupOrphanedColumnVersions)
}
