/**
 * Combine Columns Command
 *
 * Concatenates multiple columns into a single column using CONCAT_WS.
 * Tier 3 - Requires snapshot for undo (modifies table structure).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable, escapeSqlString } from '../../utils/sql'

export interface CombineColumnsParams extends BaseTransformParams {
  /** Comma-separated column names to combine */
  columns: string
  /** Delimiter between values (default: ' ') */
  delimiter?: string
  /** Name for the new combined column (default: 'combined') */
  newColumnName?: string
  /** Ignore empty/null values (default: true) */
  ignoreEmpty?: boolean
}

export class CombineColumnsCommand extends Tier3TransformCommand<CombineColumnsParams> {
  readonly type: CommandType = 'transform:combine_columns'
  readonly label = 'Combine Columns'

  private getColumnNames(): string[] {
    return this.params.columns
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
  }

  protected async validateParams(ctx: CommandContext): Promise<ValidationResult> {
    const columnNames = this.getColumnNames()

    if (columnNames.length < 2) {
      return this.errorResult(
        'MIN_COLUMNS',
        'At least 2 columns are required to combine',
        'columns'
      )
    }

    // Check all columns exist
    const existingCols = ctx.table.columns.map((c) => c.name)
    for (const col of columnNames) {
      if (!existingCols.includes(col)) {
        return this.errorResult(
          'COLUMN_NOT_FOUND',
          `Column "${col}" not found in table`,
          'columns'
        )
      }
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`
    const columnNames = this.getColumnNames()
    const delimiter = this.params.delimiter ?? ' '
    const newColName = this.params.newColumnName ?? 'combined'
    const ignoreEmpty = this.params.ignoreEmpty ?? true

    try {
      // Build the combine expression
      const escapedDelim = escapeSqlString(delimiter)

      let combineExpr: string
      if (ignoreEmpty) {
        // Use CONCAT_WS with NULLIF to skip empty strings
        const colExprs = columnNames.map(
          (col) => `NULLIF(TRIM(CAST(${quoteColumn(col)} AS VARCHAR)), '')`
        )
        combineExpr = `CONCAT_WS('${escapedDelim}', ${colExprs.join(', ')})`
      } else {
        // Simple CONCAT_WS
        const colExprs = columnNames.map(
          (col) => `CAST(${quoteColumn(col)} AS VARCHAR)`
        )
        combineExpr = `CONCAT_WS('${escapedDelim}', ${colExprs.join(', ')})`
      }

      // Create temp table with combined column
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT *,
               ${combineExpr} as ${quoteColumn(newColName)}
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
    const columnNames = this.getColumnNames()
    // Rows where any of the combined columns has a value
    const conditions = columnNames.map(
      (col) => `(${quoteColumn(col)} IS NOT NULL AND TRIM(CAST(${quoteColumn(col)} AS VARCHAR)) != '')`
    )
    return `(${conditions.join(' OR ')})`
  }
}
