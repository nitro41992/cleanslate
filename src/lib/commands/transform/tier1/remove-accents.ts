/**
 * Remove Accents Command
 *
 * Removes diacritical marks (café → cafe).
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

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
    // Rows where stripped value differs from original
    return `${col} IS NOT NULL AND ${col} != strip_accents(${col})`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE ("${col}"), strip_accents("${col}") as "${col}"
         FROM "${ctx.table.name}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT "${col}" as before, strip_accents("${col}") as after
         FROM "${ctx.table.name}"
         WHERE "${col}" IS DISTINCT FROM strip_accents("${col}")`
      )
    }

    // Original logic for <500k rows
    return super.execute(ctx)
  }
}
