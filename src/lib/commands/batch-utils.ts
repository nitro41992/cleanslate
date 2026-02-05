/**
 * Shared batching helper for transform commands
 * Reduces command updates to just 3 lines of code
 */

import type { CommandContext, ExecutionResult } from './types'
import { batchExecute, swapStagingTable, cleanupStagingTable } from './batch-executor'
import { getConnection, tableHasCsId, tableHasOriginId, CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN } from '@/lib/duckdb'
import { useTableStore } from '@/stores/tableStore'
import { isInternalColumn } from './utils/column-ordering'

/**
 * Get the column order for a table from the store.
 * Falls back to column names from context if not set.
 * Exported for use by Tier 3 commands that need column ordering for non-batch SQL.
 */
export function getColumnOrderForTable(ctx: CommandContext): string[] {
  const tableStore = useTableStore.getState()
  const table = tableStore.tables.find(t => t.id === ctx.table.id)

  // Use stored column order if available
  if (table?.columnOrder && table.columnOrder.length > 0) {
    return table.columnOrder
  }

  // Fallback to current columns from context (excluding internal columns)
  return ctx.table.columns
    .map(c => c.name)
    .filter(name => !isInternalColumn(name))
}

/**
 * Build a SELECT query that preserves column order.
 *
 * CRITICAL: Using SELECT * EXCLUDE (...) loses column ordering in DuckDB.
 * This function explicitly lists all columns in the user-defined order,
 * applying transformations to specific columns in-place.
 *
 * Internal columns (_cs_id, _cs_origin_id) are included at the end to preserve row identity.
 *
 * Exported for use by Tier 3 commands that need column ordering for non-batch SQL.
 *
 * @param tableName - Source table name
 * @param columnOrder - User-defined column order (from getColumnOrderForTable)
 * @param columnTransforms - Map of column name -> SQL expression for transformation
 * @param includeCsId - Whether to include _cs_id column (should be true if source table has it)
 * @param includeCsOriginId - Whether to include _cs_origin_id column (should be true if source table has it)
 * @returns SQL SELECT query with columns in correct order
 */
export function buildColumnOrderedSelect(
  tableName: string,
  columnOrder: string[],
  columnTransforms: Record<string, string>,
  includeCsId = false,
  includeCsOriginId = false
): string {
  // Build select parts for user-visible columns in order
  const selectParts = columnOrder
    .filter(col => !isInternalColumn(col))
    .map(col => {
      const transform = columnTransforms[col]
      if (transform) {
        return `${transform} as "${col}"`
      }
      return `"${col}"`
    })

  // Include internal identity columns at the end if they exist in the source table
  if (includeCsId) {
    selectParts.push(`"${CS_ID_COLUMN}"`)
  }
  if (includeCsOriginId) {
    selectParts.push(`"${CS_ORIGIN_ID_COLUMN}"`)
  }

  return `SELECT ${selectParts.join(', ')} FROM "${tableName}"`
}

/**
 * Run a batched single-column transformation with automatic column order preservation.
 *
 * This is the preferred API for commands - just pass the column and transformation expression.
 * Column ordering is handled automatically.
 *
 * @param ctx - Command context with batch settings
 * @param column - Column name to transform
 * @param transformExpr - SQL expression for the transformation (should reference the column with quotes)
 * @param samplePredicate - Optional WHERE predicate for sample query (e.g., '"col" IS DISTINCT FROM UPPER("col")')
 * @returns Execution result with affected row count and optional sample changes
 *
 * @example
 * // In UppercaseCommand.execute():
 * if (ctx.batchMode) {
 *   return runBatchedColumnTransform(ctx, col, `UPPER("${col}")`)
 * }
 */
export async function runBatchedColumnTransform(
  ctx: CommandContext,
  column: string,
  transformExpr: string,
  samplePredicate?: string
): Promise<ExecutionResult> {
  const columnOrder = getColumnOrderForTable(ctx)

  // Check if source table has internal identity columns
  const hasCsId = await tableHasCsId(ctx.table.name)
  const hasOriginId = await tableHasOriginId(ctx.table.name)

  const selectQuery = buildColumnOrderedSelect(
    ctx.table.name,
    columnOrder,
    { [column]: transformExpr },
    hasCsId,
    hasOriginId
  )

  // Build sample query if predicate provided
  const sampleQuery = samplePredicate
    ? `SELECT "${column}" as before, ${transformExpr} as after
       FROM "${ctx.table.name}"
       WHERE ${samplePredicate}`
    : undefined

  return runBatchedTransform(ctx, selectQuery, sampleQuery)
}

/**
 * Run a batched transformation using staging table strategy (raw SQL version).
 *
 * NOTE: For single-column transforms, prefer runBatchedColumnTransform() which
 * automatically handles column ordering. Use this only for complex multi-column
 * transforms or when you need full control over the SELECT query.
 *
 * @param ctx - Command context with batch settings
 * @param selectQuery - SQL SELECT query to execute in batches
 * @param sampleQuery - Optional SQL query to capture before/after samples for audit
 * @returns Execution result with affected row count and optional sample changes
 */
export async function runBatchedTransform(
  ctx: CommandContext,
  selectQuery: string,
  sampleQuery?: string
): Promise<ExecutionResult> {
  const conn = await getConnection()
  const stagingTable = `_staging_${ctx.table.name}`

  // Capture samples BEFORE transformation (limit 1000 rows)
  let sampleChanges: { before: string; after: string }[] = []

  if (sampleQuery) {
    try {
      // Only add LIMIT if not already present (some callers include it already)
      const hasLimit = /LIMIT\s+\d+/i.test(sampleQuery)
      const query = hasLimit ? sampleQuery : `${sampleQuery} LIMIT 1000`
      const sampleResult = await conn.query(query)
      sampleChanges = sampleResult.toArray().map(row => {
        const json = row.toJSON()
        return {
          before: String(json.before ?? ''),
          after: String(json.after ?? '')
        }
      })
      console.log(`[BatchExecutor] Captured ${sampleChanges.length} sample rows`)
    } catch (err) {
      console.warn('[BatchExecutor] Sample query failed:', err)
      // Continue without samples - don't block the transformation
    }
  }

  try {
    // Batch execute the transformation
    const result = await batchExecute(conn, {
      sourceTable: ctx.table.name,
      stagingTable,
      selectQuery,
      batchSize: ctx.batchSize,
      onProgress: ctx.onBatchProgress
    })

    // Atomically swap staging → live
    await swapStagingTable(conn, ctx.table.name, result.stagingTable)

    // Return success
    const columns = await ctx.db.getTableColumns(ctx.table.name)
    return {
      success: true,
      rowCount: result.rowsProcessed,
      columns,
      affected: result.rowsProcessed,
      newColumnNames: [],
      droppedColumnNames: [],
      sampleChanges: sampleChanges.length > 0 ? sampleChanges : undefined
    }
  } catch (error) {
    // Cleanup on failure
    await cleanupStagingTable(conn, stagingTable)
    throw error
  }
}
