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

export interface UnformatCurrencyParams extends BaseTransformParams {
  column: string
}

export class UnformatCurrencyCommand extends Tier3TransformCommand<UnformatCurrencyParams> {
  readonly type: CommandType = 'transform:unformat_currency'
  readonly label = 'Unformat Currency'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`
    const col = quoteColumn(this.params.column)

    try {
      // Build the unformat expression:
      // 1. Cast to string
      // 2. Remove $, €, £, ¥ symbols
      // 3. Remove commas and spaces
      // 4. Handle parentheses for negative (accounting format)
      // 5. Cast to DOUBLE
      const unformatExpr = `
        TRY_CAST(
          CASE
            WHEN CAST(${col} AS VARCHAR) LIKE '(%)'
            THEN '-' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
              CAST(${col} AS VARCHAR), '(', ''), ')', ''), '$', ''), ',', ''), ' ', ''), '€', '')
            ELSE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
              CAST(${col} AS VARCHAR), '$', ''), ',', ''), ' ', ''), '€', ''), '£', ''), '¥', ''), '+', '')
          END
          AS DOUBLE
        )
      `

      // Create temp table with unformatted currency
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT * EXCLUDE (${col}),
               ${unformatExpr} as ${col}
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
    // Rows that have currency-like content
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
