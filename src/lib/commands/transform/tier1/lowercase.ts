/**
 * Lowercase Command
 *
 * Converts text to lowercase.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'

export interface LowercaseParams extends BaseTransformParams {
  column: string
}

export class LowercaseCommand extends Tier1TransformCommand<LowercaseParams> {
  readonly type: CommandType = 'transform:lowercase'
  readonly label = 'Lowercase'

  getTransformExpression(_ctx: CommandContext): string {
    return `LOWER(${COLUMN_PLACEHOLDER})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where lowercased value differs from original
    return `${col} IS NOT NULL AND ${col} != LOWER(${col})`
  }
}
