/**
 * Scrub Year Only Command
 *
 * Replaces date values with just the year (YYYY-01-01).
 * Tier 3 - Requires snapshot for undo (precision is lost).
 * Uses CTAS pattern to ensure column becomes VARCHAR type.
 */

import type {
  CommandContext,
  CommandType,
  ExecutionResult,
  ValidationResult,
} from '../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../transform/base'

export interface ScrubYearOnlyParams extends BaseTransformParams {
  column: string
}

export class ScrubYearOnlyCommand extends Tier3TransformCommand<ScrubYearOnlyParams> {
  readonly type: CommandType = 'scrub:year_only'
  readonly label = 'Year Only'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const column = this.params.column

    try {
      // Count affected rows (non-null values that can be parsed as dates)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE "${column}" IS NOT NULL AND TRY_CAST("${column}" AS DATE) IS NOT NULL`
      )
      const affected = Number(countResult[0]?.count ?? 0)

      // Get all columns except the target column
      const columns = ctx.table.columns.map((c) => c.name)
      const otherCols = columns.filter((c) => c !== column)

      // Build column list: other columns unchanged, target column transformed to VARCHAR
      const selectCols = otherCols.map((c) => `"${c}"`).join(', ')
      const transformExpr = `CASE
        WHEN "${column}" IS NOT NULL AND TRY_CAST("${column}" AS DATE) IS NOT NULL
        THEN strftime(DATE_TRUNC('year', TRY_CAST("${column}" AS DATE)), '%Y-%m-%d')
        ELSE CAST("${column}" AS VARCHAR)
      END AS "${column}"`

      const selectClause = otherCols.length > 0 ? `${selectCols}, ${transformExpr}` : transformExpr

      // Use CTAS pattern to recreate table with transformed column as VARCHAR
      // CRITICAL: ORDER BY "_cs_id" preserves row order (prevents flaky tests)
      const tempTable = `_temp_year_only_${Date.now()}`
      await ctx.db.execute(
        `CREATE TABLE "${tempTable}" AS SELECT ${selectClause} FROM "${tableName}" ORDER BY "_cs_id"`
      )

      // Drop original and rename temp
      await ctx.db.execute(`DROP TABLE "${tableName}"`)
      await ctx.db.execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)

      // Get updated table metadata
      const newColumns = await ctx.db.getTableColumns(tableName)
      const rowCountResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      const rowCount = Number(rowCountResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns: newColumns,
        affected,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    } catch (error) {
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
    // Rows where the date was truncated to year (ends with -01-01)
    return `"${this.params.column}" LIKE '%-01-01%'`
  }
}
