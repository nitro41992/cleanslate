/**
 * Lowercase Command
 *
 * Converts text to lowercase.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

export interface LowercaseParams extends BaseTransformParams {
  column: string
}

export class LowercaseCommand extends Tier1TransformCommand<LowercaseParams> {
  readonly type: CommandType = 'transform:lowercase'
  readonly label = 'Lowercase'

  getTransformExpression(_ctx: CommandContext): string {
    return `LOWER(${COLUMN_PLACEHOLDER})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where lowercased value differs from original
    return `${col} IS NOT NULL AND ${col} != LOWER(${col})`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE ("${col}"), LOWER("${col}") as "${col}"
         FROM "${ctx.table.name}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT "${col}" as before, LOWER("${col}") as after
         FROM "${ctx.table.name}"
         WHERE "${col}" IS DISTINCT FROM LOWER("${col}")`
      )
    }

    // Original logic for <500k rows
    return super.execute(ctx)
  }
}
