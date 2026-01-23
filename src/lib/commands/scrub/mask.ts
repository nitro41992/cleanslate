/**
 * Scrub Mask Command
 *
 * Masks a column by showing only first and last characters.
 * Tier 1 - Uses expression chaining for instant undo.
 */

import type {
  CommandContext,
  CommandType,
  ValidationResult,
} from '../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../transform/base'

export interface ScrubMaskParams extends BaseTransformParams {
  column: string
  preserveFirst?: number // Default 1
  preserveLast?: number // Default 1
}

export class ScrubMaskCommand extends Tier1TransformCommand<ScrubMaskParams> {
  readonly type: CommandType = 'scrub:mask'
  readonly label = 'Mask Values'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  getTransformExpression(_ctx: CommandContext): string {
    const preserveFirst = this.params.preserveFirst ?? 1
    const preserveLast = this.params.preserveLast ?? 1

    // Build masking expression:
    // CONCAT(LEFT(col, preserveFirst), REPEAT('*', MAX(0, LENGTH(col) - preserveFirst - preserveLast)), RIGHT(col, preserveLast))
    // For short strings, handle edge cases:
    // CASE WHEN LENGTH(col) <= (preserveFirst + preserveLast) THEN col
    //      ELSE CONCAT(...) END
    const colExpr = `CAST({{COL}} AS VARCHAR)`

    return `CASE
      WHEN {{COL}} IS NULL THEN NULL
      WHEN LENGTH(${colExpr}) <= ${preserveFirst + preserveLast} THEN REPEAT('*', LENGTH(${colExpr}))
      ELSE CONCAT(
        LEFT(${colExpr}, ${preserveFirst}),
        REPEAT('*', GREATEST(0, LENGTH(${colExpr}) - ${preserveFirst + preserveLast})),
        RIGHT(${colExpr}, ${preserveLast})
      )
    END`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = this.getQuotedColumn()
    // All non-null, non-empty rows will be masked
    return `${col} IS NOT NULL AND ${col} != ''`
  }
}
