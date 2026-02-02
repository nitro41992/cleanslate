import { query } from '@/lib/duckdb'
import type { SemanticValidationResult, ValidatorContext } from '../types'

/**
 * Validate replace transform
 * Checks if column contains any rows with the search value
 */
export async function validateReplace(
  context: ValidatorContext
): Promise<SemanticValidationResult> {
  const { tableName, column, params } = context

  if (!column) {
    return {
      status: 'invalid',
      message: 'No column selected',
      code: 'NO_COLUMN',
    }
  }

  const findValue = params?.find as string | undefined

  // If no find value, skip validation (user is still typing)
  if (findValue === undefined || findValue === '') {
    return {
      status: 'skipped',
      message: '',
      code: 'NO_FIND_VALUE',
    }
  }

  const quotedCol = `"${column}"`
  // Escape single quotes for SQL
  const escapedFind = findValue.replace(/'/g, "''")

  // Count rows containing the search value
  const result = await query<{ match_count: number }>(`
    SELECT COUNT(*) as match_count
    FROM "${tableName}"
    WHERE CAST(${quotedCol} AS VARCHAR) LIKE '%${escapedFind}%'
  `)

  // Convert BigInt to Number (DuckDB returns BigInt)
  const match_count = Number(result[0].match_count)

  if (match_count === 0) {
    return {
      status: 'no_op',
      message: `No rows contain "${findValue}"`,
      affectedCount: 0,
      code: 'NO_MATCHES',
    }
  }

  return {
    status: 'valid',
    message: `${match_count} row${match_count > 1 ? 's' : ''} will be updated`,
    affectedCount: match_count,
    code: 'HAS_MATCHES',
  }
}
