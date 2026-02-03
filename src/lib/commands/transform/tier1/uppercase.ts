/**
 * Uppercase Command
 *
 * Converts text to UPPERCASE.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

export interface UppercaseParams extends BaseTransformParams {
  column: string
}

export class UppercaseCommand extends Tier1TransformCommand<UppercaseParams> {
  readonly type: CommandType = 'transform:uppercase'
  readonly label = 'Uppercase'

  getTransformExpression(_ctx: CommandContext): string {
    return `UPPER(${COLUMN_PLACEHOLDER})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // NULL-safe comparison: only rows where value would actually change
    return `${col} IS DISTINCT FROM UPPER(${col})`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedColumnTransform(
        ctx,
        col,
        `UPPER("${col}")`,
        `"${col}" IS DISTINCT FROM UPPER("${col}")`
      )
    }

    // Original logic for <500k rows (use base class implementation)
    return super.execute(ctx)
  }
}
