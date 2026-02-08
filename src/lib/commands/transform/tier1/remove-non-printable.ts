/**
 * Remove Non-Printable Command
 *
 * Removes tabs, newlines, control characters.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

export interface RemoveNonPrintableParams extends BaseTransformParams {
  column: string
}

export class RemoveNonPrintableCommand extends Tier1TransformCommand<RemoveNonPrintableParams> {
  readonly type: CommandType = 'transform:remove_non_printable'
  readonly label = 'Remove Non-Printable'

  getTransformExpression(_ctx: CommandContext): string {
    // Cast to VARCHAR so regexp_replace works on non-text columns (e.g., DOUBLE)
    const castCol = `CAST(${COLUMN_PLACEHOLDER} AS VARCHAR)`
    return `regexp_replace(${castCol}, '[\\x00-\\x1F\\x7F]', '', 'g')`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    const castCol = `CAST(${col} AS VARCHAR)`
    // NULL-safe comparison: only rows where value would actually change
    return `${castCol} IS DISTINCT FROM regexp_replace(${castCol}, '[\\x00-\\x1F\\x7F]', '', 'g')`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!
    const castCol = `CAST("${col}" AS VARCHAR)`
    const expr = `regexp_replace(${castCol}, '[\\x00-\\x1F\\x7F]', '', 'g')`

    if (ctx.batchMode) {
      return runBatchedColumnTransform(ctx, col, expr, `${castCol} IS DISTINCT FROM ${expr}`)
    }

    return super.execute(ctx)
  }
}
