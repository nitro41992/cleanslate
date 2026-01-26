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
import { buildColumnOrderedSelect, getColumnOrderForTable } from '../../batch-utils'
import { tableHasCsId } from '@/lib/duckdb'

export interface FillDownParams extends BaseTransformParams {
  column: string
}

export class FillDownCommand extends Tier3TransformCommand<FillDownParams> {
  readonly type: CommandType = 'transform:fill_down'
  readonly label = 'Fill Down'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`
    const col = this.params.column
    const quotedCol = quoteColumn(col)

    try {
      // Check if _cs_id column exists (for ordering and preservation)
      const hasCsId = await tableHasCsId(tableName)
      const orderCol = hasCsId ? '"_cs_id"' : 'ROWID'

      // Fill down expression using LAST_VALUE with IGNORE NULLS
      const fillExpr = `
        COALESCE(
          NULLIF(TRIM(CAST(${quotedCol} AS VARCHAR)), ''),
          LAST_VALUE(NULLIF(TRIM(CAST(${quotedCol} AS VARCHAR)), '') IGNORE NULLS) OVER (
            ORDER BY ${orderCol}
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          )
        )
      `

      // Use column-ordered SELECT to preserve column order
      const columnOrder = getColumnOrderForTable(ctx)
      const selectQuery = buildColumnOrderedSelect(tableName, columnOrder, { [col]: fillExpr }, hasCsId)

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
    return `${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = ''`
  }
}
