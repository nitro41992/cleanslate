/**
 * Trim Whitespace Command
 *
 * Removes leading and trailing whitespace from a column.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

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

    if (ctx.batchMode) {
      return runBatchedColumnTransform(
        ctx, col, `TRIM("${col}")`, `"${col}" IS DISTINCT FROM TRIM("${col}")`
      )
    }

    return super.execute(ctx)
  }
}
