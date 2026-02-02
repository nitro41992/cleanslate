import { query } from '@/lib/duckdb'
import type { SemanticValidationResult, ValidatorContext } from '../types'

/**
 * Validate remove_duplicates transform
 * Checks if there are any duplicate rows based on selected columns
 */
export async function validateRemoveDuplicates(
  context: ValidatorContext
): Promise<SemanticValidationResult> {
  const { tableName, params } = context

  // Get columns to check for duplicates
  // If no columns specified, check all user columns
  const columns = (params?.columns as string[]) || []

  if (columns.length === 0) {
    // Need to get all columns from the table
    const colResult = await query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
        AND column_name NOT IN ('_cs_id', '_cs_origin_id')
        AND column_name NOT LIKE '%__base'
      ORDER BY ordinal_position
    `)
    columns.push(...colResult.map(r => r.column_name))
  }

  if (columns.length === 0) {
    return {
      status: 'invalid',
      message: 'No columns available for duplicate detection',
      code: 'NO_COLUMNS',
    }
  }

  // Build column list for DISTINCT comparison
  const colList = columns.map(c => `"${c}"`).join(', ')

  // Count total rows vs distinct rows
  const result = await query<{ total: number; distinct_count: number }>(`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT (${colList})) as distinct_count
    FROM "${tableName}"
  `)

  const { total, distinct_count } = result[0]
  // Convert BigInt to Number for comparison (DuckDB returns BigInt)
  const duplicateCount = Number(total) - Number(distinct_count)

  if (duplicateCount === 0) {
    return {
      status: 'no_op',
      message: 'No duplicates found',
      affectedCount: 0,
      code: 'NO_DUPLICATES',
    }
  }

  return {
    status: 'valid',
    message: `${duplicateCount} duplicate row${duplicateCount > 1 ? 's' : ''} will be removed`,
    affectedCount: duplicateCount,
    code: 'HAS_DUPLICATES',
  }
}
