/**
 * Cast Type Command
 *
 * Converts column data type.
 * Tier 3 - Requires snapshot for undo (type conversion may lose data).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { runBatchedTransform } from '../../batch-utils'

export type CastTargetType = 'VARCHAR' | 'INTEGER' | 'DOUBLE' | 'DATE' | 'BOOLEAN'

export interface CastTypeParams extends BaseTransformParams {
  column: string
  targetType: CastTargetType
}

export class CastTypeCommand extends Tier3TransformCommand<CastTypeParams> {
  readonly type: CommandType = 'transform:cast_type'
  readonly label = 'Cast Type'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    const validTypes: CastTargetType[] = ['VARCHAR', 'INTEGER', 'DOUBLE', 'DATE', 'BOOLEAN']
    if (!validTypes.includes(this.params.targetType)) {
      return this.errorResult(
        'INVALID_TYPE',
        `Invalid target type: ${this.params.targetType}`,
        'targetType'
      )
    }
    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = quoteColumn(this.params.column)

    // Check if batching is needed
    if (ctx.batchMode) {
      const transformExpr = `TRY_CAST(${col} AS ${this.params.targetType})`

      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE (${col}), ${transformExpr} as ${col}
         FROM "${tableName}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT ${col} as before, ${transformExpr} as after
         FROM "${tableName}"
         WHERE (${transformExpr} IS NOT NULL OR ${col} IS NOT NULL)`
      )
    }

    // Original logic for <500k rows
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {
      // Create temp table with casted column
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT * EXCLUDE (${col}),
               TRY_CAST(${col} AS ${this.params.targetType}) as ${col}
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
        affected: rowCount, // All rows potentially affected
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
    // All non-null rows are affected
    return `${col} IS NOT NULL`
  }
}
