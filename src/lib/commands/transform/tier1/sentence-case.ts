/**
 * Sentence Case Command
 *
 * Capitalizes first letter only, lowercases rest.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

export interface SentenceCaseParams extends BaseTransformParams {
  column: string
}

export class SentenceCaseCommand extends Tier1TransformCommand<SentenceCaseParams> {
  readonly type: CommandType = 'transform:sentence_case'
  readonly label = 'Sentence Case'

  getTransformExpression(_ctx: CommandContext): string {
    const col = COLUMN_PLACEHOLDER
    return `CASE
      WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN ${col}
      ELSE concat(upper(substring(${col}, 1, 1)), lower(substring(${col}, 2)))
    END`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // All non-empty values are potentially affected
    return `${col} IS NOT NULL AND TRIM(${col}) != ''`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    if (ctx.batchMode) {
      const expr = `CASE
        WHEN "${col}" IS NULL OR TRIM("${col}") = '' THEN "${col}"
        ELSE concat(upper(substring("${col}", 1, 1)), lower(substring("${col}", 2)))
      END`

      return runBatchedColumnTransform(ctx, col, expr, `"${col}" IS DISTINCT FROM ${expr}`)
    }

    return super.execute(ctx)
  }
}
