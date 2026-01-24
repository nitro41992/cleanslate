/**
 * Find & Replace Command
 *
 * Replaces text values with support for case sensitivity and match type.
 * Tier 1 - Column versioning for instant undo.
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier1TransformCommand, type BaseTransformParams } from '../base'
import { escapeSqlString, escapeRegexPattern } from '../../utils/sql'
import { COLUMN_PLACEHOLDER } from '../../column-versions'
import { runBatchedTransform } from '../../batch-utils'

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
    // Handle boolean or string values from UI (UI passes 'true'/'false' strings)
    const caseSensitive = this.params.caseSensitive === false || this.params.caseSensitive === 'false' ? false : true
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
        // Workaround for DuckDB-WASM 1.32.0: inline (?i) flag doesn't work reliably
        // Convert each letter to a character class [Aa] for case-insensitive matching
        // e.g., "hello" becomes "[Hh][Ee][Ll][Ll][Oo]"
        let pattern = escapeRegexPattern(find)
        pattern = pattern.replace(/[a-z]/gi, (letter) => {
          const lower = letter.toLowerCase()
          const upper = letter.toUpperCase()
          return lower !== upper ? `[${lower}${upper}]` : letter
        })
        return `REGEXP_REPLACE(${col}, '${pattern}', '${replace}', 'g')`
      }
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
    const col = this.getQuotedColumn()
    const find = escapeSqlString(this.params.find)
    // Handle boolean or string values from UI (UI passes 'true'/'false' strings)
    const caseSensitive = this.params.caseSensitive === false || this.params.caseSensitive === 'false' ? false : true
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

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column!
    const find = escapeSqlString(this.params.find)
    const replace = escapeSqlString(this.params.replace ?? '')
    const caseSensitive = this.params.caseSensitive === false || this.params.caseSensitive === 'false' ? false : true
    const matchType = this.params.matchType ?? 'contains'

    // Check if batching is needed
    if (ctx.batchMode) {
      let transformExpr: string

      if (matchType === 'exact') {
        if (caseSensitive) {
          transformExpr = `CASE WHEN "${col}" = '${find}' THEN '${replace}' ELSE "${col}" END`
        } else {
          transformExpr = `CASE WHEN LOWER("${col}") = LOWER('${find}') THEN '${replace}' ELSE "${col}" END`
        }
      } else {
        // contains
        if (caseSensitive) {
          transformExpr = `REPLACE("${col}", '${find}', '${replace}')`
        } else {
          // Case-insensitive regex replacement (character class workaround)
          let pattern = escapeRegexPattern(this.params.find)
          pattern = pattern.replace(/[a-z]/gi, (letter) => {
            const lower = letter.toLowerCase()
            const upper = letter.toUpperCase()
            return lower !== upper ? `[${lower}${upper}]` : letter
          })
          transformExpr = `REGEXP_REPLACE("${col}", '${pattern}', '${replace}', 'g')`
        }
      }

      return runBatchedTransform(
        ctx,
        // Transform query
        `SELECT * EXCLUDE ("${col}"), ${transformExpr} as "${col}"
         FROM "${ctx.table.name}"`,
        // Sample query (captures before/after for first 1000 affected rows)
        `SELECT "${col}" as before, ${transformExpr} as after
         FROM "${ctx.table.name}"
         WHERE "${col}" IS DISTINCT FROM ${transformExpr}`
      )
    }

    // Original logic for <500k rows
    return super.execute(ctx)
  }
}
