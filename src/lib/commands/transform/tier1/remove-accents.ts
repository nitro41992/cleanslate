/**
 * Remove Accents Command
 *
 * Removes diacritical marks (café → cafe).
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

export interface RemoveAccentsParams extends BaseTransformParams {
  column: string
}

export class RemoveAccentsCommand extends Tier1TransformCommand<RemoveAccentsParams> {
  readonly type: CommandType = 'transform:remove_accents'
  readonly label = 'Remove Accents'

  getTransformExpression(_ctx: CommandContext): string {
    return `strip_accents(${COLUMN_PLACEHOLDER})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // NULL-safe comparison: only rows where value would actually change
    return `${col} IS DISTINCT FROM strip_accents(${col})`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    if (ctx.batchMode) {
      return runBatchedColumnTransform(
        ctx, col, `strip_accents("${col}")`, `"${col}" IS DISTINCT FROM strip_accents("${col}")`
      )
    }

    return super.execute(ctx)
  }
}
