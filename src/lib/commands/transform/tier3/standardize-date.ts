/**
 * Standardize Date Command
 *
 * Parses dates in various formats and outputs in a standard format.
 * Tier 3 - Requires snapshot for undo (data format may not be recoverable).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import {
  buildDateFormatExpression,
  buildDateParseSuccessPredicate,
  type OutputFormat,
} from '../../utils/date'
import { runBatchedTransform } from '../../batch-utils'

export interface StandardizeDateParams extends BaseTransformParams {
  column: string
  /** Output format (default: 'YYYY-MM-DD') */
  format?: OutputFormat
}

export class StandardizeDateCommand extends Tier3TransformCommand<StandardizeDateParams> {
  readonly type: CommandType = 'transform:standardize_date'
  readonly label = 'Standardize Date'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    const validFormats: OutputFormat[] = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY']
    const format = this.params.format ?? 'YYYY-MM-DD'

    if (!validFormats.includes(format)) {
      return this.errorResult(
        'INVALID_FORMAT',
        `Invalid output format: ${format}. Valid formats: ${validFormats.join(', ')}`,
        'format'
      )
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column
    const format = this.params.format ?? 'YYYY-MM-DD'
    const dateExpr = buildDateFormatExpression(col, format)

    // Check if batching is needed (3 lines!)
    if (ctx.batchMode) {
      return runBatchedTransform(ctx, `
        SELECT * EXCLUDE ("${col}"), ${dateExpr} as "${col}"
        FROM "${ctx.table.name}"
      `)
    }

    // Original logic for <500k rows
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {
      // Build the date standardization expression (already done above)

      // Create temp table with standardized date
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT * EXCLUDE (${quoteColumn(col)}),
               ${dateExpr} as ${quoteColumn(col)}
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
    // Rows where date parsing succeeds
    return buildDateParseSuccessPredicate(this.params.column)
  }
}
