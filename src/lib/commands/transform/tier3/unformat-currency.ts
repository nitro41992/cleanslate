/**
 * Unformat Currency Command
 *
 * Removes currency symbols and formatting to convert to numeric.
 * Converts "$1,234.56" to 1234.56
 * Tier 3 - Requires snapshot for undo (type conversion may lose data).
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { runBatchedColumnTransform, buildColumnOrderedSelect, getColumnOrderForTable } from '../../batch-utils'
import { tableHasCsId } from '@/lib/duckdb'

export interface UnformatCurrencyParams extends BaseTransformParams {
  column: string
}

export class UnformatCurrencyCommand extends Tier3TransformCommand<UnformatCurrencyParams> {
  readonly type: CommandType = 'transform:unformat_currency'
  readonly label = 'Unformat Currency'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = this.params.column
    const quotedCol = quoteColumn(col)

    // Build the unformat expression
    const unformatExpr = `
      TRY_CAST(
        CASE
          WHEN CAST(${quotedCol} AS VARCHAR) LIKE '(%)'
          THEN '-' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            CAST(${quotedCol} AS VARCHAR), '(', ''), ')', ''), '$', ''), ',', ''), ' ', ''), '€', '')
          ELSE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            CAST(${quotedCol} AS VARCHAR), '$', ''), ',', ''), ' ', ''), '€', ''), '£', ''), '¥', ''), '+', '')
        END
        AS DOUBLE
      )
    `

    const samplePredicate = `${quotedCol} IS NOT NULL AND (
      CAST(${quotedCol} AS VARCHAR) LIKE '%$%' OR
      CAST(${quotedCol} AS VARCHAR) LIKE '%,%' OR
      CAST(${quotedCol} AS VARCHAR) LIKE '%€%' OR
      CAST(${quotedCol} AS VARCHAR) LIKE '%£%' OR
      CAST(${quotedCol} AS VARCHAR) LIKE '%¥%' OR
      CAST(${quotedCol} AS VARCHAR) LIKE '(%)'
    )`

    if (ctx.batchMode) {
      return runBatchedColumnTransform(ctx, col, unformatExpr, samplePredicate)
    }

    // Non-batch mode: use column-ordered SELECT
    const tempTable = `${tableName}_temp_${Date.now()}`
    const columnOrder = getColumnOrderForTable(ctx)
    const hasCsId = await tableHasCsId(tableName)
    const selectQuery = buildColumnOrderedSelect(tableName, columnOrder, { [col]: unformatExpr }, hasCsId)

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
    return `${col} IS NOT NULL AND (
      CAST(${col} AS VARCHAR) LIKE '%$%' OR
      CAST(${col} AS VARCHAR) LIKE '%,%' OR
      CAST(${col} AS VARCHAR) LIKE '%€%' OR
      CAST(${col} AS VARCHAR) LIKE '%£%' OR
      CAST(${col} AS VARCHAR) LIKE '%¥%' OR
      CAST(${col} AS VARCHAR) LIKE '(%)'
    )`
  }
}
