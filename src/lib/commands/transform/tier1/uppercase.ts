/**
 * Uppercase Command
 *
 * Converts text to UPPERCASE.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'

export interface UppercaseParams extends BaseTransformParams {
  column: string
}

export class UppercaseCommand extends Tier1TransformCommand<UppercaseParams> {
  readonly type: CommandType = 'transform:uppercase'
  readonly label = 'Uppercase'

  getTransformExpression(_ctx: CommandContext): string {
    return `UPPER(${this.getQuotedColumn()})`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where uppercased value differs from original
    return `${col} IS NOT NULL AND ${col} != UPPER(${col})`
  }
}
