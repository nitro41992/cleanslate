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
import { CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN } from '@/lib/duckdb'

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

      // Check if identity columns exist (for legacy tables)
      const schemaResult = await ctx.db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`
      )
      const allTableCols = schemaResult.map(r => r.column_name)
      const hasCsId = allTableCols.includes(CS_ID_COLUMN)
      const hasCsOriginId = allTableCols.includes(CS_ORIGIN_ID_COLUMN)

      // Build SELECT parts: identity columns first, then data columns
      const selectParts: string[] = []
      if (hasCsId) {
        selectParts.push(`"${CS_ID_COLUMN}"`)
      }
      if (hasCsOriginId) {
        selectParts.push(`"${CS_ORIGIN_ID_COLUMN}"`)
      }

      // Add other data columns unchanged
      for (const col of otherCols) {
        selectParts.push(`"${col}"`)
      }

      // Add the transformed column
      const transformExpr = `CASE
        WHEN "${column}" IS NOT NULL AND TRY_CAST("${column}" AS DATE) IS NOT NULL
        THEN strftime(DATE_TRUNC('year', TRY_CAST("${column}" AS DATE)), '%Y-%m-%d')
        ELSE CAST("${column}" AS VARCHAR)
      END AS "${column}"`
      selectParts.push(transformExpr)

      // Use CTAS pattern to recreate table with transformed column as VARCHAR
      // Order by _cs_id if it exists, otherwise use default row order
      const tempTable = `_temp_year_only_${Date.now()}`
      const orderClause = hasCsId ? `ORDER BY "${CS_ID_COLUMN}"` : ''
      await ctx.db.execute(
        `CREATE TABLE "${tempTable}" AS SELECT ${selectParts.join(', ')} FROM "${tableName}" ${orderClause}`
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
