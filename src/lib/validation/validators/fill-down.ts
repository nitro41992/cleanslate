import { query } from '@/lib/duckdb'
import type { SemanticValidationResult, ValidatorContext } from '../types'

/**
 * Validate fill_down transform
 * Checks if column has any empty values to fill
 */
export async function validateFillDown(
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

  const quotedCol = `"${column}"`

  // Count empty/null values
  const result = await query<{ total: number; empty_count: number }>(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE ${quotedCol} IS NULL OR TRIM(CAST(${quotedCol} AS VARCHAR)) = '') as empty_count
    FROM "${tableName}"
  `)

  // Convert BigInt to Number (DuckDB returns BigInt)
  const total = Number(result[0].total)
  const empty_count = Number(result[0].empty_count)

  if (total === 0) {
    return {
      status: 'no_op',
      message: 'Table is empty',
      affectedCount: 0,
      code: 'EMPTY_TABLE',
    }
  }

  if (empty_count === 0) {
    return {
      status: 'no_op',
      message: 'No empty values to fill',
      affectedCount: 0,
      code: 'NO_EMPTY_VALUES',
    }
  }

  return {
    status: 'valid',
    message: `${empty_count} empty value${empty_count > 1 ? 's' : ''} will be filled`,
    affectedCount: empty_count,
    code: 'HAS_EMPTY_VALUES',
  }
}
