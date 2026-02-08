/**
 * Collapse Spaces Command
 *
 * Replaces multiple spaces with single space.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

export interface CollapseSpacesParams extends BaseTransformParams {
  column: string
}

export class CollapseSpacesCommand extends Tier1TransformCommand<CollapseSpacesParams> {
  readonly type: CommandType = 'transform:collapse_spaces'
  readonly label = 'Collapse Spaces'

  getTransformExpression(_ctx: CommandContext): string {
    // Cast to VARCHAR so regexp_replace works on non-text columns (e.g., DOUBLE)
    const castCol = `CAST(${COLUMN_PLACEHOLDER} AS VARCHAR)`
    return `regexp_replace(${castCol}, '[ \\t\\n\\r]+', ' ', 'g')`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    const castCol = `CAST(${col} AS VARCHAR)`
    // NULL-safe comparison: only rows where value would actually change
    return `${castCol} IS DISTINCT FROM regexp_replace(${castCol}, '[ \\t\\n\\r]+', ' ', 'g')`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!
    const castCol = `CAST("${col}" AS VARCHAR)`
    const expr = `regexp_replace(${castCol}, '[ \\t\\n\\r]+', ' ', 'g')`

    if (ctx.batchMode) {
      return runBatchedColumnTransform(ctx, col, expr, `${castCol} IS DISTINCT FROM ${expr}`)
    }

    return super.execute(ctx)
  }
}
