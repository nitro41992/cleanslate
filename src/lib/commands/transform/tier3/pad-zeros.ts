/**
 * Pad Zeros Command
 *
 * Pads a column value with leading zeros to a specified length.
 * Example: 123 -> 00123 (with length=5)
 * Tier 3 - Requires snapshot for undo (data format may not be recoverable).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'

export interface PadZerosParams extends BaseTransformParams {
  column: string
  /** Target length (default: 5) */
  length?: number
}

export class PadZerosCommand extends Tier3TransformCommand<PadZerosParams> {
  readonly type: CommandType = 'transform:pad_zeros'
  readonly label = 'Pad Zeros'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    const length = this.params.length ?? 5

    if (length < 1 || length > 100) {
      return this.errorResult(
        'INVALID_LENGTH',
        'Length must be between 1 and 100',
        'length'
      )
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`
    const col = quoteColumn(this.params.column)
    const length = this.params.length ?? 5

    try {
      // Build the LPAD expression
      // Cast to VARCHAR first to handle numeric values
      const padExpr = `LPAD(CAST(${col} AS VARCHAR), ${length}, '0')`

      // Create temp table with padded values
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT * EXCLUDE (${col}),
               ${padExpr} as ${col}
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
    const length = this.params.length ?? 5
    // Rows where value is shorter than target length
    return `${col} IS NOT NULL AND LENGTH(CAST(${col} AS VARCHAR)) < ${length}`
  }
}
