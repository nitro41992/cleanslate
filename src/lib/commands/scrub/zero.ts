/**
 * Scrub Zero Command
 *
 * Replaces all digits in a value with zeros.
 * Tier 1 - Uses expression chaining for instant undo.
 */

import type {
  CommandContext,
  CommandType,
  ValidationResult,
} from '../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../transform/base'

export interface ScrubZeroParams extends BaseTransformParams {
  column: string
}

export class ScrubZeroCommand extends Tier1TransformCommand<ScrubZeroParams> {
  readonly type: CommandType = 'scrub:zero'
  readonly label = 'Zero Out'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  getTransformExpression(_ctx: CommandContext): string {
    // Replace all digits with zeros, preserving other characters
    return `regexp_replace(CAST({{COL}} AS VARCHAR), '[0-9]', '0', 'g')`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = this.getQuotedColumn()
    // All non-null rows with at least one digit will be affected
    return `${col} IS NOT NULL AND regexp_replace(CAST(${col} AS VARCHAR), '[^0-9]', '', 'g') != ''`
  }
}
