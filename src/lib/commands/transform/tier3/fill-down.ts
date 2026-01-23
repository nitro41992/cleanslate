/**
 * Fill Down Command
 *
 * Fills empty/null cells with the value from the cell above.
 * Uses LAST_VALUE window function with IGNORE NULLS.
 * Tier 3 - Requires snapshot for undo (cannot reverse filled values).
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'

export interface FillDownParams extends BaseTransformParams {
  column: string
}

export class FillDownCommand extends Tier3TransformCommand<FillDownParams> {
  readonly type: CommandType = 'transform:fill_down'
  readonly label = 'Fill Down'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`
    const col = quoteColumn(this.params.column)

    try {
      // Build the fill down expression using LAST_VALUE with IGNORE NULLS
      // Need to handle both NULL and empty string as "empty"
      // Also need a stable row order - use _cs_id if available, otherwise ROWID

      // First, check if _cs_id column exists
      const hasRowId = ctx.table.columns.some((c) => c.name === '_cs_id')
      const orderCol = hasRowId ? '"_cs_id"' : 'ROWID'

      // Fill down expression:
      // If current value is null/empty, use LAST_VALUE from previous non-empty rows
      // Otherwise keep current value
      // Note: IGNORE NULLS must be inside the LAST_VALUE function call
      const fillExpr = `
        COALESCE(
          NULLIF(TRIM(CAST(${col} AS VARCHAR)), ''),
          LAST_VALUE(NULLIF(TRIM(CAST(${col} AS VARCHAR)), '') IGNORE NULLS) OVER (
            ORDER BY ${orderCol}
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          )
        )
      `

      // Create temp table with filled values
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT * EXCLUDE (${col}),
               ${fillExpr} as ${col}
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
    // Rows where value is null or empty (these will be filled)
    return `${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = ''`
  }
}
