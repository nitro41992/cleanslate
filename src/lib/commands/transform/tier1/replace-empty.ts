/**
 * Replace Empty Command
 *
 * Replaces empty/null values with a specified value.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { escapeSqlString } from '../../utils/sql'
import { COLUMN_PLACEHOLDER } from '../../column-versions'

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
}
