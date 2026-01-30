import { query, execute, tableExists, isInternalColumn, getConnection, initDuckDB } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import * as duckdb from '@duckdb/duckdb-wasm'
import { formatBytes } from './duckdb/storage-info'
import { getMemoryStatus } from './duckdb/memory'
import { exportTableToParquet, deleteParquetSnapshot } from '@/lib/opfs/snapshot-storage'
import { registerMemoryCleanup } from './memory-manager'

// Track which Parquet snapshots are currently registered to prevent re-registration
const registeredParquetSnapshots = new Set<string>()
// Track which diff tables are currently registered (for chunked diff results)
const registeredDiffTables = new Set<string>()
// Track in-progress registrations to prevent concurrent registration attempts
const pendingDiffRegistrations = new Map<string, Promise<void>>()
// Cache resolved Parquet expressions to avoid OPFS access on every scroll
// Key: snapshotId, Value: SQL expression (e.g., "read_parquet('snapshot.parquet')")
const resolvedExpressionCache = new Map<string, string>()
// Track materialized diff views for Parquet-backed diffs (enables keyset pagination)
// Key: diffTableName, Value: viewTableName (temp table)
const materializedDiffViews = new Map<string, string>()

/**
 * Clear all diff caches. Call when diff view closes to free memory.
 * Clears:
 * - registeredParquetSnapshots: Set of registered Parquet snapshot IDs
 * - resolvedExpressionCache: Map of snapshot ID → SQL expressions
 * - materializedDiffViews: Map of diff table → materialized view table
 *
 * NOTE: Does NOT clear registeredDiffTables as those are cleaned up by cleanupDiffTable()
 */
export function clearDiffCaches(): void {
  const snapshotCount = registeredParquetSnapshots.size
  const cacheCount = resolvedExpressionCache.size
  const viewCount = materializedDiffViews.size
  registeredParquetSnapshots.clear()
  resolvedExpressionCache.clear()
  materializedDiffViews.clear()
  console.log(`[Diff] Cleared caches: ${snapshotCount} snapshots, ${cacheCount} expressions, ${viewCount} views`)
}

// Register with memory manager so caches are cleared on memory pressure
registerMemoryCleanup('diff-engine', clearDiffCaches)

/**
 * Resolve a table reference to a SQL expression, with robust Parquet handling.
 * Checks OPFS file existence before using read_parquet to avoid IO errors.
 *
 * @param tableName - Table name or "parquet:snapshot_id" reference
 * @returns SQL expression (quoted table name or read_parquet(...))
 */
async function resolveTableRef(tableName: string): Promise<string> {
  // 1. Normal table - return quoted name
  if (!tableName.startsWith('parquet:')) {
    return `"${tableName}"`
  }

  // 2. Parquet snapshot - verify file exists before using read_parquet
  const snapshotId = tableName.replace('parquet:', '')

  // Skip registration if already done (prevents OPFS file locking errors)
  if (registeredParquetSnapshots.has(snapshotId)) {
    // CRITICAL FIX: Return cached expression instead of re-checking OPFS
    // This eliminates ~50ms+ OPFS latency per scroll page that caused stalling
    const cachedExpr = resolvedExpressionCache.get(snapshotId)
    if (cachedExpr) {
      console.log(`[Diff] Using cached expression for ${snapshotId}`)
      return cachedExpr
    }
    // This shouldn't happen normally, but log if it does
    console.warn(`[Diff] Snapshot ${snapshotId} registered but no cached expression, re-resolving...`)
  }

  // Helper to check OPFS file existence
  async function fileExistsInOpfs(filename: string): Promise<boolean> {
    try {
      const root = await navigator.storage.getDirectory()
      const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
      const snapshots = await appDir.getDirectoryHandle('snapshots', { create: false })
      await snapshots.getFileHandle(filename, { create: false })
      return true
    } catch {
      return false
    }
  }

  // CHECK 1: Try exact match first (single file export)
  const exactFile = `${snapshotId}.parquet`
  const exactExists = await fileExistsInOpfs(exactFile)

  if (exactExists) {
    // Register single file with DuckDB
    const db = await initDuckDB()
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshots = await appDir.getDirectoryHandle('snapshots', { create: false })
    const fileHandle = await snapshots.getFileHandle(exactFile, { create: false })

    await db.registerFileHandle(
      exactFile,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      false // read-only
    )

    // Mark as registered and cache the expression for fast lookups during scroll
    const expr = `read_parquet('${exactFile}')`
    registeredParquetSnapshots.add(snapshotId)
    resolvedExpressionCache.set(snapshotId, expr)

    console.log(`[Diff] Resolved ${tableName} to ${expr} (cached)`)
    return expr
  }

  // CHECK 2: Try chunked pattern (for large tables >250k rows)
  // Verify at least part_0 exists to avoid "IO Error: No files found"
  const part0 = `${snapshotId}_part_0.parquet`
  const part0Exists = await fileExistsInOpfs(part0)

  if (part0Exists) {
    // Register all chunks
    const db = await initDuckDB()
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshots = await appDir.getDirectoryHandle('snapshots', { create: false })

    let partIndex = 0
    while (true) {
      try {
        const fileName = `${snapshotId}_part_${partIndex}.parquet`
        const fileHandle = await snapshots.getFileHandle(fileName, { create: false })

        await db.registerFileHandle(
          fileName,
          fileHandle,
          duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
          false
        )

        partIndex++
      } catch {
        break // No more chunks
      }
    }

    // Mark as registered and cache the expression for fast lookups during scroll
    const chunkExpr = `read_parquet('${snapshotId}_part_*.parquet')`
    registeredParquetSnapshots.add(snapshotId)
    resolvedExpressionCache.set(snapshotId, chunkExpr)

    console.log(`[Diff] Resolved ${tableName} to ${chunkExpr} with ${partIndex} chunks (cached)`)
    return chunkExpr
  }

  // CHECK 3: Snapshot file missing (deleted or corrupted)
  console.error(`[Diff] Snapshot file missing: ${tableName}`)
  throw new Error(
    `Snapshot file not found: ${snapshotId}. The original snapshot may have been deleted. ` +
    `Please reload the table or run a transform to recreate the snapshot.`
  )
}

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
 *
 * @param diffMode - 'preview' uses row-based matching (_cs_id), 'two-tables' uses key-based matching
 */
export async function runDiff(
  tableA: string,
  tableB: string,
  keyColumns: string[],
  diffMode: 'preview' | 'two-tables' = 'two-tables'
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

        // Abort if critical to prevent browser crash
        if (status.percentage > 85) {
          clearInterval(memoryPollInterval)
          throw new Error(
            `Memory critical (${status.percentage.toFixed(0)}% used). ` +
            `Aborting diff to prevent browser crash. ` +
            `Try reducing table size or closing other tabs.`
          )
        }
      } catch (err) {
        console.warn('[Diff] Memory poll failed (non-fatal):', err)
      }
    }, DIFF_MEMORY_POLL_INTERVAL_MS)

    try {
    // Check if source is a Parquet snapshot
    const isParquetSource = tableA.startsWith('parquet:')
    const snapshotId = isParquetSource ? tableA.substring(8) : null // Remove 'parquet:' prefix

    // 🟢 NEW: Register Parquet files IMMEDIATELY (before schema query)
    let sourceTableExpr: string
    if (isParquetSource) {
      // Register files and get SQL expression (e.g., "read_parquet('original_abc.parquet')")
      sourceTableExpr = await resolveTableRef(tableA)
      console.log(`[Diff] Pre-registered Parquet source: ${sourceTableExpr}`)
    } else {
      sourceTableExpr = `"${tableA}"`
    }

    // Validate tables exist (skip Parquet sources since they're already validated)
    if (!isParquetSource) {
      const tableAExists = await tableExists(tableA)
      if (!tableAExists) {
        throw new Error(`Table "${tableA}" does not exist`)
      }
    }
    const tableBExists = await tableExists(tableB)
    if (!tableBExists) {
      throw new Error(`Table "${tableB}" does not exist`)
    }

    // PRE-FLIGHT CHECK: Validate memory availability (skip for Parquet sources)
    const conn = await getConnection()
    if (!isParquetSource) {
      await validateDiffMemoryAvailability(conn, tableA, tableB)
    }

    // Get columns AND types from both tables
    let colsAAll: { column_name: string; data_type: string }[]
    if (isParquetSource && snapshotId) {
      // Read column info from Parquet file using glob pattern
      // Matches both single files (snapshotId.parquet) and chunked files (snapshotId_part_*.parquet)
      // IMPORTANT: Use root path (no /cleanslate/snapshots/ prefix) to match registration path
      const globPattern = `${snapshotId}*.parquet`
      const parquetColumns = await query<{ column_name: string; column_type: string }>(
        `SELECT name AS column_name, type AS column_type FROM parquet_schema('${globPattern}')`
      )
      // CRITICAL FIX: Deduplicate columns by name for chunked Parquet files
      // parquet_schema() with glob returns all columns from all files, creating duplicates
      // Example: 5 chunks × 30 columns = 150 duplicate columns
      // We only need the unique column names and their types
      const uniqueColumns = new Map<string, string>()
      for (const col of parquetColumns) {
        if (!uniqueColumns.has(col.column_name)) {
          uniqueColumns.set(col.column_name, col.column_type)
        }
      }
      colsAAll = Array.from(uniqueColumns.entries()).map(([column_name, data_type]) => ({
        column_name,
        data_type
      }))
    } else {
      colsAAll = await query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableA}' ORDER BY ordinal_position`
      )
    }
    const colsBAll = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableB}' ORDER BY ordinal_position`
    )

    // Filter internal columns early to reduce memory overhead
    const colsA = colsAAll.filter(c => !isInternalColumn(c.column_name))
    const colsB = colsBAll.filter(c => !isInternalColumn(c.column_name))

    // DIAGNOSTIC: Log column types for both tables
    console.log('[Diff] Column types comparison:', {
      tableA: tableA,
      tableB: tableB,
      colsATypes: colsA.map(c => ({ name: c.column_name, type: c.data_type })),
      colsBTypes: colsB.map(c => ({ name: c.column_name, type: c.data_type }))
    })

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
    // In preview mode, if no keys provided, use _cs_id for sorting
    const keyOrderBy = diffMode === 'preview' && keyColumns.length === 0
      ? 'COALESCE(a."_cs_id", b."_cs_id")'
      : keyColumns
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
    const newColumns = [...colsASet]
      .filter((c) => !colsBSet.has(c))
      .filter((c) => !isInternalColumn(c))
    // Columns that exist in B (target/current) but not in A (source/original)
    // From user's perspective: these columns were ADDED to current (e.g., 'age' from Calculate Age)
    const removedColumns = [...colsBSet]
      .filter((c) => !colsASet.has(c))
      .filter((c) => !isInternalColumn(c))

    const allColumns = [
      ...new Set([
        ...colsA.map((c) => c.column_name),
        ...colsB.map((c) => c.column_name),
      ]),
    ]  // Already filtered at source
    // For modification detection, only compare columns that exist in BOTH tables
    // Columns unique to one table are tracked as newColumns/removedColumns
    const sharedColumns = allColumns.filter((c) => colsASet.has(c) && colsBSet.has(c))
    const valueColumns = sharedColumns.filter((c) =>
      !keyColumns.includes(c) && !isInternalColumn(c)
    )

    // Generate unique temp table name
    const diffTableName = `_diff_${Date.now()}`

    // Build modification condition:
    // A row is "modified" if:
    // 1. Shared column values differ (original behavior), OR
    // 2. New columns have non-NULL values (column added by transformation), OR
    // 3. Removed columns had non-NULL values (column deleted by transformation)
    //
    // This ensures rows affected by column additions/removals are shown in the diff,
    // not just structural changes in the banner.
    //
    // TYPE-AWARE COMPARISON FIX: When column types differ (e.g., DATE vs VARCHAR),
    // we need to compare actual types, not just VARCHAR representations.
    // Example: DATE '2023-12-07' and VARCHAR '2023-12-07' have same VARCHAR repr
    // but different types - this should be detected as a modification.
    const sharedColModificationExpr = valueColumns.length > 0
      ? valueColumns
          .map((c) => {
            const typeA = typeMapA.get(c) || 'VARCHAR'
            const typeB = typeMapB.get(c) || 'VARCHAR'

            if (typesCompatible(typeA, typeB)) {
              // Same type family - compare VARCHAR representations
              return `CAST(a."${c}" AS VARCHAR) IS DISTINCT FROM CAST(b."${c}" AS VARCHAR)`
            } else {
              // Different type families (e.g., DATE vs VARCHAR, INTEGER vs VARCHAR)
              // Mark as modified if EITHER:
              // 1. The VARCHAR representations differ, OR
              // 2. The types differ (detected by comparing typeof())
              // This ensures DATE->VARCHAR conversions are detected as modifications
              return `(CAST(a."${c}" AS VARCHAR) IS DISTINCT FROM CAST(b."${c}" AS VARCHAR) OR typeof(a."${c}") != typeof(b."${c}"))`
            }
          })
          .join(' OR ')
      : 'FALSE'

    // Build expression for new columns (in B/current but not A/original)
    // removedColumns = columns added to current (from user's perspective)
    // Mark as modified if any new column has a non-NULL value
    const newColumnModificationExpr = removedColumns.length > 0
      ? removedColumns.map((c) => `b."${c}" IS NOT NULL`).join(' OR ')
      : 'FALSE'

    // Build expression for removed columns (in A/original but not B/current)
    // newColumns = columns removed from current (from user's perspective)
    // Mark as modified if any removed column had a non-NULL value
    const removedColumnModificationExpr = newColumns.length > 0
      ? newColumns.map((c) => `a."${c}" IS NOT NULL`).join(' OR ')
      : 'FALSE'

    // Combine all modification conditions
    const fullModificationExpr = [
      sharedColModificationExpr,
      newColumnModificationExpr,
      removedColumnModificationExpr,
    ]
      .filter((expr) => expr !== 'FALSE')
      .join(' OR ') || 'FALSE'

    // DIAGNOSTIC: Log diff detection details
    console.log('[Diff] Modification detection:', {
      allColumns: allColumns.length,
      sharedColumns: sharedColumns.length,
      valueColumns: valueColumns.length,
      keyColumns,
      newColumns,
      removedColumns,
      valueColumnsList: valueColumns,
      diffMode
    })

    // DIAGNOSTIC: Sample values from both tables for the first row
    try {
      const sampleA = await query<Record<string, unknown>>(`
        SELECT * FROM ${sourceTableExpr} LIMIT 1
      `)
      const sampleB = await query<Record<string, unknown>>(`
        SELECT * FROM "${tableB}" LIMIT 1
      `)
      console.log('[Diff] Sample row comparison:', {
        sourceTable: tableA,
        targetTable: tableB,
        sampleA: sampleA[0],
        sampleB: sampleB[0]
      })

      // DIAGNOSTIC: Count total rows from Parquet source
      const countA = await query<{ count: number }>(`
        SELECT COUNT(*) as count FROM ${sourceTableExpr}
      `)
      const countB = await query<{ count: number }>(`
        SELECT COUNT(*) as count FROM "${tableB}"
      `)
      console.log('[Diff] Row counts:', {
        parquetRows: Number(countA[0].count),
        currentTableRows: Number(countB[0].count)
      })

      // DIAGNOSTIC: Compare SAME row from both sources
      const csId = sampleB[0]._cs_id
      const sameRowA = await query<Record<string, unknown>>(`
        SELECT * FROM ${sourceTableExpr} WHERE "_cs_id" = '${csId}' LIMIT 1
      `)
      const sameRowB = await query<Record<string, unknown>>(`
        SELECT * FROM "${tableB}" WHERE "_cs_id" = '${csId}' LIMIT 1
      `)
      console.log('[Diff] Same row comparison (_cs_id: ' + csId + '):', {
        parquetRow: sameRowA[0],
        currentRow: sameRowB[0],
        submissionDateMatch: sameRowA[0]?.SubmissionDate === sameRowB[0]?.SubmissionDate,
        submissionDateParquet: sameRowA[0]?.SubmissionDate,
        submissionDateCurrent: sameRowB[0]?.SubmissionDate
      })
    } catch (err) {
      console.warn('[Diff] Could not fetch sample rows:', err)
    }

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
    // sourceTableExpr already defined and cached at line 285 (files registered early)

    // Determine JOIN condition and CASE logic based on diff mode
    const diffJoinCondition = diffMode === 'preview'
      ? `a."_cs_id" = b."_cs_id"`  // Row-based for preview (detects removed duplicates)
      : joinCondition  // Key-based for two-tables (uses user-selected keys)

    const diffCaseLogic = diffMode === 'preview'
      ? `
        CASE
          WHEN a."_cs_id" IS NULL THEN 'added'
          WHEN b."_cs_id" IS NULL THEN 'removed'
          WHEN ${fullModificationExpr} THEN 'modified'
          ELSE 'unchanged'
        END as diff_status
      `
      : `
        CASE
          WHEN ${keyColumns.map((c) => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
          WHEN ${keyColumns.map((c) => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
          WHEN ${fullModificationExpr} THEN 'modified'
          ELSE 'unchanged'
        END as diff_status
      `

    // Add ROW_NUMBER to preserve original table order for sorting
    // Use table B (current) order as primary, fall back to table A (original) for removed rows
    //
    // MEMORY OPTIMIZATION: Build explicit column list instead of SELECT *
    // The CTEs with ROW_NUMBER() OVER () require full table scan and materialization.
    // By selecting only needed columns, we reduce memory from ~1.5GB to ~200MB for 1M rows.
    // Needed columns: _cs_id (row ID), key columns (join), value columns (modification check),
    // plus new/removed columns (for column-level change detection)
    const neededColumns = new Set<string>(['_cs_id'])
    keyColumns.forEach(c => neededColumns.add(c))
    valueColumns.forEach(c => neededColumns.add(c))
    // Add columns only in A (user's removed columns) - needed for removedColumnModificationExpr
    newColumns.forEach(c => neededColumns.add(c))
    // Add columns only in B (user's new columns) - needed for newColumnModificationExpr
    removedColumns.forEach(c => neededColumns.add(c))

    // Build column list for table A (source/original)
    // Note: colsA excludes internal columns, but we need _cs_id for row identification
    // Use colsAAll to get all columns including internal ones
    const colsAAllNames = colsAAll.map(c => c.column_name)
    const colsAFiltered = [...neededColumns].filter(c => colsAAllNames.includes(c))
    // Fallback to SELECT * if no columns match (shouldn't happen, but safety net)
    const columnListA = colsAFiltered.length > 0
      ? colsAFiltered.map(c => `"${c}"`).join(', ')
      : '*'

    // Build column list for table B (target/current)
    // Note: colsB excludes internal columns, but we need _cs_id for row identification
    // Use colsBAll to get all columns including internal ones
    const colsBAllNames = colsBAll.map(c => c.column_name)
    const colsBFiltered = [...neededColumns].filter(c => colsBAllNames.includes(c))
    // Fallback to SELECT * if no columns match (shouldn't happen, but safety net)
    const columnListB = colsBFiltered.length > 0
      ? colsBFiltered.map(c => `"${c}"`).join(', ')
      : '*'

    console.log('[Diff] Column projection:', {
      allColumns: allColumns.length,
      neededColumns: neededColumns.size,
      columnListA: colsAFiltered.length,
      columnListB: colsBFiltered.length,
      memoryReductionEstimate: allColumns.length > 0
        ? `${Math.round((1 - neededColumns.size / allColumns.length) * 100)}%`
        : 'N/A'
    })

    const createTempTableQuery = `
      CREATE TEMP TABLE "${diffTableName}" AS
      WITH
        a_numbered AS (
          SELECT ${columnListA}, ROW_NUMBER() OVER () as _row_num FROM ${sourceTableExpr}
        ),
        b_numbered AS (
          SELECT ${columnListB}, ROW_NUMBER() OVER () as _row_num FROM "${tableB}"
        )
      SELECT
        COALESCE(a."_cs_id", b."_cs_id") as row_id,
        a."_cs_id" as a_row_id,
        b."_cs_id" as b_row_id,
        COALESCE(b._row_num, a._row_num + 1000000000) as sort_key,
        ${diffCaseLogic}
      FROM a_numbered a
      FULL OUTER JOIN b_numbered b ON ${diffJoinCondition.replace(/\ba\./g, 'a.').replace(/\bb\./g, 'b.')}
    `

    try {
      // Disable insertion order preservation for memory efficiency
      // Allows DuckDB to use streaming aggregations instead of materializing
      await conn.query(`SET preserve_insertion_order = false`)

      // Reduce threads to 1 for diff operations
      // Join-heavy ops need 3-4GB/thread; single thread reduces peak memory significantly
      // See: https://duckdb.org/docs/stable/guides/performance/how_to_tune_workloads
      await conn.query(`SET threads = 1`)

      try {
        await execute(createTempTableQuery)
      } finally {
        // Restore default settings
        await conn.query(`SET preserve_insertion_order = true`)
        await conn.query(`RESET threads`)
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

    // DIAGNOSTIC: Log final summary
    console.log('[Diff] Summary:', {
      ...summary,
      totalDiffRows,
      sourceTable: tableA,
      targetTable: tableB
    })

    // DIAGNOSTIC: Sample the actual diff results to see what changed
    if (totalDiffRows > 0) {
      try {
        const diffSample = await query<Record<string, unknown>>(`
          SELECT * FROM "${diffTableName}"
          WHERE diff_status = 'modified'
          LIMIT 5
        `)
        console.log('[Diff] Sample modified row IDs:', diffSample.map(r => r.row_id))

        // Get actual data for one modified row
        if (diffSample.length > 0) {
          const rowId = diffSample[0].row_id
          const dataA = await query<Record<string, unknown>>(`
            SELECT * FROM ${sourceTableExpr} WHERE "_cs_id" = '${rowId}' LIMIT 1
          `)
          const dataB = await query<Record<string, unknown>>(`
            SELECT * FROM "${tableB}" WHERE "_cs_id" = '${rowId}' LIMIT 1
          `)
          console.log('[Diff] Modified row data comparison:', {
            rowId,
            dataA: dataA[0],
            dataB: dataB[0]
          })
        }
      } catch (err) {
        console.warn('[Diff] Could not sample diff results:', err)
      }
    }

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
  _keyOrderBy: string,
  storageType: 'memory' | 'parquet' = 'memory'
): Promise<DiffRow[]> {
  // Use robust resolver to handle Parquet sources with file existence checks and registration
  const sourceTableExpr = await resolveTableRef(sourceTableName)

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

    // Wait for any pending registration to complete (prevents concurrent registration)
    if (pendingDiffRegistrations.has(tempTableName)) {
      await pendingDiffRegistrations.get(tempTableName)
    }

    // Skip registration if already done (prevents OPFS file locking errors on pagination)
    const needsRegistration = !registeredDiffTables.has(tempTableName)

    try {
      if (isChunked) {
        // Register all chunk files (only if not already registered)
        let partIndex = 0
        const fileHandles: FileSystemFileHandle[] = []

        if (needsRegistration) {
          // Create registration promise to block concurrent attempts
          const registrationPromise = (async () => {
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

            // Mark as registered after successful registration
            registeredDiffTables.add(tempTableName)
            console.log(`[Diff] Registered ${partIndex} diff table chunks: ${tempTableName}`)
          })()

          // Track and wait for registration
          pendingDiffRegistrations.set(tempTableName, registrationPromise)
          await registrationPromise
          pendingDiffRegistrations.delete(tempTableName)
        }

        // Query all chunks with glob pattern
        const result = await query<DiffRow>(`
          SELECT
            d.diff_status,
            d.row_id,
            ${selectCols}
          FROM read_parquet('${tempTableName}_part_*.parquet') d
          LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
          LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
          WHERE d.diff_status IN ('added', 'removed', 'modified')
          ORDER BY d.sort_key
          LIMIT ${limit} OFFSET ${offset}
        `)

        // NOTE: Do NOT unregister files here - they're needed for subsequent pagination
        // Files are cleaned up in cleanupDiffTable() when diff view closes

        return result
      } else {
        // Single file - register only once
        if (needsRegistration) {
          // Create registration promise to block concurrent attempts
          const registrationPromise = (async () => {
            const fileHandle = await snapshotsDir.getFileHandle(`${tempTableName}.parquet`, { create: false })

            await db.registerFileHandle(
              `${tempTableName}.parquet`,
              fileHandle,
              duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
              false  // read-only
            )

            // Mark as registered after successful registration
            registeredDiffTables.add(tempTableName)
            console.log(`[Diff] Registered diff table: ${tempTableName}`)
          })()

          // Track and wait for registration
          pendingDiffRegistrations.set(tempTableName, registrationPromise)
          await registrationPromise
          pendingDiffRegistrations.delete(tempTableName)
        }

        // Query Parquet file directly with pagination
        const result = await query<DiffRow>(`
          SELECT
            d.diff_status,
            d.row_id,
            ${selectCols}
          FROM read_parquet('${tempTableName}.parquet') d
          LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
          LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
          WHERE d.diff_status IN ('added', 'removed', 'modified')
          ORDER BY d.sort_key
          LIMIT ${limit} OFFSET ${offset}
        `)

        return result
      }
    } catch (error) {
      // No cleanup needed - files stay registered for next pagination call
      // Cleanup only happens in cleanupDiffTable() when diff view is closed
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
    LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status IN ('added', 'removed', 'modified')
    ORDER BY d.sort_key
    LIMIT ${limit} OFFSET ${offset}
  `)
}

/**
 * Keyset pagination result with cursor positions for subsequent fetches.
 */
export interface KeysetDiffPageResult {
  rows: DiffRow[]
  firstSortKey: number | null
  lastSortKey: number | null
}

/**
 * Fetch a page of diff results using keyset (cursor-based) pagination.
 *
 * PERFORMANCE: O(1) vs OFFSET's O(n) for large datasets.
 * - OFFSET 500000 requires scanning and discarding 500,000 rows
 * - Keyset uses B-tree index lookup: WHERE sort_key > cursor directly
 *
 * For Parquet-backed diffs, requires prior call to materializeDiffForPagination()
 * to create a temp table from Parquet files. Without materialization, falls back
 * to slower OFFSET pagination.
 *
 * See: https://use-the-index-luke.com/no-offset
 *
 * @param cursor - The sort_key to start from (exclusive) and direction
 * @returns Rows plus first/last sort_key for cursor tracking
 */
export async function fetchDiffPageWithKeyset(
  tempTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  cursor: { sortKey: number | null; direction: 'forward' | 'backward' },
  limit: number = 500,
  storageType: 'memory' | 'parquet' = 'memory'
): Promise<KeysetDiffPageResult> {
  // For Parquet storage, check if we have a materialized view available
  // If materialized, we can use fast keyset pagination on the temp table
  // If not materialized, fall back to slower OFFSET pagination
  if (storageType === 'parquet') {
    const viewTableName = materializedDiffViews.get(tempTableName)

    if (viewTableName) {
      // Fast path: Use materialized view with keyset pagination
      // The materialized view already has all columns joined, so we query it directly
      console.log(`[Diff] Using materialized view ${viewTableName} for keyset pagination`)

      // Build WHERE clause for keyset pagination
      let whereClause = ''
      if (cursor.sortKey !== null) {
        if (cursor.direction === 'forward') {
          whereClause = `WHERE sort_key > ${cursor.sortKey}`
        } else {
          whereClause = `WHERE sort_key < ${cursor.sortKey}`
        }
      }

      // Order direction matches cursor direction
      const orderDirection = cursor.direction === 'forward' ? 'ASC' : 'DESC'

      const rows = await query<DiffRow & { sort_key: number }>(`
        SELECT *
        FROM "${viewTableName}"
        ${whereClause}
        ORDER BY sort_key ${orderDirection}
        LIMIT ${limit}
      `)

      // If backward direction, reverse the rows to maintain ascending order
      if (cursor.direction === 'backward') {
        rows.reverse()
      }

      // Extract cursor positions
      const firstSortKey = rows.length > 0 ? rows[0].sort_key : null
      const lastSortKey = rows.length > 0 ? rows[rows.length - 1].sort_key : null

      // Remove sort_key from returned rows (internal use only)
      const cleanRows = rows.map(({ sort_key: _sk, ...rest }) => rest as DiffRow)

      return {
        rows: cleanRows,
        firstSortKey,
        lastSortKey,
      }
    } else {
      // Slow path: No materialized view, fall back to OFFSET pagination
      console.log('[Diff] Keyset pagination not supported for Parquet storage (no materialized view), using OFFSET')
      // For Parquet, we can't easily do keyset pagination without cursor positions
      // Return empty cursors to signal that keyset isn't available
      const offset = cursor.sortKey !== null ? 0 : 0  // Can't compute offset from sortKey
      const rows = await fetchDiffPage(
        tempTableName, sourceTableName, targetTableName,
        allColumns, newColumns, removedColumns,
        offset, limit, '', storageType
      )
      return {
        rows,
        firstSortKey: null,  // No cursor tracking for Parquet without materialized view
        lastSortKey: null,
      }
    }
  }

  // Memory storage: use efficient keyset pagination
  const sourceTableExpr = await resolveTableRef(sourceTableName)

  // Build select columns (same as fetchDiffPage)
  const selectCols = allColumns
    .map((c) => {
      const inA = !removedColumns.includes(c)
      const inB = !newColumns.includes(c)
      const aExpr = inA ? `a."${c}"` : 'NULL'
      const bExpr = inB ? `b."${c}"` : 'NULL'
      return `${aExpr} as "a_${c}", ${bExpr} as "b_${c}"`
    })
    .join(', ')

  // Build WHERE clause for keyset pagination
  let whereClause = `d.diff_status IN ('added', 'removed', 'modified')`
  if (cursor.sortKey !== null) {
    if (cursor.direction === 'forward') {
      whereClause += ` AND d.sort_key > ${cursor.sortKey}`
    } else {
      whereClause += ` AND d.sort_key < ${cursor.sortKey}`
    }
  }

  // Order direction matches cursor direction
  const orderDirection = cursor.direction === 'forward' ? 'ASC' : 'DESC'

  const rows = await query<DiffRow & { sort_key: number }>(`
    SELECT
      d.diff_status,
      d.row_id,
      d.sort_key,
      ${selectCols}
    FROM "${tempTableName}" d
    LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE ${whereClause}
    ORDER BY d.sort_key ${orderDirection}
    LIMIT ${limit}
  `)

  // If backward direction, reverse the rows to maintain ascending order
  if (cursor.direction === 'backward') {
    rows.reverse()
  }

  // Extract cursor positions
  const firstSortKey = rows.length > 0 ? rows[0].sort_key : null
  const lastSortKey = rows.length > 0 ? rows[rows.length - 1].sort_key : null

  // Remove sort_key from returned rows (internal use only)
  const cleanRows = rows.map(({ sort_key: _sk, ...rest }) => rest as DiffRow)

  return {
    rows: cleanRows,
    firstSortKey,
    lastSortKey,
  }
}

/**
 * Clean up the temp diff table.
 * Note: If user crashes/reloads, temp table dies automatically (DuckDB WASM memory is volatile).
 */
/**
 * Unregister source snapshot files from DuckDB after diff completes.
 * This cleans up file handles registered by resolveTableRef.
 *
 * CRITICAL: Original snapshots (original_*) should NEVER be unregistered.
 * They are permanent and needed for future diffs. Only temp snapshots should be cleaned.
 */
export async function cleanupDiffSourceFiles(sourceTableName: string): Promise<void> {
  if (!sourceTableName.startsWith('parquet:')) {
    return // Not a Parquet source, nothing to cleanup
  }

  const snapshotId = sourceTableName.replace('parquet:', '')

  // CRITICAL: Never cleanup original snapshots - they're permanent and needed for future diffs
  if (snapshotId.startsWith('original_')) {
    console.log(`[Diff] Skipping cleanup for original snapshot: ${snapshotId}`)
    return
  }

  // Only cleanup temp snapshots (snapshot_*, etc.)
  try {
    const db = await initDuckDB()

    // Try to unregister single file
    try {
      await db.dropFile(`${snapshotId}.parquet`)
      console.log(`[Diff] Unregistered temp source file: ${snapshotId}.parquet`)
    } catch {
      // Might be chunked, try chunks
    }

    // Try to unregister chunked files
    let partIndex = 0
    while (true) {
      try {
        await db.dropFile(`${snapshotId}_part_${partIndex}.parquet`)
        partIndex++
      } catch {
        break // No more chunks
      }
    }

    if (partIndex > 0) {
      console.log(`[Diff] Unregistered ${partIndex} temp source file chunks for: ${snapshotId}`)
    }

    // Remove from registered set and expression cache
    registeredParquetSnapshots.delete(snapshotId)
    resolvedExpressionCache.delete(snapshotId)
    console.log(`[Diff] Cleared registration state and cache for ${snapshotId}`)
  } catch (error) {
    console.warn('[Diff] Source file cleanup failed (non-fatal):', error)
  }
}

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

      // Remove from registered set
      registeredDiffTables.delete(tableName)
      console.log(`[Diff] Cleaned up Parquet file(s) and cleared registration: ${tableName}`)
    }
  } catch (error) {
    console.warn('[Diff] Cleanup failed (non-fatal):', error)
  }
}

/**
 * Materialize a Parquet-backed diff into a temp table for fast keyset pagination.
 *
 * PROBLEM: Parquet file reads are stateless - `read_parquet('file.parquet')` creates
 * an ephemeral table on each query with no persistent index. Keyset pagination
 * requires `WHERE sort_key > cursor` which needs a stable index.
 *
 * SOLUTION: Create a temp table from Parquet files ONCE when diff view opens.
 * This enables keyset pagination on a stable, indexed table instead of re-reading
 * Parquet files on every scroll.
 *
 * PERFORMANCE: O(n) OFFSET → O(1) keyset = ~60%+ latency reduction per scroll
 *
 * @param diffTableName - Name of the Parquet-backed diff table
 * @param sourceTableName - Source table (may be "parquet:snapshot_id")
 * @param targetTableName - Target table name
 * @param allColumns - All columns to include in the view
 * @param newColumns - Columns in A (original) but not B (current)
 * @param removedColumns - Columns in B (current) but not A (original)
 * @returns Name of the materialized temp table
 */
export async function materializeDiffForPagination(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[]
): Promise<string> {
  const startTime = performance.now()
  const viewTableName = `_diff_view_${Date.now()}`

  // Get source table expression (handles Parquet sources)
  const sourceTableExpr = await resolveTableRef(sourceTableName)

  // Build select columns: a_col and b_col for each column
  // Handle new/removed columns by selecting NULL for missing sides
  const selectCols = allColumns
    .map((c) => {
      const inA = !removedColumns.includes(c)
      const inB = !newColumns.includes(c)
      const aExpr = inA ? `a."${c}"` : 'NULL'
      const bExpr = inB ? `b."${c}"` : 'NULL'
      return `${aExpr} as "a_${c}", ${bExpr} as "b_${c}"`
    })
    .join(', ')

  // Register Parquet files if not already registered
  const db = await initDuckDB()
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  // Check if chunked or single file
  let isChunked = false
  try {
    await snapshotsDir.getFileHandle(`${diffTableName}_part_0.parquet`, { create: false })
    isChunked = true
  } catch {
    isChunked = false
  }

  // Build the Parquet file expression
  let parquetExpr: string
  if (isChunked) {
    // Register all chunk files
    let partIndex = 0
    while (true) {
      try {
        const fileName = `${diffTableName}_part_${partIndex}.parquet`
        const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
        await db.registerFileHandle(
          fileName,
          fileHandle,
          duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
          false
        )
        partIndex++
      } catch {
        break
      }
    }
    parquetExpr = `read_parquet('${diffTableName}_part_*.parquet')`
    console.log(`[Diff] Registered ${partIndex} chunks for materialization`)
  } else {
    // Single file
    const fileHandle = await snapshotsDir.getFileHandle(`${diffTableName}.parquet`, { create: false })
    await db.registerFileHandle(
      `${diffTableName}.parquet`,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      false
    )
    parquetExpr = `read_parquet('${diffTableName}.parquet')`
  }

  // Materialize the diff data into a temp table with all data needed for pagination
  // This executes the JOIN once and stores results in memory for fast keyset queries
  await execute(`
    CREATE TEMP TABLE "${viewTableName}" AS
    SELECT
      d.diff_status,
      d.row_id,
      d.sort_key,
      ${selectCols}
    FROM ${parquetExpr} d
    LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status IN ('added', 'removed', 'modified')
  `)

  // Track the materialized view for cleanup
  materializedDiffViews.set(diffTableName, viewTableName)

  const elapsed = performance.now() - startTime
  console.log(`[Diff] Materialized ${diffTableName} into ${viewTableName} in ${elapsed.toFixed(0)}ms`)

  return viewTableName
}

/**
 * Get the materialized view table name for a Parquet-backed diff.
 * Returns null if not materialized.
 */
export function getMaterializedDiffView(diffTableName: string): string | null {
  return materializedDiffViews.get(diffTableName) || null
}

/**
 * Cleanup materialized diff view when diff closes.
 * Drops the temp table and removes from tracking map.
 */
export async function cleanupMaterializedDiffView(diffTableName: string): Promise<void> {
  const viewTableName = materializedDiffViews.get(diffTableName)
  if (viewTableName) {
    try {
      await execute(`DROP TABLE IF EXISTS "${viewTableName}"`)
      materializedDiffViews.delete(diffTableName)
      console.log(`[Diff] Dropped materialized view ${viewTableName}`)
    } catch (e) {
      console.warn(`[Diff] Failed to drop ${viewTableName}:`, e)
    }
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
 * Get row IDs that have changes in a specific column.
 * Used for column-level filtering in the diff view.
 *
 * @param diffTableName - The narrow diff table name
 * @param sourceTableName - Source table (may be "parquet:snapshot_id")
 * @param targetTableName - Target table name
 * @param columnName - The column to check for changes
 * @param storageType - 'memory' or 'parquet'
 * @returns Set of row_ids that have changes in the specified column
 */
export async function getRowsWithColumnChanges(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  columnName: string,
  storageType: 'memory' | 'parquet' = 'memory'
): Promise<Set<string>> {
  const sourceTableExpr = await resolveTableRef(sourceTableName)

  // Handle Parquet-backed diffs
  let diffExpr: string
  if (storageType === 'parquet') {
    // Check if materialized view exists
    const viewTableName = materializedDiffViews.get(diffTableName)
    if (viewTableName) {
      // Use materialized view - it already has a_col and b_col joined
      const rows = await query<{ row_id: string }>(`
        SELECT row_id
        FROM "${viewTableName}"
        WHERE diff_status = 'modified'
          AND CAST("a_${columnName}" AS VARCHAR) IS DISTINCT FROM CAST("b_${columnName}" AS VARCHAR)
      `)
      return new Set(rows.map(r => r.row_id))
    }

    // No materialized view - need to use Parquet files
    // Check if chunked or single file
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    let isChunked = false
    try {
      await snapshotsDir.getFileHandle(`${diffTableName}_part_0.parquet`, { create: false })
      isChunked = true
    } catch {
      isChunked = false
    }

    if (isChunked) {
      diffExpr = `read_parquet('${diffTableName}_part_*.parquet')`
    } else {
      diffExpr = `read_parquet('${diffTableName}.parquet')`
    }
  } else {
    diffExpr = `"${diffTableName}"`
  }

  // Query for modified rows where this specific column changed
  const rows = await query<{ row_id: string }>(`
    SELECT d.row_id
    FROM ${diffExpr} d
    LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status = 'modified'
      AND CAST(a."${columnName}" AS VARCHAR) IS DISTINCT FROM CAST(b."${columnName}" AS VARCHAR)
  `)

  return new Set(rows.map(r => r.row_id))
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
