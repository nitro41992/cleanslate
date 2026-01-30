/**
 * Calculate Age Command
 *
 * Calculates age in years from a date of birth column.
 * Tier 3 - Requires snapshot for undo (adds a new column).
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { buildAgeExpression, buildDateParseSuccessPredicate, type AgePrecision } from '../../utils/date'
import { runBatchedTransform } from '../../batch-utils'

export interface CalculateAgeParams extends BaseTransformParams {
  column: string
  /** Name for the new age column (default: 'age') */
  newColumnName?: string
  /** Precision for age calculation: 'years' (default) or 'decimal' */
  precision?: AgePrecision
}

export class CalculateAgeCommand extends Tier3TransformCommand<CalculateAgeParams> {
  readonly type: CommandType = 'transform:calculate_age'
  readonly label = 'Calculate Age'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = this.params.column
    const newColName = this.params.newColumnName ?? 'age'
    const precision = this.params.precision ?? 'years'

    // Build the age calculation expression
    const ageExpr = buildAgeExpression(col, precision)

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedTransform(
        ctx,
        // Transform query (adds new column)
        `SELECT *, ${ageExpr} as ${quoteColumn(newColName)}
         FROM "${tableName}"`,
        // Sample query (captures DOB as before, age as after for first 1000 rows)
        `SELECT ${quoteColumn(col)} as before, ${ageExpr} as after
         FROM "${tableName}"
         WHERE ${ageExpr} IS NOT NULL
         LIMIT 1000`
      )
    }

    // Original logic for <500k rows
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {

      // Create temp table with age column
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT *,
               ${ageExpr} as ${quoteColumn(newColName)}
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
        newColumnNames: [newColName],
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
    // Rows where date parsing succeeds
    return buildDateParseSuccessPredicate(this.params.column)
  }
}
