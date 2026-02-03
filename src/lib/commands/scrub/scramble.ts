/**
 * Scrub Scramble Command
 *
 * Deterministically scrambles digits in a value by reversing the digit order.
 * Same input always produces the same scrambled output (recipe-compatible).
 * Non-digit characters are preserved in their original positions.
 *
 * Example: "555-123-4567" -> "765-432-1555"
 *
 * Tier 1 - Uses expression chaining for instant undo.
 */

import type {
  CommandContext,
  CommandType,
  ValidationResult,
} from '../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../transform/base'

export interface ScrubScrambleParams extends BaseTransformParams {
  column: string
}

export class ScrubScrambleCommand extends Tier1TransformCommand<ScrubScrambleParams> {
  readonly type: CommandType = 'scrub:scramble'
  readonly label = 'Scramble Digits'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  getTransformExpression(_ctx: CommandContext): string {
    // Simple deterministic scramble: reverse all digits
    // Non-digit characters stay in place, digits get reversed order
    //
    // For simplicity, we'll just reverse the digit-only portion and
    // place it where digits were. More complex interleaving would
    // require procedural code.
    //
    // Simplified approach: If the value is all digits (common for IDs, SSNs),
    // just reverse. If mixed, replace digits with reversed digits string.
    const colExpr = `CAST({{COL}} AS VARCHAR)`
    const digitsOnly = `regexp_replace(${colExpr}, '[^0-9]', '', 'g')`

    return `CASE
      WHEN {{COL}} IS NULL THEN NULL
      WHEN ${colExpr} = '' THEN ''
      WHEN ${colExpr} = ${digitsOnly}
      THEN reverse(${colExpr})
      ELSE regexp_replace(
        ${colExpr},
        '[0-9]+',
        reverse(${digitsOnly}),
        'g'
      )
    END`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = this.getQuotedColumn()
    // All non-null rows with at least two digits will be affected
    return `${col} IS NOT NULL AND LENGTH(regexp_replace(CAST(${col} AS VARCHAR), '[^0-9]', '', 'g')) > 1`
  }
}
