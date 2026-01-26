/**
 * Standardize Date Command
 *
 * Parses dates in various formats and outputs in a standard format.
 * Tier 3 - Requires snapshot for undo (data format may not be recoverable).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteTable } from '../../utils/sql'
import {
  buildDateFormatExpression,
  buildDateParseSuccessPredicate,
  type OutputFormat,
} from '../../utils/date'
import { runBatchedColumnTransform, buildColumnOrderedSelect, getColumnOrderForTable } from '../../batch-utils'
import { tableHasCsId } from '@/lib/duckdb'

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
    const tableName = ctx.table.name
    const format = this.params.format ?? 'YYYY-MM-DD'
    const dateExpr = buildDateFormatExpression(col, format)

    if (ctx.batchMode) {
      return runBatchedColumnTransform(ctx, col, dateExpr)
    }

    // Non-batch mode: use column-ordered SELECT
    const tempTable = `${tableName}_temp_${Date.now()}`
    const columnOrder = getColumnOrderForTable(ctx)
    const hasCsId = await tableHasCsId(tableName)
    const selectQuery = buildColumnOrderedSelect(tableName, columnOrder, { [col]: dateExpr }, hasCsId)

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
    return buildDateParseSuccessPredicate(this.params.column)
  }
}
