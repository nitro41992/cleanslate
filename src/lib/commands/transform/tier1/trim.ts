/**
 * Trim Whitespace Command
 *
 * Removes leading and trailing whitespace from a column.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'

export interface TrimParams extends BaseTransformParams {
  column: string
}

export class TrimCommand extends Tier1TransformCommand<TrimParams> {
  readonly type: CommandType = 'transform:trim'
  readonly label = 'Trim Whitespace'

  getTransformExpression(_ctx: CommandContext): string {
    return `TRIM(${this.getQuotedColumn()})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where trimmed value differs from original
    return `${col} IS NOT NULL AND ${col} != TRIM(${col})`
  }
}
