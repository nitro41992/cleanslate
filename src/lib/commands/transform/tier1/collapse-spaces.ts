/**
 * Collapse Spaces Command
 *
 * Replaces multiple spaces with single space.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { COLUMN_PLACEHOLDER } from '../../column-versions'

export interface CollapseSpacesParams extends BaseTransformParams {
  column: string
}

export class CollapseSpacesCommand extends Tier1TransformCommand<CollapseSpacesParams> {
  readonly type: CommandType = 'transform:collapse_spaces'
  readonly label = 'Collapse Spaces'

  getTransformExpression(_ctx: CommandContext): string {
    return `regexp_replace(${COLUMN_PLACEHOLDER}, '[ \\t\\n\\r]+', ' ', 'g')`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    // Rows where collapsed value differs from original
    return `${col} IS NOT NULL AND ${col} != regexp_replace(${col}, '[ \\t\\n\\r]+', ' ', 'g')`
  }
}
