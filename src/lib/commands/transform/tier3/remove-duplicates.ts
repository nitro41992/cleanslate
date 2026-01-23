/**
 * Remove Duplicates Command
 *
 * Removes duplicate rows from the table.
 * Tier 3 - Requires snapshot for undo (row deletion is destructive).
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { CS_ID_COLUMN } from '@/lib/duckdb'

// RemoveDuplicatesParams extends BaseTransformParams with no additional params
// (operates on all columns, no column selection needed)
export type RemoveDuplicatesParams = BaseTransformParams

export class RemoveDuplicatesCommand extends Tier3TransformCommand<RemoveDuplicatesParams> {
  readonly type: CommandType = 'transform:remove_duplicates'
  readonly label = 'Remove Duplicates'

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {
      // Get user columns (exclude internal _cs_id column to properly detect duplicates)
      const userCols = ctx.table.columns
        .filter((c) => c.name !== CS_ID_COLUMN)
        .map((c) => quoteColumn(c.name))

      // Create temp table with distinct rows and new _cs_id values
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT gen_random_uuid() as ${quoteColumn(CS_ID_COLUMN)}, ${userCols.join(', ')}
        FROM (SELECT DISTINCT ${userCols.join(', ')} FROM ${quoteTable(tableName)})
      `
      await ctx.db.execute(sql)

      // Get count before swap
      const countBefore = ctx.table.rowCount

      // Drop original and rename temp
      await ctx.db.execute(`DROP TABLE ${quoteTable(tableName)}`)
      await ctx.db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

      // Get new count and columns
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)
      const columns = await ctx.db.getTableColumns(tableName)

      const removed = countBefore - rowCount

      return {
        success: true,
        rowCount,
        columns,
        affected: removed,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    } catch (error) {
      // Cleanup temp table on error
      try {
        await ctx.db.execute(`DROP TABLE IF EXISTS ${quoteTable(tempTable)}`)
      } catch {
        // Ignore cleanup errors
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
    // Cannot provide predicate for deleted rows
    return null
  }
}
