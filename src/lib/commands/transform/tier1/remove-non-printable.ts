/**
 * Remove Non-Printable Command
 *
 * Removes tabs, newlines, control characters.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

export interface RemoveNonPrintableParams extends BaseTransformParams {
  column: string
}

export class RemoveNonPrintableCommand extends Tier1TransformCommand<RemoveNonPrintableParams> {
  readonly type: CommandType = 'transform:remove_non_printable'
  readonly label = 'Remove Non-Printable'

  getTransformExpression(_ctx: CommandContext): string {
    return `regexp_replace(${COLUMN_PLACEHOLDER}, '[\\x00-\\x1F\\x7F]', '', 'g')`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where cleaned value differs from original
    return `${col} IS NOT NULL AND ${col} != regexp_replace(${col}, '[\\x00-\\x1F\\x7F]', '', 'g')`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE ("${col}"), regexp_replace("${col}", '[\\x00-\\x1F\\x7F]', '', 'g') as "${col}"
         FROM "${ctx.table.name}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT "${col}" as before, regexp_replace("${col}", '[\\x00-\\x1F\\x7F]', '', 'g') as after
         FROM "${ctx.table.name}"
         WHERE "${col}" IS DISTINCT FROM regexp_replace("${col}", '[\\x00-\\x1F\\x7F]', '', 'g')`
      )
    }

    // Original logic for <500k rows
    return super.execute(ctx)
  }
}
