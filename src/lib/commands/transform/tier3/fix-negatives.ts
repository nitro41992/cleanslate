/**
 * Fix Negatives Command
 *
 * Converts accounting-style negative numbers: (500.00) -> -500.00
 * Tier 3 - Requires snapshot for undo (parsing may lose data).
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { runBatchedColumnTransform, buildColumnOrderedSelect, getColumnOrderForTable } from '../../batch-utils'
import { tableHasCsId } from '@/lib/duckdb'

export interface FixNegativesParams extends BaseTransformParams {
  column: string
}

export class FixNegativesCommand extends Tier3TransformCommand<FixNegativesParams> {
  readonly type: CommandType = 'transform:fix_negatives'
  readonly label = 'Fix Negatives'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = this.params.column
    const quotedCol = quoteColumn(col)

    // Build the expression to convert (xxx) to -xxx
    const fixNegExpr = `
      CASE
        WHEN TRIM(CAST(${quotedCol} AS VARCHAR)) LIKE '%(%)'
        THEN TRY_CAST(
          '-' || REPLACE(REPLACE(REPLACE(REPLACE(TRIM(CAST(${quotedCol} AS VARCHAR)), '$', ''), '(', ''), ')', ''), ',', '')
          AS DOUBLE
        )
        ELSE TRY_CAST(REPLACE(CAST(${quotedCol} AS VARCHAR), ',', '') AS DOUBLE)
      END
    `

    if (ctx.batchMode) {
      return runBatchedColumnTransform(
        ctx, col, fixNegExpr,
        `${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS VARCHAR)) LIKE '%(%)'`
      )
    }

    // Non-batch mode: use column-ordered SELECT
    const tempTable = `${tableName}_temp_${Date.now()}`
    const columnOrder = getColumnOrderForTable(ctx)
    const hasCsId = await tableHasCsId(tableName)
    const selectQuery = buildColumnOrderedSelect(tableName, columnOrder, { [col]: fixNegExpr }, hasCsId)

    try {
      await ctx.db.execute(`CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS ${selectQuery}`)

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
    return `${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) LIKE '%(%)'`
  }
}
