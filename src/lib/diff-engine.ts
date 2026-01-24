import { query, execute, tableExists, isInternalColumn, getConnection, initDuckDB } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import * as duckdb from '@duckdb/duckdb-wasm'
import { formatBytes } from './duckdb/storage-info'
import { getMemoryStatus } from './duckdb/memory'
import { exportTableToParquet, deleteParquetSnapshot } from '@/lib/opfs/snapshot-storage'

// Tiered diff storage: <100k in-memory, ≥100k OPFS Parquet
export const DIFF_TIER2_THRESHOLD = 100_000

// Memory polling during diff creation (2-second intervals)
export const DIFF_MEMORY_POLL_INTERVAL_MS = 2000

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
  /** Storage type: 'memory' for in-memory temp table, 'parquet' for OPFS-backed diff */
  storageType: 'memory' | 'parquet'
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
    // Start memory polling (2-second intervals)
    let pollCount = 0
    const memoryPollInterval = setInterval(async () => {
      try {
        const status = await getMemoryStatus()
        pollCount++
        console.log(
          `[Diff] Memory poll #${pollCount}: ${formatBytes(status.usedBytes)} / ` +
          `${formatBytes(status.limitBytes)} (${status.percentage.toFixed(1)}%)`
        )

        // Warn if critical
        if (status.percentage > 90) {
          console.warn('[Diff] CRITICAL: Memory usage >90% during diff creation!')
        }
      } catch (err) {
        console.warn('[Diff] Memory poll failed (non-fatal):', err)
      }
    }, DIFF_MEMORY_POLL_INTERVAL_MS)

    try {
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

    // Phase 4: Tiered storage - export large diffs to OPFS
    let storageType: 'memory' | 'parquet' = 'memory'

    if (totalDiffRows >= DIFF_TIER2_THRESHOLD) {
      console.log(`[Diff] Large diff (${totalDiffRows.toLocaleString()} rows), exporting to OPFS...`)

      const db = await initDuckDB()
      const conn = await getConnection()

      // Export narrow temp table to Parquet (file handles are dropped inside exportTableToParquet)
      await exportTableToParquet(db, conn, diffTableName, diffTableName)

      // Drop in-memory temp table (free RAM immediately)
      await execute(`DROP TABLE "${diffTableName}"`)

      storageType = 'parquet'
      console.log(`[Diff] Exported to OPFS, freed ~${formatBytes(totalDiffRows * 58)} RAM`)
    }

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
      storageType,
    }
    } finally {
      // CRITICAL: Always clear interval, even on error
      clearInterval(memoryPollInterval)
      console.log(`[Diff] Completed with ${pollCount} memory polls`)
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
 * MEMORY LEAK FIX: Column lists are now passed as parameters instead of querying
 * information_schema on every page. This eliminates Arrow buffer leaks that caused OOM.
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
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  offset: number,
  limit: number = 500,
  keyOrderBy: string,
  storageType: 'memory' | 'parquet' = 'memory'
): Promise<DiffRow[]> {
  // Build select columns: a_col and b_col for each column
  // CRITICAL: Handle new/removed columns by selecting NULL for missing sides
  // - If column only in A (newColumns): select a."col" and NULL for b_col
  // - If column only in B (removedColumns): select NULL for a_col and b."col"
  // - If column in both: select both a."col" and b."col"
  const selectCols = allColumns
    .map((c) => {
      const inA = !removedColumns.includes(c)  // Column exists in A if not in removedColumns
      const inB = !newColumns.includes(c)       // Column exists in B if not in newColumns
      const aExpr = inA ? `a."${c}"` : 'NULL'
      const bExpr = inB ? `b."${c}"` : 'NULL'
      return `${aExpr} as "a_${c}", ${bExpr} as "b_${c}"`
    })
    .join(', ')

  // Handle Parquet-backed diffs
  if (storageType === 'parquet') {
    const db = await initDuckDB()

    // Get OPFS snapshots directory
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    // Check if this is a chunked snapshot (multiple _part_N files) or single file
    let isChunked = false
    try {
      await snapshotsDir.getFileHandle(`${tempTableName}_part_0.parquet`, { create: false })
      isChunked = true
    } catch {
      // Not chunked, try single file
      isChunked = false
    }

    try {
      if (isChunked) {
        // Register all chunk files
        let partIndex = 0
        const fileHandles: FileSystemFileHandle[] = []

        while (true) {
          try {
            const fileName = `${tempTableName}_part_${partIndex}.parquet`
            const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
            fileHandles.push(fileHandle)

            await db.registerFileHandle(
              fileName,
              fileHandle,
              duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
              false  // read-only
            )

            partIndex++
          } catch {
            break // No more chunks
          }
        }

        // Query all chunks with glob pattern
        const result = await query<DiffRow>(`
          SELECT
            d.diff_status,
            d.row_id,
            ${selectCols}
          FROM read_parquet('${tempTableName}_part_*.parquet') d
          LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
          LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
          WHERE d.diff_status IN ('added', 'removed', 'modified')
          ORDER BY d.diff_status, ${keyOrderBy}
          LIMIT ${limit} OFFSET ${offset}
        `)

        // Unregister all chunk files
        for (let i = 0; i < partIndex; i++) {
          await db.dropFile(`${tempTableName}_part_${i}.parquet`)
        }

        return result
      } else {
        // Single file - original logic
        const fileHandle = await snapshotsDir.getFileHandle(`${tempTableName}.parquet`, { create: false })

        // Register for this query only
        await db.registerFileHandle(
          `${tempTableName}.parquet`,
          fileHandle,
          duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
          false  // read-only
        )

        // Query Parquet file directly with pagination
        const result = await query<DiffRow>(`
          SELECT
            d.diff_status,
            d.row_id,
            ${selectCols}
          FROM read_parquet('${tempTableName}.parquet') d
          LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
          LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
          WHERE d.diff_status IN ('added', 'removed', 'modified')
          ORDER BY d.diff_status, ${keyOrderBy}
          LIMIT ${limit} OFFSET ${offset}
        `)

        // Unregister after query
        await db.dropFile(`${tempTableName}.parquet`)

        return result
      }
    } catch (error) {
      // Cleanup on error - unregister any registered files
      if (isChunked) {
        try {
          let partIndex = 0
          while (true) {
            try {
              await db.dropFile(`${tempTableName}_part_${partIndex}.parquet`)
              partIndex++
            } catch {
              break
            }
          }
        } catch {
          // Ignore cleanup errors
        }
      } else {
        try {
          await db.dropFile(`${tempTableName}.parquet`)
        } catch {
          // Ignore cleanup errors
        }
      }
      throw error
    }
  }

  // Original in-memory path (unchanged)
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
export async function cleanupDiffTable(
  tableName: string,
  storageType: 'memory' | 'parquet' = 'memory'
): Promise<void> {
  try {
    // Always try to drop in-memory table
    await execute(`DROP TABLE IF EXISTS "${tableName}"`)

    // If Parquet-backed, delete OPFS file (handles both single and chunked files)
    if (storageType === 'parquet') {
      const db = await initDuckDB()

      // Try to unregister both single and chunked files (one will fail silently)
      try {
        await db.dropFile(`${tableName}.parquet`)  // Unregister single file if active
      } catch {
        // Ignore - file might not be registered or might be chunked
      }

      // Try to unregister chunked files
      let partIndex = 0
      while (true) {
        try {
          await db.dropFile(`${tableName}_part_${partIndex}.parquet`)
          partIndex++
        } catch {
          break  // No more chunks
        }
      }

      // Delete from OPFS (deleteParquetSnapshot handles both single and chunked)
      await deleteParquetSnapshot(tableName)
      console.log(`[Diff] Cleaned up Parquet file(s): ${tableName}`)
    }
  } catch (error) {
    console.warn('[Diff] Cleanup failed (non-fatal):', error)
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
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  keyOrderBy: string,
  chunkSize: number = 10000,
  storageType: 'memory' | 'parquet' = 'memory'
): AsyncGenerator<DiffRow[], void, unknown> {
  let offset = 0
  while (true) {
    const chunk = await fetchDiffPage(
      tempTableName,
      sourceTableName,
      targetTableName,
      allColumns,
      newColumns,
      removedColumns,
      offset,
      chunkSize,
      keyOrderBy,
      storageType
    )
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
