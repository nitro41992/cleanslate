import { query, execute, tableExists, isInternalColumn, getConnection } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { formatBytes } from './duckdb/storage-info'
import { getMemoryStatus } from './duckdb/memory'

/**
 * STRICT type compatibility check for DuckDB.
 * Only returns true for types that DuckDB can safely compare without precision loss.
 * For diff accuracy, we fallback to VARCHAR for any mixed types.
 */
function typesCompatible(typeA: string, typeB: string): boolean {
  const a = typeA.toUpperCase()
  const b = typeB.toUpperCase()

  // Exact match - always safe
  if (a === b) return true

  // Pure INTEGER family - safe to compare
  const intTypes = [
    'TINYINT',
    'SMALLINT',
    'INTEGER',
    'BIGINT',
    'HUGEINT',
    'UTINYINT',
    'USMALLINT',
    'UINTEGER',
    'UBIGINT',
    'INT',
    'INT4',
    'INT8',
  ]
  const aIsInt = intTypes.some((t) => a.includes(t))
  const bIsInt = intTypes.some((t) => b.includes(t))
  if (aIsInt && bIsInt) return true

  // Pure FLOAT family - safe to compare
  const floatTypes = ['FLOAT', 'DOUBLE', 'REAL']
  const aIsFloat = floatTypes.some((t) => a.includes(t))
  const bIsFloat = floatTypes.some((t) => b.includes(t))
  if (aIsFloat && bIsFloat) return true

  // VARCHAR family - safe to compare
  const stringTypes = ['VARCHAR', 'TEXT', 'STRING', 'CHAR']
  const aIsString = stringTypes.some((t) => a.includes(t))
  const bIsString = stringTypes.some((t) => b.includes(t))
  if (aIsString && bIsString) return true

  // IMPORTANT: Do NOT mix INTEGER and FLOAT - precision issues
  // IMPORTANT: Do NOT mix DATE and TIMESTAMP - implicit cast can fail
  // For diff accuracy, fallback to VARCHAR for any mixed types
  return false
}

export interface DiffSummary {
  added: number
  removed: number
  modified: number
  unchanged: number
}

export interface DiffConfig {
  diffTableName: string
  sourceTableName: string
  targetTableName: string
  summary: DiffSummary
  totalDiffRows: number
  allColumns: string[]
  keyColumns: string[]
  keyOrderBy: string
  /** Columns that exist in table A (source/original) but not in table B (target/current) */
  newColumns: string[]
  /** Columns that exist in table B (target/current) but not in table A (source/original) */
  removedColumns: string[]
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
 * Validate memory availability before attempting large diff operations
 * Prevents OOM by failing fast with actionable error messages
 */
async function validateDiffMemoryAvailability(
  conn: AsyncDuckDBConnection,
  tableA: string,
  tableB: string
): Promise<void> {
  // Get table dimensions
  const sizeQuery = `
    SELECT
      (SELECT COUNT(*) FROM "${tableA}") as rows_a,
      (SELECT COUNT(*) FROM "${tableB}") as rows_b
  `
  const sizeResult = await conn.query(sizeQuery)
  const { rows_a, rows_b } = sizeResult.toArray()[0].toJSON()

  // NEW: Narrow table stores only metadata (row IDs + status)
  // Result rows = max(rows_a, rows_b) - FULL OUTER JOIN produces at most max, not sum
  // Metadata: UUID (16 bytes) + status VARCHAR(10) + 2x UUID for row tracking
  const estimatedRows = Math.max(Number(rows_a), Number(rows_b))
  const metadataBytes = estimatedRows * (16 + 10 + 16 + 16)  // row_id + status + a_row_id + b_row_id
  const summaryQueryBytes = estimatedRows * 20  // Temporary buffers for aggregation
  const estimatedBytes = metadataBytes + summaryQueryBytes

  // Use 2GB fallback to avoid NaN errors from memory detection
  const FALLBACK_LIMIT_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
  let availableBytes = FALLBACK_LIMIT_BYTES

  try {
    const memStatus = await getMemoryStatus()
    if (memStatus.limitBytes > 0 && !isNaN(memStatus.limitBytes)) {
      availableBytes = Math.max(
        memStatus.limitBytes - memStatus.usedBytes,
        FALLBACK_LIMIT_BYTES * 0.3 // Minimum 600MB available
      )
    }
  } catch (err) {
    console.warn('[Diff] Memory status unavailable, using 2GB fallback:', err)
  }

  const threshold = availableBytes * 0.9  // Narrow table uses minimal memory

  if (estimatedBytes > threshold) {
    throw new Error(
      `Diff requires ~${formatBytes(estimatedBytes)} metadata storage but only ${formatBytes(availableBytes)} available.\n\n` +
      `Note: This is just for diff metadata. Actual data is loaded on-demand (500 rows at a time).\n` +
      `Current size: ${Number(rows_a).toLocaleString()} vs ${Number(rows_b).toLocaleString()} rows`
    )
  }
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
  return withDuckDBLock(async () => {
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

    // PRE-FLIGHT CHECK: Validate memory availability
    const conn = await getConnection()
    await validateDiffMemoryAvailability(conn, tableA, tableB)

    // Get columns AND types from both tables
    const colsA = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableA}' ORDER BY ordinal_position`
    )
    const colsB = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableB}' ORDER BY ordinal_position`
    )

    // Build type maps for quick lookup
    const typeMapA = new Map(colsA.map((c) => [c.column_name, c.data_type]))
    const typeMapB = new Map(colsB.map((c) => [c.column_name, c.data_type]))
    const colsASet = new Set(typeMapA.keys())
    const colsBSet = new Set(typeMapB.keys())

    // Prevent internal columns from being used as key columns
    const internalKeyColumns = keyColumns.filter(c => isInternalColumn(c))
    if (internalKeyColumns.length > 0) {
      throw new Error(
        `Internal system columns cannot be used as key columns: ${internalKeyColumns.join(', ')}. ` +
        `Please select different key columns.`
      )
    }

    // Validate key columns exist in BOTH tables (fail fast with helpful error)
    const missingInA = keyColumns.filter((c) => !colsASet.has(c))
    const missingInB = keyColumns.filter((c) => !colsBSet.has(c))

    if (missingInA.length > 0 || missingInB.length > 0) {
      const missingInfo: string[] = []
      if (missingInA.length > 0) {
        missingInfo.push(`Missing in current table: ${missingInA.join(', ')}`)
      }
      if (missingInB.length > 0) {
        missingInfo.push(`Missing in original table: ${missingInB.join(', ')}`)
      }
      throw new Error(
        `Key column(s) not found in both tables. ${missingInfo.join('. ')}. ` +
          `This can happen after renaming columns. Please select different key columns.`
      )
    }

    // Build JOIN condition: only cast if types are incompatible (preserves native performance)
    const joinCondition = keyColumns
      .map((c) => {
        const typeA = typeMapA.get(c) || 'VARCHAR'
        const typeB = typeMapB.get(c) || 'VARCHAR'
        if (typesCompatible(typeA, typeB)) {
          // Native comparison (fast path - 1.8x faster for numeric)
          return `a."${c}" = b."${c}"`
        } else {
          // VARCHAR fallback (safe path - handles type mismatches)
          return `CAST(a."${c}" AS VARCHAR) = CAST(b."${c}" AS VARCHAR)`
        }
      })
      .join(' AND ')

    // Build ORDER BY: only cast if types are incompatible
    const keyOrderBy = keyColumns
      .map((c) => {
        const typeA = typeMapA.get(c)
        const typeB = typeMapB.get(c)
        if (typeA && typeB && typesCompatible(typeA, typeB)) {
          return `COALESCE("a_${c}", "b_${c}")`
        } else {
          return `COALESCE(CAST("a_${c}" AS VARCHAR), CAST("b_${c}" AS VARCHAR))`
        }
      })
      .join(', ')

    // Columns that exist in A (source/original) but not in B (target/current)
    // From user's perspective: these columns were REMOVED from current
    const newColumns = [...colsASet].filter((c) => !colsBSet.has(c))
    // Columns that exist in B (target/current) but not in A (source/original)
    // From user's perspective: these columns were ADDED to current (e.g., 'age' from Calculate Age)
    const removedColumns = [...colsBSet].filter((c) => !colsASet.has(c))

    const allColumns = [
      ...new Set([
        ...colsA.map((c) => c.column_name),
        ...colsB.map((c) => c.column_name),
      ]),
    ]
    // For modification detection, only compare columns that exist in BOTH tables
    // Columns unique to one table are tracked as newColumns/removedColumns
    const sharedColumns = allColumns.filter((c) => colsASet.has(c) && colsBSet.has(c))
    const valueColumns = sharedColumns.filter((c) =>
      !keyColumns.includes(c) && !isInternalColumn(c)
    )

    // Generate unique temp table name
    const diffTableName = `_diff_${Date.now()}`

    // Build modification condition:
    // A row is "modified" ONLY if shared column values differ.
    // This prevents misleading counts like "100k modified" when Calculate Age
    // adds a column - that's a structural change, not a value modification.
    const sharedColModificationExpr = valueColumns.length > 0
      ? valueColumns
          .map((c) => `CAST(a."${c}" AS VARCHAR) IS DISTINCT FROM CAST(b."${c}" AS VARCHAR)`)
          .join(' OR ')
      : 'FALSE'

    // Phase 1: Create NARROW temp table with ONLY metadata (JOIN executes once)
    // CRITICAL OPTIMIZATION: Store only row IDs + status, NOT all column values
    // This reduces memory from ~12 GB to ~26 MB for 1M x 1M rows!
    //
    // Narrow table schema (4 columns instead of 60+):
    // - row_id: COALESCE(a._cs_id, b._cs_id) - universal row identifier
    // - a_row_id: a._cs_id - for JOIN back to table A during pagination
    // - b_row_id: b._cs_id - for JOIN back to table B during pagination
    // - diff_status: 'added' | 'removed' | 'modified' | 'unchanged'
    //
    // Actual column data is fetched on-demand during pagination via LEFT JOIN
    const createTempTableQuery = `
      CREATE TEMP TABLE "${diffTableName}" AS
      SELECT
        COALESCE(a."_cs_id", b."_cs_id") as row_id,
        a."_cs_id" as a_row_id,
        b."_cs_id" as b_row_id,
        CASE
          WHEN ${keyColumns.map((c) => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
          WHEN ${keyColumns.map((c) => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
          WHEN ${sharedColModificationExpr} THEN 'modified'
          ELSE 'unchanged'
        END as diff_status
      FROM "${tableA}" a
      FULL OUTER JOIN "${tableB}" b ON ${joinCondition}
    `

    try {
      // Disable insertion order preservation for memory efficiency
      // Allows DuckDB to use streaming aggregations instead of materializing
      await conn.query(`SET preserve_insertion_order = false`)

      try {
        await execute(createTempTableQuery)
      } finally {
        // Restore default setting
        await conn.query(`SET preserve_insertion_order = true`)
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error('Diff temp table creation failed:', error)

      // Parse DuckDB errors and provide actionable feedback
      if (errMsg.includes('does not have a column') || errMsg.includes('column named')) {
        const match = errMsg.match(/column named "([^"]+)"/) || errMsg.match(/"([^"]+)" does not exist/)
        const colName = match?.[1] || 'unknown'
        throw new Error(
          `Column "${colName}" not found. This can happen after renaming or removing columns. ` +
            `Please select different key columns.`
        )
      }

      if (errMsg.includes('Conversion Error') || errMsg.includes('Could not convert')) {
        throw new Error(
          `Type mismatch between tables. This can happen after cast_type or standardize_date. ` +
            `The comparison will still work but may show all rows as modified.`
        )
      }

      if (errMsg.includes('out of memory') || errMsg.includes('OOM')) {
        throw new Error(
          `Out of memory while comparing tables. Try reducing the table size or selecting fewer columns.`
        )
      }

      // Generic fallback with original error details
      throw new Error(
        `Failed to execute diff comparison: ${errMsg}. ` +
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
    // Note: Column-level changes are shown separately in a banner
    const totalDiffRows = summary.added + summary.removed + summary.modified

    return {
      diffTableName,
      sourceTableName: tableA,
      targetTableName: tableB,
      summary,
      totalDiffRows,
      allColumns,
      keyColumns,
      keyOrderBy,
      newColumns,
      removedColumns,
    }
  })
}

/**
 * Fetch a page of diff results from the narrow temp table.
 * JOINs back to source/target tables to retrieve actual column data on-demand.
 *
 * CRITICAL OPTIMIZATION: Narrow table stores only metadata (row IDs + status).
 * This function fetches visible rows and JOINs to original tables for actual data.
 * Memory per page: ~3 MB (500 rows × 60 cols) vs ~12 GB for full materialized table!
 *
 * Note: We use LIMIT/OFFSET instead of keyset pagination because:
 * - Keyset via _row_num creates gaps when filtering (row 1001 might be first non-unchanged)
 * - DuckDB handles OFFSET efficiently on large datasets
 * - Allows future "Show Unchanged" toggle without re-running diff
 */
export async function fetchDiffPage(
  tempTableName: string,
  sourceTableName: string,
  targetTableName: string,
  offset: number,
  limit: number = 500,
  keyOrderBy: string
): Promise<DiffRow[]> {
  // Get schema info for building SELECT clause
  const conn = await getConnection()
  const colsAResult = await conn.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${sourceTableName}' ORDER BY ordinal_position`
  )
  const colsBResult = await conn.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${targetTableName}' ORDER BY ordinal_position`
  )

  const colsASet = new Set(
    colsAResult.toArray().map(r => {
      const row = r.toJSON() as Record<string, unknown>
      return row.column_name as string
    })
  )
  const colsBSet = new Set(
    colsBResult.toArray().map(r => {
      const row = r.toJSON() as Record<string, unknown>
      return row.column_name as string
    })
  )
  const allColumns = [...new Set([...colsASet, ...colsBSet])]

  // Build select columns: a_col and b_col for each column
  // Use NULL for columns that don't exist in one of the tables
  const selectCols = allColumns
    .map((c) => {
      const aExpr = colsASet.has(c) ? `a."${c}"` : 'NULL'
      const bExpr = colsBSet.has(c) ? `b."${c}"` : 'NULL'
      return `${aExpr} as "a_${c}", ${bExpr} as "b_${c}"`
    })
    .join(', ')

  // JOIN back to original tables using row IDs
  // Only fetch visible rows (500 at a time) to minimize memory usage
  return query<DiffRow>(`
    SELECT
      d.diff_status,
      d.row_id,
      ${selectCols}
    FROM "${tempTableName}" d
    LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status IN ('added', 'removed', 'modified')
    ORDER BY d.diff_status, ${keyOrderBy}
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
  sourceTableName: string,
  targetTableName: string,
  keyOrderBy: string,
  chunkSize: number = 10000
): AsyncGenerator<DiffRow[], void, unknown> {
  let offset = 0
  while (true) {
    const chunk = await fetchDiffPage(tempTableName, sourceTableName, targetTableName, offset, chunkSize, keyOrderBy)
    if (chunk.length === 0) break
    yield chunk
    offset += chunkSize
  }
}

/**
 * Get the columns that were modified for a diff row.
 *
 * Excludes:
 * - Key columns (used for joining, not value comparison)
 * - New columns (exist in current but not original - should show green, not yellow)
 * - Removed columns (exist in original but not current - should show red, not yellow)
 */
export function getModifiedColumns(
  row: DiffRow,
  allColumns: string[],
  keyColumns: string[],
  newColumns: string[] = [],
  removedColumns: string[] = []
): string[] {
  if (row.diff_status !== 'modified') return []

  const modified: string[] = []
  for (const col of allColumns) {
    if (keyColumns.includes(col)) continue
    // Skip columns that are structural additions/deletions
    // New columns should show as "added" (green), not "modified" (yellow)
    if (newColumns.includes(col)) continue
    // Removed columns should show as "removed" (red), not "modified" (yellow)
    if (removedColumns.includes(col)) continue

    const valA = row[`a_${col}`]
    const valB = row[`b_${col}`]
    // Use string comparison to handle BigInt and other types
    if (String(valA ?? '') !== String(valB ?? '')) {
      modified.push(col)
    }
  }
  return modified
}
