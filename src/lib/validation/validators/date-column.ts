import { query } from '@/lib/duckdb'
import { buildDateParseExpression, buildDateNotNullPredicate } from '@/lib/commands/utils/date'
import type { SemanticValidationResult, ValidatorContext } from '../types'

/**
 * Validate date-based transforms (standardize_date, calculate_age, year_only)
 * Checks if column contains any parseable dates
 */
export async function validateDateColumn(
  context: ValidatorContext
): Promise<SemanticValidationResult> {
  const { tableName, column } = context

  if (!column) {
    return {
      status: 'invalid',
      message: 'No column selected',
      code: 'NO_COLUMN',
    }
  }

  // Build date parse expression
  const parseExpr = buildDateParseExpression(column)
  const notNullPredicate = buildDateNotNullPredicate(column)

  // Count total non-empty rows and successful date parses
  const result = await query<{ total: number; parseable: number }>(`
    SELECT
      COUNT(*) FILTER (WHERE ${notNullPredicate}) as total,
      COUNT(*) FILTER (WHERE (${parseExpr}) IS NOT NULL) as parseable
    FROM "${tableName}"
  `)

  // Convert BigInt to Number (DuckDB returns BigInt)
  const total = Number(result[0].total)
  const parseable = Number(result[0].parseable)

  if (total === 0) {
    return {
      status: 'no_op',
      message: 'Column has no values to convert',
      affectedCount: 0,
      code: 'EMPTY_COLUMN',
    }
  }

  if (parseable === 0) {
    return {
      status: 'invalid',
      message: 'No parseable dates found in column',
      affectedCount: 0,
      code: 'NO_PARSEABLE_DATES',
    }
  }

  const unparseable = total - parseable

  if (unparseable > 0) {
    return {
      status: 'warning',
      message: `${parseable} of ${total} values will be converted (${unparseable} cannot be parsed)`,
      affectedCount: parseable,
      code: 'PARTIAL_PARSE',
    }
  }

  return {
    status: 'valid',
    message: `All ${parseable} values will be converted`,
    affectedCount: parseable,
    code: 'ALL_PARSEABLE',
  }
}
