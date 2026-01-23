/**
 * Find & Replace Command
 *
 * Replaces text values with support for case sensitivity and match type.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ValidationResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { escapeSqlString, escapeRegexPattern } from '../../utils/sql'
import { COLUMN_PLACEHOLDER } from '../../column-versions'

export interface ReplaceParams extends BaseTransformParams {
  column: string
  find: string
  replace: string
  caseSensitive?: boolean
  matchType?: 'contains' | 'exact'
}

export class ReplaceCommand extends Tier1TransformCommand<ReplaceParams> {
  readonly type: CommandType = 'transform:replace'
  readonly label = 'Find & Replace'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    if (!this.params.find) {
      return this.errorResult('FIND_REQUIRED', 'Find value is required', 'find')
    }
    return this.validResult()
  }

  getTransformExpression(_ctx: CommandContext): string {
    const col = COLUMN_PLACEHOLDER
    const find = escapeSqlString(this.params.find)
    const replace = escapeSqlString(this.params.replace ?? '')
    const caseSensitive = this.params.caseSensitive ?? true
    const matchType = this.params.matchType ?? 'contains'

    if (matchType === 'exact') {
      if (caseSensitive) {
        return `CASE WHEN ${col} = '${find}' THEN '${replace}' ELSE ${col} END`
      } else {
        return `CASE WHEN LOWER(${col}) = LOWER('${find}') THEN '${replace}' ELSE ${col} END`
      }
    } else {
      // contains
      if (caseSensitive) {
        return `REPLACE(${col}, '${find}', '${replace}')`
      } else {
        const regexEscaped = escapeRegexPattern(find)
        return `REGEXP_REPLACE(${col}, '${regexEscaped}', '${replace}', 'gi')`
      }
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    const find = escapeSqlString(this.params.find)
    const caseSensitive = this.params.caseSensitive ?? true
    const matchType = this.params.matchType ?? 'contains'

    if (matchType === 'exact') {
      if (caseSensitive) {
        return `${col} = '${find}'`
      } else {
        return `LOWER(${col}) = LOWER('${find}')`
      }
    } else {
      // contains
      if (caseSensitive) {
        return `${col} LIKE '%${find}%'`
      } else {
        return `LOWER(${col}) LIKE LOWER('%${find}%')`
      }
    }
  }
}
