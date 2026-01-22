import { query, execute, tableExists } from '@/lib/duckdb'

export interface DiffSummary {
  added: number
  removed: number
  modified: number
  unchanged: number
}

export interface DiffConfig {
  diffTableName: string
  summary: DiffSummary
  totalDiffRows: number
  allColumns: string[]
  keyColumns: string[]
  keyOrderBy: string
}

/**
 * Raw diff row from the temp table
 * Contains a_col and b_col pairs plus diff_status
 */
export interface DiffRow {
  diff_status: 'added' | 'removed' | 'modified' | 'unchanged'
  [key: string]: unknown
}

/**
 * Run diff comparison using a temp table approach for scalability.
 * The JOIN executes once and results are stored in a temp table for pagination.
 */
export async function runDiff(
  tableA: string,
  tableB: string,
  keyColumns: string[]
): Promise<DiffConfig> {
  // Validate tables exist before running queries
  const [tableAExists, tableBExists] = await Promise.all([
    tableExists(tableA),
    tableExists(tableB),
  ])

  if (!tableAExists) {
    throw new Error(`Table "${tableA}" does not exist`)
  }
  if (!tableBExists) {
    throw new Error(`Table "${tableB}" does not exist`)
  }

  // For querying the temp table (columns are named a_col, b_col)
  // Use COALESCE to handle NULLs from FULL OUTER JOIN
  const keyOrderBy = keyColumns
    .map((c) => `COALESCE("a_${c}", "b_${c}")`)
    .join(', ')
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

  // Build select columns: a_col and b_col for each column
  const selectCols = allColumns
    .map((c) => `a."${c}" as "a_${c}", b."${c}" as "b_${c}"`)
    .join(', ')

  // Generate unique temp table name
  const diffTableName = `_diff_${Date.now()}`

  // Phase 1: Create temp table (JOIN executes once)
  // Include all rows (even unchanged) in case we add "Show Unchanged" toggle later
  const createTempTableQuery = `
    CREATE TEMP TABLE "${diffTableName}" AS
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
  `

  try {
    await execute(createTempTableQuery)
  } catch (error) {
    console.error('Diff temp table creation failed:', error)
    throw new Error(
      `Failed to execute diff comparison. This may occur with very large tables or duplicate key values. ` +
        `Try selecting a more unique key column or reducing the table size.`
    )
  }

  // Phase 2: Summary from temp table (instant - no re-join!)
  const summaryResult = await query<Record<string, unknown>>(`
    SELECT
      COUNT(*) FILTER (WHERE diff_status = 'added') as added,
      COUNT(*) FILTER (WHERE diff_status = 'removed') as removed,
      COUNT(*) FILTER (WHERE diff_status = 'modified') as modified,
      COUNT(*) FILTER (WHERE diff_status = 'unchanged') as unchanged
    FROM "${diffTableName}"
  `)

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

  // Phase 3: Get total non-unchanged count for grid
  const totalDiffRows = summary.added + summary.removed + summary.modified

  return {
    diffTableName,
    summary,
    totalDiffRows,
    allColumns,
    keyColumns,
    keyOrderBy,
  }
}

/**
 * Fetch a page of diff results from the temp table.
 * Uses LIMIT/OFFSET - DuckDB handles this efficiently on 2M rows.
 *
 * Note: We use LIMIT/OFFSET instead of keyset pagination because:
 * - Keyset via _row_num creates gaps when filtering (row 1001 might be first non-unchanged)
 * - DuckDB handles OFFSET efficiently on large datasets
 * - Allows future "Show Unchanged" toggle without re-running diff
 */
export async function fetchDiffPage(
  tempTableName: string,
  offset: number,
  limit: number = 500,
  keyOrderBy: string
): Promise<DiffRow[]> {
  return query<DiffRow>(`
    SELECT * FROM "${tempTableName}"
    WHERE diff_status != 'unchanged'
    ORDER BY diff_status, ${keyOrderBy}
    LIMIT ${limit} OFFSET ${offset}
  `)
}

/**
 * Clean up the temp diff table.
 * Note: If user crashes/reloads, temp table dies automatically (DuckDB WASM memory is volatile).
 */
export async function cleanupDiffTable(tableName: string): Promise<void> {
  try {
    await execute(`DROP TABLE IF EXISTS "${tableName}"`)
  } catch (error) {
    // Ignore errors during cleanup (table might already be gone)
    console.warn('Failed to cleanup diff table:', error)
  }
}

/**
 * Get all diff rows from temp table for export (streaming chunks)
 * Returns an async generator for memory-efficient large exports.
 */
export async function* streamDiffResults(
  tempTableName: string,
  keyOrderBy: string,
  chunkSize: number = 10000
): AsyncGenerator<DiffRow[], void, unknown> {
  let offset = 0
  while (true) {
    const chunk = await fetchDiffPage(tempTableName, offset, chunkSize, keyOrderBy)
    if (chunk.length === 0) break
    yield chunk
    offset += chunkSize
  }
}

/**
 * Get the columns that were modified for a diff row
 */
export function getModifiedColumns(row: DiffRow, allColumns: string[], keyColumns: string[]): string[] {
  if (row.diff_status !== 'modified') return []

  const modified: string[] = []
  for (const col of allColumns) {
    if (keyColumns.includes(col)) continue
    const valA = row[`a_${col}`]
    const valB = row[`b_${col}`]
    // Use string comparison to handle BigInt and other types
    if (String(valA ?? '') !== String(valB ?? '')) {
      modified.push(col)
    }
  }
  return modified
}
