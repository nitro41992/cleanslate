/**
 * Scrub Redact Command
 *
 * Replaces all values in a column with [REDACTED].
 * Tier 3 - Requires snapshot for undo (original data is destroyed).
 */

import type {
  CommandContext,
  CommandType,
  ExecutionResult,
  ValidationResult,
} from '../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../transform/base'

export interface ScrubRedactParams extends BaseTransformParams {
  column: string
  replacement?: string // Default '[REDACTED]'
}

export class ScrubRedactCommand extends Tier3TransformCommand<ScrubRedactParams> {
  readonly type: CommandType = 'scrub:redact'
  readonly label = 'Redact PII'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const column = this.params.column
    const replacement = this.params.replacement || '[REDACTED]'

    try {
      // Count affected rows
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE "${column}" IS NOT NULL`
      )
      const affected = Number(countResult[0]?.count ?? 0)

      // Execute UPDATE
      await ctx.db.execute(
        `UPDATE "${tableName}" SET "${column}" = '${replacement}' WHERE "${column}" IS NOT NULL`
      )

      // Get updated table metadata
      const columns = await ctx.db.getTableColumns(tableName)
      const rowCountResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      const rowCount = Number(rowCountResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
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
    const replacement = this.params.replacement || '[REDACTED]'
    // After execution, rows that are now [REDACTED] were affected
    return `"${this.params.column}" = '${replacement}'`
  }
}
