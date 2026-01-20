import { query } from '@/lib/duckdb'
import type { DiffResult } from '@/types'

interface DiffSummary {
  added: number
  removed: number
  modified: number
  unchanged: number
}

export async function runDiff(
  tableA: string,
  tableB: string,
  keyColumns: string[]
): Promise<{ results: DiffResult[]; summary: DiffSummary }> {
  const keyJoinA = keyColumns.map((c) => `a."${c}"`).join(', ')
  const joinCondition = keyColumns
    .map((c) => `a."${c}" = b."${c}"`)
    .join(' AND ')

  // Get columns from both tables
  const colsA = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableA}' ORDER BY ordinal_position`
  )
  const colsB = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableB}' ORDER BY ordinal_position`
  )

  const allColumns = [
    ...new Set([
      ...colsA.map((c) => c.column_name),
      ...colsB.map((c) => c.column_name),
    ]),
  ]
  const valueColumns = allColumns.filter((c) => !keyColumns.includes(c))

  // Build comparison query using FULL OUTER JOIN
  const selectCols = allColumns
    .map(
      (c) =>
        `a."${c}" as "a_${c}", b."${c}" as "b_${c}"`
    )
    .join(', ')

  const diffQuery = `
    SELECT
      ${selectCols},
      CASE
        WHEN ${keyColumns.map((c) => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
        WHEN ${keyColumns.map((c) => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
        WHEN ${
          valueColumns.length > 0
            ? valueColumns.map((c) => `a."${c}" IS DISTINCT FROM b."${c}"`).join(' OR ')
            : 'FALSE'
        } THEN 'modified'
        ELSE 'unchanged'
      END as diff_status
    FROM "${tableA}" a
    FULL OUTER JOIN "${tableB}" b ON ${joinCondition}
    ORDER BY diff_status, ${keyJoinA}
    LIMIT 10000
  `

  const rawResults = await query<Record<string, unknown>>(diffQuery)

  const results: DiffResult[] = rawResults.map((row) => {
    const status = row.diff_status as DiffResult['status']
    const rowA: Record<string, unknown> = {}
    const rowB: Record<string, unknown> = {}
    const modifiedColumns: string[] = []

    allColumns.forEach((col) => {
      rowA[col] = row[`a_${col}`]
      rowB[col] = row[`b_${col}`]

      if (
        status === 'modified' &&
        !keyColumns.includes(col) &&
        row[`a_${col}`] !== row[`b_${col}`]
      ) {
        modifiedColumns.push(col)
      }
    })

    return {
      status,
      rowA: status !== 'added' ? rowA : undefined,
      rowB: status !== 'removed' ? rowB : undefined,
      modifiedColumns: status === 'modified' ? modifiedColumns : undefined,
    }
  })

  // Get summary counts
  const summaryQuery = `
    SELECT
      COUNT(*) FILTER (WHERE diff_status = 'added') as added,
      COUNT(*) FILTER (WHERE diff_status = 'removed') as removed,
      COUNT(*) FILTER (WHERE diff_status = 'modified') as modified,
      COUNT(*) FILTER (WHERE diff_status = 'unchanged') as unchanged
    FROM (
      SELECT
        CASE
          WHEN ${keyColumns.map((c) => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
          WHEN ${keyColumns.map((c) => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
          WHEN ${
            valueColumns.length > 0
              ? valueColumns.map((c) => `a."${c}" IS DISTINCT FROM b."${c}"`).join(' OR ')
              : 'FALSE'
          } THEN 'modified'
          ELSE 'unchanged'
        END as diff_status
      FROM "${tableA}" a
      FULL OUTER JOIN "${tableB}" b ON ${joinCondition}
    )
  `

  const summaryResult = await query<Record<string, unknown>>(summaryQuery)
  const rawSummary = summaryResult[0]

  // Convert BigInt to number (DuckDB returns BigInt for counts)
  const toNum = (val: unknown): number =>
    typeof val === 'bigint' ? Number(val) : Number(val) || 0

  const summary: DiffSummary = {
    added: toNum(rawSummary.added),
    removed: toNum(rawSummary.removed),
    modified: toNum(rawSummary.modified),
    unchanged: toNum(rawSummary.unchanged),
  }

  return { results, summary }
}
