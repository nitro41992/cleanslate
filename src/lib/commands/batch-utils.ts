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
 * @returns Execution result with affected row count
 *
 * @example
 * // In UppercaseCommand.execute():
 * if (ctx.batchMode) {
 *   return runBatchedTransform(ctx, `
 *     SELECT * EXCLUDE ("name"), UPPER("name") as "name"
 *     FROM "${ctx.table.name}"
 *   `)
 * }
 */
export async function runBatchedTransform(
  ctx: CommandContext,
  selectQuery: string
): Promise<ExecutionResult> {
  const conn = await getConnection()
  const stagingTable = `_staging_${ctx.table.name}`

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
      droppedColumnNames: []
    }
  } catch (error) {
    // Cleanup on failure
    await cleanupStagingTable(conn, stagingTable)
    throw error
  }
}
