/**
 * Scrub Hash Command
 *
 * Hashes a column using MD5 with a secret salt.
 * Tier 1 - Uses expression chaining for instant undo.
 */

import type {
  CommandContext,
  CommandType,
  ValidationResult,
} from '../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../transform/base'
import { escapeSqlString } from '../utils/sql'

export interface ScrubHashParams extends BaseTransformParams {
  column: string
  secret: string
}

export class ScrubHashCommand extends Tier1TransformCommand<ScrubHashParams> {
  readonly type: CommandType = 'scrub:hash'
  readonly label = 'Hash Column'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    // Check secret is provided
    if (!this.params.secret) {
      return this.errorResult('SECRET_REQUIRED', 'A secret is required for consistent hashing', 'secret')
    }

    return this.validResult()
  }

  getTransformExpression(_ctx: CommandContext): string {
    // Use MD5 with secret concatenation
    // MD5(CONCAT(column, 'secret')) - returns a 32-char hex string
    const escapedSecret = escapeSqlString(this.params.secret)
    return `MD5(CONCAT(CAST({{COL}} AS VARCHAR), '${escapedSecret}'))`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = this.getQuotedColumn()
    // All non-null rows will be hashed
    return `${col} IS NOT NULL`
  }
}
