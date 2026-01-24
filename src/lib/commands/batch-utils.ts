/**
 * Shared batching helper for transform commands
 * Reduces command updates to just 3 lines of code
 */

import type { CommandContext, ExecutionResult } from './types'
import { batchExecute, swapStagingTable, cleanupStagingTable } from './batch-executor'
import { getConnection } from '@/lib/duckdb'

/**
 * Run a batched transformation using staging table strategy
 *
 * This helper encapsulates the entire batching workflow:
 * 1. Create staging table with batched inserts
 * 2. Checkpoint WAL every 5 batches to prevent memory accumulation
 * 3. Atomically swap staging → live table on success
 * 4. Cleanup staging table on error
 *
 * @param ctx - Command context with batch settings
 * @param selectQuery - SQL SELECT query to execute in batches (should read from ctx.table.name)
 * @param sampleQuery - Optional SQL query to capture before/after samples for audit (limit 1000 applied automatically)
 * @returns Execution result with affected row count and optional sample changes
 *
 * @example
 * // In UppercaseCommand.execute():
 * if (ctx.batchMode) {
 *   return runBatchedTransform(
 *     ctx,
 *     `SELECT * EXCLUDE ("name"), UPPER("name") as "name" FROM "${ctx.table.name}"`,
 *     `SELECT "name" as before, UPPER("name") as after FROM "${ctx.table.name}" WHERE "name" IS DISTINCT FROM UPPER("name")`
 *   )
 * }
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
