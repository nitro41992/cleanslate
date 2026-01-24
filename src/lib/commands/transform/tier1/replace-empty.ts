/**
 * Replace Empty Command
 *
 * Replaces empty/null values with a specified value.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { escapeSqlString } from '../../utils/sql'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

export interface ReplaceEmptyParams extends BaseTransformParams {
  column: string
  replaceWith: string
}

export class ReplaceEmptyCommand extends Tier1TransformCommand<ReplaceEmptyParams> {
  readonly type: CommandType = 'transform:replace_empty'
  readonly label = 'Replace Empty'

  getTransformExpression(_ctx: CommandContext): string {
    const col = COLUMN_PLACEHOLDER
    const replacement = escapeSqlString(this.params.replaceWith ?? '')
    return `CASE
      WHEN ${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = ''
      THEN '${replacement}'
      ELSE ${col}
    END`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where value is null or empty
    return `${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = ''`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!
    const replacement = escapeSqlString(this.params.replaceWith ?? '')

    // Check if batching is needed
    if (ctx.batchMode) {
      const transformExpr = `CASE
        WHEN "${col}" IS NULL OR TRIM(CAST("${col}" AS VARCHAR)) = ''
        THEN '${replacement}'
        ELSE "${col}"
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
