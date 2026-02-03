/**
 * Scrub Last4 Command
 *
 * Shows only the last 4 digits of a value, masking the rest with asterisks.
 * Tier 1 - Uses expression chaining for instant undo.
 */

import type {
  CommandContext,
  CommandType,
  ValidationResult,
} from '../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../transform/base'

export interface ScrubLast4Params extends BaseTransformParams {
  column: string
}

export class ScrubLast4Command extends Tier1TransformCommand<ScrubLast4Params> {
  readonly type: CommandType = 'scrub:last4'
  readonly label = 'Show Last 4'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  getTransformExpression(_ctx: CommandContext): string {
    // Extract only digits, then show last 4 with asterisks for the rest
    // CONCAT(
    //   REPEAT('*', GREATEST(0, LENGTH(regexp_replace(col, '[^0-9]', '', 'g')) - 4)),
    //   RIGHT(regexp_replace(col, '[^0-9]', '', 'g'), 4)
    // )
    const colExpr = `CAST({{COL}} AS VARCHAR)`
    const digitsOnly = `regexp_replace(${colExpr}, '[^0-9]', '', 'g')`

    return `CASE
      WHEN {{COL}} IS NULL THEN NULL
      WHEN LENGTH(${digitsOnly}) <= 4 THEN ${digitsOnly}
      ELSE CONCAT(
        REPEAT('*', LENGTH(${digitsOnly}) - 4),
        RIGHT(${digitsOnly}, 4)
      )
    END`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = this.getQuotedColumn()
    // All non-null rows with at least one digit will be affected
    return `${col} IS NOT NULL AND regexp_replace(CAST(${col} AS VARCHAR), '[^0-9]', '', 'g') != ''`
  }
}
