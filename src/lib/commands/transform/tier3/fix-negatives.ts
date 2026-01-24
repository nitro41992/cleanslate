/**
 * Fix Negatives Command
 *
 * Converts accounting-style negative numbers: (500.00) -> -500.00
 * Tier 3 - Requires snapshot for undo (parsing may lose data).
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { runBatchedTransform } from '../../batch-utils'

export interface FixNegativesParams extends BaseTransformParams {
  column: string
}

export class FixNegativesCommand extends Tier3TransformCommand<FixNegativesParams> {
  readonly type: CommandType = 'transform:fix_negatives'
  readonly label = 'Fix Negatives'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = quoteColumn(this.params.column)

    // Build the expression to convert (xxx) to -xxx
    const fixNegExpr = `
      CASE
        WHEN TRIM(CAST(${col} AS VARCHAR)) LIKE '%(%)'
        THEN TRY_CAST(
          '-' || REPLACE(REPLACE(REPLACE(REPLACE(TRIM(CAST(${col} AS VARCHAR)), '$', ''), '(', ''), ')', ''), ',', '')
          AS DOUBLE
        )
        ELSE TRY_CAST(REPLACE(CAST(${col} AS VARCHAR), ',', '') AS DOUBLE)
      END
    `

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE (${col}), ${fixNegExpr} as ${col}
         FROM "${tableName}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT ${col} as before, ${fixNegExpr} as after
         FROM "${tableName}"
         WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) LIKE '%(%)'`
      )
    }

    // Original logic for <500k rows
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {

      // Create temp table with fixed negatives
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT * EXCLUDE (${col}),
               ${fixNegExpr} as ${col}
        FROM ${quoteTable(tableName)}
      `
      await ctx.db.execute(sql)

      // Swap tables
      await ctx.db.execute(`DROP TABLE ${quoteTable(tableName)}`)
      await ctx.db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

      // Get updated info
      const columns = await ctx.db.getTableColumns(tableName)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: rowCount,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    } catch (error) {
      // Cleanup
      try {
        await ctx.db.execute(`DROP TABLE IF EXISTS ${quoteTable(tempTable)}`)
      } catch {
        // Ignore
      }

      return {
        success: false,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected: 0,
        newColumnNames: [],
        droppedColumnNames: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = quoteColumn(this.params.column)
    // Rows that have accounting-style negatives: (500) or $(750.00)
    return `${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) LIKE '%(%)'`
  }
}
