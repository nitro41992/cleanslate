/**
 * Title Case Command
 *
 * Capitalizes first letter of each word.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

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
    // All non-empty values are potentially affected
    return `${col} IS NOT NULL AND TRIM(${col}) != ''`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!

    // Check if batching is needed
    if (ctx.batchMode) {
      const transformExpr = `CASE
        WHEN "${col}" IS NULL OR TRIM("${col}") = '' THEN "${col}"
        ELSE list_reduce(
          list_transform(
            string_split(lower("${col}"), ' '),
            w -> concat(upper(substring(w, 1, 1)), substring(w, 2))
          ),
          (x, y) -> concat(x, ' ', y)
        )
      END`

      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE ("${col}"), ${transformExpr} as "${col}"
         FROM "${ctx.table.name}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT "${col}" as before, ${transformExpr} as after
         FROM "${ctx.table.name}"
         WHERE "${col}" IS DISTINCT FROM ${transformExpr}`
      )
    }

    // Original logic for <500k rows
    return super.execute(ctx)
  }
}
