import { query } from '@/lib/duckdb'
import type { MatchPair } from '@/types'
import { generateId } from '@/lib/utils'

type BlockingStrategy = 'first_letter' | 'soundex' | 'exact'

export async function findDuplicates(
  tableName: string,
  matchColumn: string,
  blockingStrategy: BlockingStrategy,
  threshold: number
): Promise<MatchPair[]> {
  // Build blocking condition
  let blockCondition: string
  switch (blockingStrategy) {
    case 'first_letter':
      blockCondition = `UPPER(SUBSTR(a."${matchColumn}", 1, 1)) = UPPER(SUBSTR(b."${matchColumn}", 1, 1))`
      break
    case 'soundex':
      // DuckDB doesn't have built-in soundex, so we'll use a simplified blocking
      blockCondition = `UPPER(SUBSTR(a."${matchColumn}", 1, 2)) = UPPER(SUBSTR(b."${matchColumn}", 1, 2))`
      break
    case 'exact':
      blockCondition = `TRUE`
      break
    default:
      blockCondition = `UPPER(SUBSTR(a."${matchColumn}", 1, 1)) = UPPER(SUBSTR(b."${matchColumn}", 1, 1))`
  }

  // Get all columns for the table
  const columnsResult = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY ordinal_position`
  )
  const columns = columnsResult.map((c) => c.column_name)

  // Build select columns for both a and b
  const selectColsA = columns.map((c) => `a."${c}" as "a_${c}"`).join(', ')
  const selectColsB = columns.map((c) => `b."${c}" as "b_${c}"`).join(', ')

  // Run fuzzy matching query with Levenshtein distance
  const matchQuery = `
    WITH numbered AS (
      SELECT ROW_NUMBER() OVER () as row_id, *
      FROM "${tableName}"
    )
    SELECT
      ${selectColsA},
      ${selectColsB},
      levenshtein(LOWER(COALESCE(a."${matchColumn}", '')), LOWER(COALESCE(b."${matchColumn}", ''))) as score
    FROM numbered a
    JOIN numbered b ON a.row_id < b.row_id
    WHERE ${blockCondition}
      AND levenshtein(LOWER(COALESCE(a."${matchColumn}", '')), LOWER(COALESCE(b."${matchColumn}", ''))) <= ${threshold}
      AND a."${matchColumn}" IS NOT NULL
      AND b."${matchColumn}" IS NOT NULL
    ORDER BY score ASC
    LIMIT 500
  `

  const results = await query<Record<string, unknown>>(matchQuery)

  const pairs: MatchPair[] = results.map((row) => {
    const rowA: Record<string, unknown> = {}
    const rowB: Record<string, unknown> = {}

    columns.forEach((col) => {
      rowA[col] = row[`a_${col}`]
      rowB[col] = row[`b_${col}`]
    })

    return {
      id: generateId(),
      rowA,
      rowB,
      score: Number(row.score),
      status: 'pending',
    }
  })

  return pairs
}

export async function mergeDuplicates(
  tableName: string,
  pairs: MatchPair[],
  keyColumn: string
): Promise<number> {
  const mergedPairs = pairs.filter((p) => p.status === 'merged')

  if (mergedPairs.length === 0) return 0

  // For each merged pair, delete the second row (rowB)
  // This is a simplified merge - in production you might want to merge values
  let deletedCount = 0

  for (const pair of mergedPairs) {
    const keyValueB = pair.rowB[keyColumn]
    if (keyValueB !== null && keyValueB !== undefined) {
      try {
        await query(
          `DELETE FROM "${tableName}" WHERE "${keyColumn}" = '${String(keyValueB).replace(/'/g, "''")}'`
        )
        deletedCount++
      } catch (e) {
        console.warn('Could not delete row:', e)
      }
    }
  }

  return deletedCount
}
