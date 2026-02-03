/**
 * Title Case Command
 *
 * Capitalizes first letter of each word.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedColumnTransform } from '../../batch-utils'

export interface TitleCaseParams extends BaseTransformParams {
  column: string
}

export class TitleCaseCommand extends Tier1TransformCommand<TitleCaseParams> {
  readonly type: CommandType = 'transform:title_case'
  readonly label = 'Title Case'

  getTransformExpression(_ctx: CommandContext): string {
    const col = COLUMN_PLACEHOLDER
    // DuckDB-WASM doesn't have initcap, use list_transform + list_reduce
    return `CASE
      WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN ${col}
      ELSE list_reduce(
        list_transform(
          string_split(lower(${col}), ' '),
          w -> concat(upper(substring(w, 1, 1)), substring(w, 2))
        ),
        (x, y) -> concat(x, ' ', y)
      )
    END`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // NULL-safe comparison: only rows where value would actually change
    const titleCaseExpr = `CASE
      WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN ${col}
      ELSE list_reduce(
        list_transform(
          string_split(lower(${col}), ' '),
          w -> concat(upper(substring(w, 1, 1)), substring(w, 2))
        ),
        (x, y) -> concat(x, ' ', y)
      )
    END`
    return `${col} IS DISTINCT FROM ${titleCaseExpr}`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    if (ctx.batchMode) {
      const expr = `CASE
        WHEN "${col}" IS NULL OR TRIM("${col}") = '' THEN "${col}"
        ELSE list_reduce(
          list_transform(
            string_split(lower("${col}"), ' '),
            w -> concat(upper(substring(w, 1, 1)), substring(w, 2))
          ),
          (x, y) -> concat(x, ' ', y)
        )
      END`

      return runBatchedColumnTransform(ctx, col, expr, `"${col}" IS DISTINCT FROM ${expr}`)
    }

    return super.execute(ctx)
  }
}
