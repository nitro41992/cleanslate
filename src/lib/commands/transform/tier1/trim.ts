/**
 * Trim Whitespace Command
 *
 * Removes leading and trailing whitespace from a column.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

export interface TrimParams extends BaseTransformParams {
  column: string
}

export class TrimCommand extends Tier1TransformCommand<TrimParams> {
  readonly type: CommandType = 'transform:trim'
  readonly label = 'Trim Whitespace'

  getTransformExpression(_ctx: CommandContext): string {
    return `TRIM(${COLUMN_PLACEHOLDER})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where trimmed value differs from original
    return `${col} IS NOT NULL AND ${col} != TRIM(${col})`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE ("${col}"), TRIM("${col}") as "${col}"
         FROM "${ctx.table.name}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT "${col}" as before, TRIM("${col}") as after
         FROM "${ctx.table.name}"
         WHERE "${col}" IS DISTINCT FROM TRIM("${col}")`
      )
    }

    // Original logic for <500k rows
    return super.execute(ctx)
  }
}
