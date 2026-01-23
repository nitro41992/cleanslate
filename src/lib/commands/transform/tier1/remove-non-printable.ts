/**
 * Remove Non-Printable Command
 *
 * Removes tabs, newlines, control characters.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'

export interface RemoveNonPrintableParams extends BaseTransformParams {
  column: string
}

export class RemoveNonPrintableCommand extends Tier1TransformCommand<RemoveNonPrintableParams> {
  readonly type: CommandType = 'transform:remove_non_printable'
  readonly label = 'Remove Non-Printable'

  getTransformExpression(_ctx: CommandContext): string {
    return `regexp_replace(${this.getQuotedColumn()}, '[\\x00-\\x1F\\x7F]', '', 'g')`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where cleaned value differs from original
    return `${col} IS NOT NULL AND ${col} != regexp_replace(${col}, '[\\x00-\\x1F\\x7F]', '', 'g')`
  }
}
