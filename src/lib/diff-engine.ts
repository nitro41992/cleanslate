import { query, execute, tableExists, isInternalColumn, getConnection, initDuckDB, CS_ORIGIN_ID_COLUMN, tableHasOriginId } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { formatBytes } from './duckdb/storage-info'
import { getMemoryStatus } from './duckdb/memory'
import { exportTableToSnapshot, importTableFromSnapshot, deleteSnapshot } from '@/lib/opfs/snapshot-storage'
import { registerMemoryCleanup } from './memory-manager'
import { SHARD_SIZE } from '@/lib/constants'
import { getChunkManager } from '@/lib/opfs/chunk-manager'

// Track which snapshots are materialized as temp DuckDB tables to prevent re-loading
const materializedSnapshots = new Set<string>()
// Track which diff tables are currently registered (for chunked diff results)
const registeredDiffTables = new Set<string>()
// Track in-progress registrations to prevent concurrent registration attempts
const pendingDiffRegistrations = new Map<string, Promise<void>>()
// Cache resolved table expressions to avoid OPFS access on every scroll
// Key: snapshotId, Value: SQL expression (quoted temp table name)
const resolvedExpressionCache = new Map<string, string>()
// Track materialized diff views for snapshot-backed diffs (enables keyset pagination)
// Key: diffTableName, Value: viewTableName (temp table)
const materializedDiffViews = new Map<string, string>()

/**
 * Clear all diff caches and DROP materialized temp tables from DuckDB.
 * Call when diff view closes to free memory.
 *
 * Drops temp tables for:
 * - materializedSnapshots → __diff_src_* tables
 * - materializedDiffViews → index tables + views
 *
 * Then clears all module-level tracking state.
 */
export async function clearDiffCaches(): Promise<void> {
  const snapshotCount = materializedSnapshots.size
  const cacheCount = resolvedExpressionCache.size
  const viewCount = materializedDiffViews.size
  const diffTableCount = registeredDiffTables.size
  const pendingCount = pendingDiffRegistrations.size

  // DROP materialized snapshot temp tables before clearing tracking
  for (const snapshotId of materializedSnapshots) {
    try {
      const tempTableName = `__diff_src_${snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')}`
      await execute(`DROP TABLE IF EXISTS "${tempTableName}"`)
    } catch (err) {
      console.warn(`[Diff] Failed to drop temp table for ${snapshotId}:`, err)
    }
  }

  // DROP orphaned diff index tables (from interrupted runDiff operations)
  try {
    await execute('DROP TABLE IF EXISTS __diff_idx_a')
    await execute('DROP TABLE IF EXISTS __diff_idx_b')
  } catch (err) {
    console.warn('[Diff] Failed to drop orphaned index tables:', err)
  }

  // DROP materialized diff view index tables + views
  for (const [, storedValue] of materializedDiffViews) {
    try {
      if (storedValue.includes('|')) {
        const [indexTableName, viewTableName] = storedValue.split('|')
        await execute(`DROP VIEW IF EXISTS "${viewTableName}"`)
        await execute(`DROP TABLE IF EXISTS "${indexTableName}"`)
      } else {
        await execute(`DROP TABLE IF EXISTS "${storedValue}"`)
      }
    } catch (err) {
      console.warn(`[Diff] Failed to drop diff view/index:`, err)
    }
  }

  materializedSnapshots.clear()
  resolvedExpressionCache.clear()
  materializedDiffViews.clear()
  registeredDiffTables.clear()
  pendingDiffRegistrations.clear()
  console.log(`[Diff] Cleared caches (dropped ${snapshotCount} temp tables, ${viewCount} views): ${cacheCount} expressions, ${diffTableCount} diff tables, ${pendingCount} pending`)
}

// Register a lightweight memory cleanup that does NOT destroy active diff state.
// clearDiffCaches() drops materialized source tables and diff indices — if these are
// actively used by the diff view, the view immediately re-materializes them, creating
// a thrash loop (cleanup → reload → memory pressure → cleanup → OOM).
// Instead, only clean up truly stale entries. Active diff data is cleaned up by the
// DiffView lifecycle (cleanupDiffTable, cleanupMaterializedDiffView, cleanupDiffSourceFiles).
registerMemoryCleanup('diff-engine', async () => {
  // Only clear pending registrations (stale in-flight work)
  if (pendingDiffRegistrations.size > 0) {
    pendingDiffRegistrations.clear()
    console.log('[Diff] Memory pressure: cleared pending registrations')
  }
})

/**
 * Resolve a table reference to a SQL expression, with robust snapshot handling.
 * For snapshot references, materializes Arrow IPC data from OPFS into a DuckDB temp table.
 *
 * @param tableName - Table name or "parquet:snapshot_id" reference
 * @returns SQL expression (quoted table name)
 */
async function resolveTableRef(tableName: string): Promise<string> {
  // 1. Normal table - return quoted name
  if (!tableName.startsWith('parquet:')) {
    return `"${tableName}"`
  }

  // 2. Snapshot reference - materialize from Arrow IPC
  const snapshotId = tableName.replace('parquet:', '')

  // Skip materialization if already done
  if (materializedSnapshots.has(snapshotId)) {
    const cachedExpr = resolvedExpressionCache.get(snapshotId)
    if (cachedExpr) {
      console.log(`[Diff] Using cached expression for ${snapshotId}`)
      return cachedExpr
    }
    console.warn(`[Diff] Snapshot ${snapshotId} materialized but no cached expression, re-materializing...`)
  }

  // Materialize Arrow IPC file(s) from OPFS into a DuckDB table
  const tempTableName = `__diff_src_${snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')}`
  const db = await initDuckDB()
  const conn = await getConnection()

  try {
    await importTableFromSnapshot(db, conn, snapshotId, tempTableName)
  } catch (err) {
    console.error(`[Diff] Failed to materialize snapshot ${snapshotId}:`, err)
    throw new Error(
      `Snapshot file not found: ${snapshotId}. The original snapshot may have been deleted. ` +
      `Please reload the table or run a transform to recreate the snapshot.`
    )
  }

  // Cache the quoted table name for fast lookups during scroll
  const expr = `"${tempTableName}"`
  materializedSnapshots.add(snapshotId)
  resolvedExpressionCache.set(snapshotId, expr)

  console.log(`[Diff] Materialized ${tableName} into temp table ${tempTableName} (cached)`)
  return expr
}

// Tiered diff storage: <100k in-memory, ≥100k OPFS Arrow IPC
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
  /** Storage type: 'memory' for in-memory temp table, 'snapshot' for OPFS-backed diff */
  storageType: 'memory' | 'snapshot'
  /** Whether target table (B) had _cs_origin_id column at diff creation time */
  hasOriginIdB: boolean
}

/**
 * Raw diff row from the temp table
 * Contains a_col and b_col pairs plus diff_status
 */
export interface DiffRow {
  diff_status: 'added' | 'removed' | 'modified' | 'unchanged'
  /** Visual row number in the current table (B). NULL for removed rows. */
  b_row_num?: number | null
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
  diffMode: 'preview' | 'two-tables' = 'two-tables',
  onProgress?: (progress: { phase: string; current: number; total: number }) => void
): Promise<DiffConfig> {
  return withDuckDBLock(async () => {
    // Phase 4D: Temporarily dematerialize active table to free ~120MB during diff
    // IMPORTANT: Skip if active table is one of the tables being compared.
    // In preview mode, the active table IS tableB (the diff target).
    // Dematerializing it would DROP the very table we need to JOIN against.
    let dematerializedTable: { tableName: string; tableId: string } | null = null
    try {
      const { dematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
      const { useTableStore } = await import('@/stores/tableStore')
      const activeTable = useTableStore.getState().tables.find(
        t => t.id === useTableStore.getState().activeTableId
      )
      const activeTableInUse = activeTable && (
        activeTable.name === tableB ||
        activeTable.name === tableA
      )
      if (!activeTableInUse) {
        dematerializedTable = await dematerializeActiveTable()
        if (dematerializedTable) {
          onProgress?.({ phase: 'Preparing...', current: 0, total: 0 })
        }
      }
    } catch (err) {
      console.warn('[Diff] Dematerialization skipped:', err)
    }

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
    // Check if source is a snapshot reference
    const isParquetSource = tableA.startsWith('parquet:')

    // For snapshot sources, use ChunkManager for shard-level processing (avoids full materialization).
    // For normal tables, use the table directly.
    let sourceTableExpr: string | null = null  // Only set for non-snapshot sources
    const snapshotId = isParquetSource ? tableA.replace('parquet:', '') : null
    const chunkMgr = isParquetSource ? getChunkManager() : null

    if (isParquetSource) {
      console.log(`[Diff] Using ChunkManager for shard-level snapshot processing: ${snapshotId}`)
    } else {
      sourceTableExpr = `"${tableA}"`
      const tableAExists = await tableExists(tableA)
      if (!tableAExists) {
        throw new Error(`Table "${tableA}" does not exist`)
      }
    }
    const tableBExists = await tableExists(tableB)
    if (!tableBExists) {
      throw new Error(`Table "${tableB}" does not exist`)
    }

    // PRE-FLIGHT CHECK: Validate memory availability (skip for snapshot sources)
    const conn = await getConnection()
    if (!isParquetSource) {
      await validateDiffMemoryAvailability(conn, tableA, tableB)
    }

    // Get columns AND types from both tables
    // For snapshot sources: load shard 0 for schema discovery (25MB vs 500MB+ for full table)
    let colsAAll: { column_name: string; data_type: string }[]
    let shard0Table: string | null = null
    if (isParquetSource) {
      shard0Table = await chunkMgr!.loadShard(snapshotId!, 0)
      colsAAll = await query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${shard0Table}' ORDER BY ordinal_position`
      )
    } else {
      colsAAll = await query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableA}' ORDER BY ordinal_position`
      )
    }
    const colsBAll = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableB}' ORDER BY ordinal_position`
    )

    // Extract column name lists for quick lookup
    // These are used for origin ID check and column list building
    const colsAAllNames = colsAAll.map(c => c.column_name)
    const colsBAllNames = colsBAll.map(c => c.column_name)

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

    // INDEX-FIRST DIFF ALGORITHM
    // Instead of a single massive CREATE TABLE with FULL OUTER JOIN across all columns,
    // we build lightweight ID-only index tables, JOIN them cheaply, then batch-compare
    // only the "potentially modified" rows. Peak memory: ~72 MB instead of ~2 GB.

    // Determine origin ID availability for JOIN logic
    const hasOriginIdA = colsAAllNames.includes(CS_ORIGIN_ID_COLUMN)
    const hasOriginIdB = colsBAllNames.includes(CS_ORIGIN_ID_COLUMN)
    let useOriginId = hasOriginIdA && hasOriginIdB

    // Validate _cs_origin_id values actually match between tables
    // For snapshot sources, use already-loaded shard 0 (sufficient sample for validation)
    if (useOriginId && diffMode === 'preview') {
      try {
        const validationTable = isParquetSource ? `"${shard0Table}"` : sourceTableExpr!
        const matchResult = await query<{ one: number }>(`
          SELECT 1 as one
          FROM ${validationTable} a
          INNER JOIN "${tableB}" b ON a."${CS_ORIGIN_ID_COLUMN}" = b."${CS_ORIGIN_ID_COLUMN}"
          LIMIT 1
        `)
        if (matchResult.length === 0) {
          console.warn('[Diff] _cs_origin_id values do not match — falling back to _cs_id')
          useOriginId = false
        }
      } catch (err) {
        console.warn('[Diff] Could not verify _cs_origin_id match (keeping _cs_origin_id):', err)
      }
    }

    // Evict shard 0 after schema + validation (no longer needed until Phase 1)
    if (isParquetSource && shard0Table) {
      await chunkMgr!.evictShard(snapshotId!, 0)
      shard0Table = null
    }

    console.log('[Diff] Row matching strategy:', {
      diffMode,
      useOriginId,
      matchColumn: diffMode === 'preview'
        ? (useOriginId ? CS_ORIGIN_ID_COLUMN : '_cs_id')
        : `key columns: [${keyColumns.join(', ')}]`
    })

    // Build conditional _cs_origin_id selects based on column existence
    // No table alias prefix — these are used in single-table SELECT queries (index table creation)
    const aOriginIdSelect = hasOriginIdA
      ? `"${CS_ORIGIN_ID_COLUMN}" as _cs_origin_id`
      : 'NULL as _cs_origin_id'
    const bOriginIdSelect = hasOriginIdB
      ? `"${CS_ORIGIN_ID_COLUMN}" as _cs_origin_id`
      : 'NULL as _cs_origin_id'

    // Build the index JOIN condition (lightweight — IDs only)
    const diffJoinCondition = diffMode === 'preview'
      ? useOriginId
        ? `a._cs_origin_id = b._cs_origin_id`
        : `a._cs_id = b._cs_id`
      : joinCondition  // Key-based for two-tables mode

    try {
      // Reduce threads to 1 and disable insertion order for memory efficiency
      await conn.query(`SET preserve_insertion_order = false`)
      await conn.query(`SET threads = 1`)

      try {
        // ── Phase 1: Build lightweight index tables (IDs + row numbers only) ──
        // Memory: ~36 MB per index table for 1M rows (UUID + BIGINT)
        onProgress?.({ phase: 'indexing', current: 0, total: 3 })

        // Index table A: source/original
        // For snapshot sources, build index shard-by-shard to avoid full materialization.
        // For normal tables, single CREATE AS SELECT.
        if (isParquetSource) {
          // Pre-create empty index table with explicit schema
          // Use actual _cs_id type from source schema (often BIGINT, not VARCHAR)
          // to avoid type mismatch in Phase 2 COALESCE with index table B
          const csIdType = colsAAll.find(c => c.column_name === '_cs_id')?.data_type || 'BIGINT'
          const csOriginIdType = colsAAll.find(c => c.column_name === CS_ORIGIN_ID_COLUMN)?.data_type || 'VARCHAR'
          const keyColDefs = keyColumns.map(c => {
            const type = colsAAll.find(col => col.column_name === c)?.data_type || 'VARCHAR'
            return `"${c}" ${type}`
          }).join(', ')
          const idxASchema = diffMode === 'two-tables'
            ? `_cs_id ${csIdType}, _cs_origin_id ${csOriginIdType}, ${keyColDefs}, _row_num BIGINT`
            : `_cs_id ${csIdType}, _cs_origin_id ${csOriginIdType}, _row_num BIGINT`

          await execute(`CREATE TEMP TABLE __diff_idx_a (${idxASchema})`)

          // Insert from each shard, using globalRowOffset for globally-unique row numbers
          const manifest = await chunkMgr!.getManifest(snapshotId!)
          let globalRowOffset = 0
          await chunkMgr!.mapChunks(snapshotId!, async (shardTable, shard, index) => {
            const selectCols = diffMode === 'two-tables'
              ? `"_cs_id" as _cs_id, ${aOriginIdSelect}, ${keyColumns.map(c => `"${c}"`).join(', ')}, ROW_NUMBER() OVER () + ${globalRowOffset} as _row_num`
              : `"_cs_id" as _cs_id, ${aOriginIdSelect}, ROW_NUMBER() OVER () + ${globalRowOffset} as _row_num`

            await execute(`INSERT INTO __diff_idx_a SELECT ${selectCols} FROM "${shardTable}"`)
            globalRowOffset += shard.rowCount

            onProgress?.({ phase: 'indexing', current: index + 1, total: manifest.shards.length })
          })
        } else {
          const idxAColumns = diffMode === 'two-tables'
            ? `"_cs_id" as _cs_id, ${aOriginIdSelect}, ${keyColumns.map(c => `"${c}"`).join(', ')}, ROW_NUMBER() OVER () as _row_num`
            : `"_cs_id" as _cs_id, ${aOriginIdSelect}, ROW_NUMBER() OVER () as _row_num`

          await execute(`
            CREATE TEMP TABLE __diff_idx_a AS
            SELECT ${idxAColumns}
            FROM ${sourceTableExpr}
          `)
        }
        onProgress?.({ phase: 'indexing', current: 1, total: 3 })

        // Index table B: target/current
        const idxBColumns = diffMode === 'two-tables'
          ? `"_cs_id" as _cs_id, ${bOriginIdSelect}, ${keyColumns.map(c => `"${c}"`).join(', ')}, ROW_NUMBER() OVER () as _row_num`
          : `"_cs_id" as _cs_id, ${bOriginIdSelect}, ROW_NUMBER() OVER () as _row_num`

        await execute(`
          CREATE TEMP TABLE __diff_idx_b AS
          SELECT ${idxBColumns}
          FROM "${tableB}"
        `)
        onProgress?.({ phase: 'indexing', current: 2, total: 3 })

        console.log('[Diff] Phase 1 complete: index tables created')

        // ── Phase 2: Index JOIN → Narrow diff table ──
        // JOIN the two lightweight index tables to classify rows as added/removed/pending_compare
        // No column data is touched — just IDs
        onProgress?.({ phase: 'joining', current: 2, total: 3 })

        // Build CASE logic for initial classification (no modification check yet)
        const indexCaseLogic = diffMode === 'preview'
          ? useOriginId
            ? `
              CASE
                WHEN a._cs_origin_id IS NULL THEN 'added'
                WHEN b._cs_origin_id IS NULL THEN 'removed'
                ELSE 'pending_compare'
              END as diff_status
            `
            : `
              CASE
                WHEN a._cs_id IS NULL THEN 'added'
                WHEN b._cs_id IS NULL THEN 'removed'
                ELSE 'pending_compare'
              END as diff_status
            `
          : `
            CASE
              WHEN ${keyColumns.map(c => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
              WHEN ${keyColumns.map(c => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
              ELSE 'pending_compare'
            END as diff_status
          `

        // For two-tables mode, the JOIN condition references a."col" = b."col" from
        // the joinCondition built earlier — these columns exist in the index tables
        await execute(`
          CREATE TEMP TABLE "${diffTableName}" AS
          SELECT
            COALESCE(a._cs_id, b._cs_id) as row_id,
            a._cs_id as a_row_id,
            b._cs_id as b_row_id,
            a._cs_origin_id as a_origin_id,
            b._cs_origin_id as b_origin_id,
            b._row_num as b_row_num,
            COALESCE(b._row_num, a._row_num + 1000000000) as sort_key,
            ${indexCaseLogic}
          FROM __diff_idx_a a
          FULL OUTER JOIN __diff_idx_b b ON ${diffJoinCondition}
        `)

        console.log('[Diff] Phase 2 complete: index JOIN done')

        // ── Phase 3: Batched column comparison for pending_compare rows ──
        // Only rows that matched by ID need actual column comparison
        const pendingResult = await query<{ cnt: number }>(`
          SELECT COUNT(*) as cnt FROM "${diffTableName}" WHERE diff_status = 'pending_compare'
        `)
        const pendingCount = Number(pendingResult[0].cnt)
        console.log(`[Diff] Phase 3: ${pendingCount.toLocaleString()} rows need column comparison`)

        if (pendingCount > 0) {
          // Build modification expression with src/tgt prefixes instead of a/b
          // The fullModificationExpr uses a."col" and b."col" — we need src."col" and tgt."col"
          const srcTgtModificationExpr = fullModificationExpr
            .replace(/\ba\."([^"]+)"/g, 'src."$1"')
            .replace(/\bb\."([^"]+)"/g, 'tgt."$1"')

          if (isParquetSource) {
            // Shard-level comparison: iterate source shards, UPDATE only matching rows per shard.
            // The JOIN condition (a_row_id = src."_cs_id") naturally scopes each UPDATE to
            // rows from this shard — no LIMIT/OFFSET subquery needed.
            const cmpManifest = await chunkMgr!.getManifest(snapshotId!)

            await chunkMgr!.mapChunks(snapshotId!, async (shardTable, _shard, index) => {
              onProgress?.({ phase: 'comparing', current: index + 1, total: cmpManifest.shards.length })

              await execute(`
                UPDATE "${diffTableName}"
                SET diff_status = CASE
                  WHEN (${srcTgtModificationExpr}) THEN 'modified'
                  ELSE 'unchanged'
                END
                FROM "${shardTable}" src, "${tableB}" tgt
                WHERE "${diffTableName}".a_row_id = src."_cs_id"
                  AND "${diffTableName}".b_row_id = tgt."_cs_id"
                  AND "${diffTableName}".diff_status = 'pending_compare'
              `)

              // Checkpoint between shards to reclaim WAL space
              await conn.query('CHECKPOINT')
            })

            console.log(`[Diff] Phase 3 complete: compared ${cmpManifest.shards.length} shards`)
          } else {
            // Normal table: LIMIT/OFFSET batching on the full source table
            const batchSize = SHARD_SIZE
            const totalBatches = Math.ceil(pendingCount / batchSize)

            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
              const offset = batchNum * batchSize
              onProgress?.({ phase: 'comparing', current: batchNum + 1, total: totalBatches })

              await execute(`
                UPDATE "${diffTableName}"
                SET diff_status = CASE
                  WHEN (${srcTgtModificationExpr}) THEN 'modified'
                  ELSE 'unchanged'
                END
                FROM ${sourceTableExpr} src, "${tableB}" tgt
                WHERE "${diffTableName}".a_row_id = src."_cs_id"
                  AND "${diffTableName}".b_row_id = tgt."_cs_id"
                  AND "${diffTableName}".diff_status = 'pending_compare'
                  AND "${diffTableName}".row_id IN (
                    SELECT row_id FROM "${diffTableName}"
                    WHERE diff_status = 'pending_compare'
                    ORDER BY sort_key
                    LIMIT ${batchSize} OFFSET ${offset}
                  )
              `)

              // Checkpoint and yield to browser between batches
              if (batchNum < totalBatches - 1) {
                await conn.query('CHECKPOINT')
                await new Promise(resolve => setTimeout(resolve, 0))
              }
            }

            console.log(`[Diff] Phase 3 complete: compared ${totalBatches} batches`)
          }
        } else {
          console.log('[Diff] Phase 3 skipped: no rows need column comparison')
        }

        // ── Phase 4: Cleanup index tables ──
        await execute('DROP TABLE IF EXISTS __diff_idx_a')
        await execute('DROP TABLE IF EXISTS __diff_idx_b')
        await conn.query('CHECKPOINT')
        console.log('[Diff] Phase 4 complete: index tables dropped')

      } finally {
        // Restore default settings
        await conn.query(`SET preserve_insertion_order = true`)
        await conn.query(`RESET threads`)
      }
    } catch (error) {
      // Clean up index tables on error
      try {
        await execute('DROP TABLE IF EXISTS __diff_idx_a')
        await execute('DROP TABLE IF EXISTS __diff_idx_b')
      } catch { /* ignore cleanup errors */ }

      const errMsg = error instanceof Error ? error.message : String(error)
      console.error('Diff creation failed:', error)

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

    // Summary from temp table (instant - no re-join!)
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

    // Get total non-unchanged count for grid
    const totalDiffRows = summary.added + summary.removed + summary.modified

    console.log('[Diff] Summary:', {
      ...summary,
      totalDiffRows,
      sourceTable: tableA,
      targetTable: tableB
    })

    // Tiered storage - export large diffs to OPFS
    let storageType: 'memory' | 'snapshot' = 'memory'

    if (totalDiffRows >= DIFF_TIER2_THRESHOLD) {
      console.log(`[Diff] Large diff (${totalDiffRows.toLocaleString()} rows), exporting to OPFS...`)

      const db = await initDuckDB()
      const conn = await getConnection()

      // Export narrow temp table to Arrow IPC snapshot
      await exportTableToSnapshot(db, conn, diffTableName, diffTableName)

      // Drop in-memory temp table (free RAM immediately)
      await execute(`DROP TABLE "${diffTableName}"`)

      storageType = 'snapshot'
      console.log(`[Diff] Exported to OPFS, freed ~${formatBytes(totalDiffRows * 58)} RAM`)
    }

    // For snapshot sources: pre-materialize the full source table NOW, while memory pressure
    // is minimal (index tables dropped, diff table exported to OPFS). This populates the
    // resolvedExpressionCache so fetchDiffPage doesn't need to load it later when the diff
    // table is also in memory — avoiding OOM on large datasets.
    if (isParquetSource) {
      await resolveTableRef(tableA)
      console.log(`[Diff] Pre-materialized source snapshot for diff view`)
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
      // Store origin ID availability at creation time to ensure consistent fetching
      hasOriginIdB,
    }
    } finally {
      // CRITICAL: Always clear interval, even on error
      clearInterval(memoryPollInterval)
      console.log(`[Diff] Completed with ${pollCount} memory polls`)

      // Phase 4D: Rematerialize active table after diff completes
      if (dematerializedTable) {
        try {
          const { rematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
          await rematerializeActiveTable(dematerializedTable.tableName, dematerializedTable.tableId)
        } catch (err) {
          console.warn('[Diff] Rematerialization failed (table stays frozen):', err)
        }
      }
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
  storageType: 'memory' | 'snapshot' = 'memory',
  hasOriginIdB?: boolean  // Whether target table had _cs_origin_id at diff creation
): Promise<DiffRow[]> {
  // Use robust resolver to handle snapshot sources with materialization
  const sourceTableExpr = await resolveTableRef(sourceTableName)

  // Use the hasOriginIdB from diff creation for consistency
  // Falls back to runtime check for backward compatibility
  // When _cs_origin_id is missing:
  // - Use _cs_id for row number computation in b_current_rows CTE
  // - Use d.b_row_id (which stores _cs_id) instead of d.b_origin_id for JOINs
  const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : await tableHasOriginId(targetTableName)

  // Build row matching expressions based on column availability
  const bRowsCteCol = targetHasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'
  const bRowsJoinCol = targetHasOriginId ? `d.b_origin_id` : `d.b_row_id`
  const bTableJoinCol = targetHasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'

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

  // For snapshot-backed diffs, materialize from Arrow IPC into DuckDB table on first access
  if (storageType === 'snapshot') {
    if (!registeredDiffTables.has(tempTableName)) {
      // Wait for any pending materialization to complete
      if (pendingDiffRegistrations.has(tempTableName)) {
        await pendingDiffRegistrations.get(tempTableName)
      }

      const materializationPromise = (async () => {
        const db = await initDuckDB()
        const connLocal = await getConnection()
        await importTableFromSnapshot(db, connLocal, tempTableName, tempTableName)
        registeredDiffTables.add(tempTableName)
        console.log(`[Diff] Materialized diff table from Arrow IPC: ${tempTableName}`)
      })()

      pendingDiffRegistrations.set(tempTableName, materializationPromise)
      await materializationPromise
      pendingDiffRegistrations.delete(tempTableName)
    }
    // Fall through to the same query as in-memory path below
  }

  // Original in-memory path
  // DYNAMIC ROW NUMBERS: Compute current row positions at query time
  // This ensures row numbers update when the target table is modified after diff creation
  // ORDER BY CAST("_cs_id" AS INTEGER) matches the grid's display order (see insert-row.ts)
  return query<DiffRow>(`
    WITH b_current_rows AS (
      SELECT ${bRowsCteCol}, ROW_NUMBER() OVER (ORDER BY CAST("_cs_id" AS INTEGER)) as current_row_num
      FROM "${targetTableName}"
    )
    SELECT
      d.diff_status,
      d.row_id,
      b_nums.current_row_num as b_row_num,
      ${selectCols}
    FROM "${tempTableName}" d
    LEFT JOIN ${sourceTableExpr} a ON d.a_origin_id = a."${CS_ORIGIN_ID_COLUMN}"
    LEFT JOIN "${targetTableName}" b ON ${bRowsJoinCol} = b.${bTableJoinCol}
    LEFT JOIN b_current_rows b_nums ON ${bRowsJoinCol} = b_nums.${bRowsCteCol}
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
 * For snapshot-backed diffs, requires prior call to materializeDiffForPagination()
 * to create an index table from Arrow IPC files. Without materialization, falls back
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
  storageType: 'memory' | 'snapshot' = 'memory',
  hasOriginIdB?: boolean  // Whether target table had _cs_origin_id at diff creation
): Promise<KeysetDiffPageResult> {
  // Use the hasOriginIdB from diff creation for consistency (see fetchDiffPage for details)
  const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : await tableHasOriginId(targetTableName)

  // Build row matching expressions based on column availability
  const bRowsCteCol = targetHasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'
  const bRowsJoinCol = targetHasOriginId ? `d.b_origin_id` : `d.b_row_id`
  const bTableJoinCol = targetHasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'
  // For index table queries, use page.* prefix instead of d.*
  const pageRowsJoinCol = targetHasOriginId ? `page.b_origin_id` : `page.b_row_id`

  // For snapshot storage, check if we have a materialized index table available
  // Use two-phase approach: fast index lookup, then targeted JOIN
  if (storageType === 'snapshot') {
    const indexTableName = getMaterializedDiffIndex(tempTableName)

    if (indexTableName) {
      // TWO-PHASE APPROACH for fast pagination:
      // Phase 1: Query small index table (500 rows from ~24MB table) - O(1)
      // Phase 2: JOIN only those 500 rows to source/target - O(500) not O(1M)
      console.log(`[Diff] Two-phase fetch using index table ${indexTableName}`)

      // Get source table expression
      const sourceTableExpr = await resolveTableRef(sourceTableName)

      // Build select columns for phase 2
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

      // Use CTE to first get page from index, then JOIN only those rows
      // This is fast because:
      // 1. Index query returns exactly `limit` rows from small table
      // 2. JOIN only needs to find `limit` matching rows in source/target
      // DYNAMIC ROW NUMBERS: Compute current row positions at query time
      // ORDER BY CAST("_cs_id" AS INTEGER) matches the grid's display order (see insert-row.ts)
      const rows = await query<DiffRow & { sort_key: number }>(`
        WITH page AS (
          SELECT row_id, sort_key, diff_status, a_row_id, b_row_id, a_origin_id, b_origin_id
          FROM "${indexTableName}"
          ${whereClause}
          ORDER BY sort_key ${orderDirection}
          LIMIT ${limit}
        ),
        b_current_rows AS (
          SELECT ${bRowsCteCol}, ROW_NUMBER() OVER (ORDER BY CAST("_cs_id" AS INTEGER)) as current_row_num
          FROM "${targetTableName}"
        )
        SELECT
          page.diff_status,
          page.row_id,
          page.sort_key,
          b_nums.current_row_num as b_row_num,
          ${selectCols}
        FROM page
        LEFT JOIN ${sourceTableExpr} a ON page.a_origin_id = a."${CS_ORIGIN_ID_COLUMN}"
        LEFT JOIN "${targetTableName}" b ON ${pageRowsJoinCol} = b.${bTableJoinCol}
        LEFT JOIN b_current_rows b_nums ON ${pageRowsJoinCol} = b_nums.${bRowsCteCol}
        ORDER BY page.sort_key ${orderDirection}
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
      // Slow path: No index table, fall back to OFFSET pagination
      console.log('[Diff] Keyset pagination not supported for snapshot storage (no index), using OFFSET')
      const offset = cursor.sortKey !== null ? 0 : 0
      const rows = await fetchDiffPage(
        tempTableName, sourceTableName, targetTableName,
        allColumns, newColumns, removedColumns,
        offset, limit, '', storageType
      )
      return {
        rows,
        firstSortKey: null,
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

  // DYNAMIC ROW NUMBERS: Compute current row positions at query time
  // ORDER BY CAST("_cs_id" AS INTEGER) matches the grid's display order (see insert-row.ts)
  const rows = await query<DiffRow & { sort_key: number }>(`
    WITH b_current_rows AS (
      SELECT ${bRowsCteCol}, ROW_NUMBER() OVER (ORDER BY CAST("_cs_id" AS INTEGER)) as current_row_num
      FROM "${targetTableName}"
    )
    SELECT
      d.diff_status,
      d.row_id,
      d.sort_key,
      b_nums.current_row_num as b_row_num,
      ${selectCols}
    FROM "${tempTableName}" d
    LEFT JOIN ${sourceTableExpr} a ON d.a_origin_id = a."${CS_ORIGIN_ID_COLUMN}"
    LEFT JOIN "${targetTableName}" b ON ${bRowsJoinCol} = b.${bTableJoinCol}
    LEFT JOIN b_current_rows b_nums ON ${bRowsJoinCol} = b_nums.${bRowsCteCol}
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
 * Clean up materialized source snapshot temp tables from DuckDB after diff completes.
 * This drops temp tables created by resolveTableRef.
 *
 * CRITICAL: Original snapshots (original_*) should NEVER be cleaned up.
 * They are permanent and needed for future diffs. Only temp snapshots should be cleaned.
 */
export async function cleanupDiffSourceFiles(sourceTableName: string): Promise<void> {
  if (!sourceTableName.startsWith('parquet:')) {
    return // Not a snapshot source, nothing to cleanup
  }

  const snapshotId = sourceTableName.replace('parquet:', '')

  // CRITICAL: Never cleanup original snapshots - they're permanent and needed for future diffs
  if (snapshotId.startsWith('original_')) {
    console.log(`[Diff] Skipping cleanup for original snapshot: ${snapshotId}`)
    return
  }

  // Drop the materialized temp table
  try {
    const tempTableName = `__diff_src_${snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')}`
    await execute(`DROP TABLE IF EXISTS "${tempTableName}"`)
    console.log(`[Diff] Dropped materialized source table: ${tempTableName}`)
  } catch (error) {
    console.warn('[Diff] Source table cleanup failed (non-fatal):', error)
  }

  // Remove from tracking sets and cache
  materializedSnapshots.delete(snapshotId)
  resolvedExpressionCache.delete(snapshotId)
  console.log(`[Diff] Cleared materialization state for ${snapshotId}`)
}

export async function cleanupDiffTable(
  tableName: string,
  storageType: 'memory' | 'snapshot' = 'memory'
): Promise<void> {
  try {
    // Always try to drop in-memory/materialized table
    await execute(`DROP TABLE IF EXISTS "${tableName}"`)

    // If snapshot-backed, delete Arrow IPC file(s) from OPFS
    if (storageType === 'snapshot') {
      await deleteSnapshot(tableName)
      console.log(`[Diff] Cleaned up snapshot file(s): ${tableName}`)
    }

    // Always VACUUM after dropping tables to reclaim DuckDB memory
    try {
      await execute('VACUUM')
    } catch {
      // VACUUM can fail if another operation is in progress — non-fatal
    }
  } catch (error) {
    console.warn('[Diff] Cleanup failed (non-fatal):', error)
  } finally {
    // Always remove from registered set, even if cleanup partially failed
    registeredDiffTables.delete(tableName)
  }
}

/**
 * Create a lightweight index table + VIEW for fast diff pagination.
 *
 * HYBRID APPROACH: Materialize only the index (row_id, sort_key, diff_status),
 * not the full column data. This enables O(1) random access scrolling while
 * keeping memory usage minimal.
 *
 * Memory comparison for 1M rows:
 * - Full materialization: ~6.5 GB (65 columns × ~100 bytes each)
 * - Index-only: ~24 MB (row_id UUID + sort_key BIGINT + diff_status VARCHAR)
 * - Pure VIEW: ~0 MB but O(n) random access (slow scrollbar drag)
 *
 * HOW IT WORKS:
 * 1. Materialize tiny index table: (row_id, sort_key, diff_status, a_row_id, b_row_id)
 * 2. Create VIEW that JOINs index → source → target for column data
 * 3. Pagination queries use index for fast OFFSET, then JOIN for visible rows only
 *
 * @param diffTableName - Name of the snapshot-backed diff table
 * @param sourceTableName - Source table (may be "parquet:snapshot_id")
 * @param targetTableName - Target table name
 * @param allColumns - All columns to include in the view
 * @param newColumns - Columns in A (original) but not B (current)
 * @param removedColumns - Columns in B (current) but not A (original)
 * @returns Name of the created view
 */
export async function materializeDiffForPagination(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  hasOriginIdB?: boolean  // Whether target table had _cs_origin_id at diff creation
): Promise<string> {
  const startTime = performance.now()
  const indexTableName = `_diff_idx_${Date.now()}`
  const viewTableName = `_diff_view_${Date.now()}`

  // Get source table expression (handles snapshot sources)
  const sourceTableExpr = await resolveTableRef(sourceTableName)

  // Use the hasOriginIdB from diff creation for consistency (see fetchDiffPage for details)
  const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : await tableHasOriginId(targetTableName)

  // Build row matching expressions based on column availability
  const idxJoinCol = targetHasOriginId ? `idx.b_origin_id` : `idx.b_row_id`
  const bTableJoinCol = targetHasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'

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

  // Materialize diff table from Arrow IPC if not already in DuckDB
  if (!registeredDiffTables.has(diffTableName)) {
    const db = await initDuckDB()
    const connLocal = await getConnection()
    await importTableFromSnapshot(db, connLocal, diffTableName, diffTableName)
    registeredDiffTables.add(diffTableName)
    console.log(`[Diff] Materialized diff table from Arrow IPC for pagination: ${diffTableName}`)
  }

  // STEP 1: Create tiny index table with just metadata (~24 MB for 1M rows)
  // This enables O(1) random access for scrollbar jumping
  await execute(`
    CREATE TEMP TABLE "${indexTableName}" AS
    SELECT
      row_id,
      sort_key,
      diff_status,
      a_row_id,
      b_row_id,
      a_origin_id,
      b_origin_id,
      b_row_num
    FROM "${diffTableName}"
    WHERE diff_status IN ('added', 'removed', 'modified')
  `)

  // STEP 2: Create VIEW that JOINs index to source/target for column data
  // Column data is fetched on-demand, only for visible rows
  // Uses _cs_origin_id for stable row matching when available, falls back to _cs_id
  await execute(`
    CREATE VIEW "${viewTableName}" AS
    SELECT
      idx.diff_status,
      idx.row_id,
      idx.sort_key,
      idx.b_row_num,
      ${selectCols}
    FROM "${indexTableName}" idx
    LEFT JOIN ${sourceTableExpr} a ON idx.a_origin_id = a."${CS_ORIGIN_ID_COLUMN}"
    LEFT JOIN "${targetTableName}" b ON ${idxJoinCol} = b.${bTableJoinCol}
  `)

  // Track both for cleanup (store as "indexTable|viewTable")
  materializedDiffViews.set(diffTableName, `${indexTableName}|${viewTableName}`)

  const elapsed = performance.now() - startTime
  console.log(`[Diff] Created index table ${indexTableName} + view ${viewTableName} in ${elapsed.toFixed(0)}ms (~24 MB index)`)

  return viewTableName
}

/**
 * Get the materialized view table name for a snapshot-backed diff.
 * Returns null if not materialized.
 */
export function getMaterializedDiffView(diffTableName: string): string | null {
  const storedValue = materializedDiffViews.get(diffTableName)
  if (!storedValue) return null

  // Handle both old format (just viewTable) and new format (indexTable|viewTable)
  if (storedValue.includes('|')) {
    return storedValue.split('|')[1]  // Return just the view name
  }
  return storedValue
}

/**
 * Get the index table name for a snapshot-backed diff.
 * Returns null if not using hybrid approach.
 */
export function getMaterializedDiffIndex(diffTableName: string): string | null {
  const storedValue = materializedDiffViews.get(diffTableName)
  if (!storedValue) return null

  // Only new format has index table
  if (storedValue.includes('|')) {
    return storedValue.split('|')[0]  // Return just the index table name
  }
  return null
}

/**
 * Cleanup materialized diff view when diff closes.
 * Drops the temp table and removes from tracking map.
 */
export async function cleanupMaterializedDiffView(diffTableName: string): Promise<void> {
  const storedValue = materializedDiffViews.get(diffTableName)
  if (storedValue) {
    try {
      // Handle both old format (just viewTable) and new format (indexTable|viewTable)
      if (storedValue.includes('|')) {
        const [indexTableName, viewTableName] = storedValue.split('|')
        // Drop view first (depends on index table), then index table
        await execute(`DROP VIEW IF EXISTS "${viewTableName}"`)
        await execute(`DROP TABLE IF EXISTS "${indexTableName}"`)
        console.log(`[Diff] Dropped view ${viewTableName} and index table ${indexTableName}`)
      } else {
        // Legacy: just a view
        await execute(`DROP VIEW IF EXISTS "${storedValue}"`)
        console.log(`[Diff] Dropped view ${storedValue}`)
      }
    } catch (e) {
      console.warn(`[Diff] Failed to cleanup materialized view:`, e)
    } finally {
      // Always remove from map, even if DROP fails — prevents stale entries accumulating
      materializedDiffViews.delete(diffTableName)
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
  storageType: 'memory' | 'snapshot' = 'memory'
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
 * @param storageType - 'memory' or 'snapshot'
 * @returns Set of row_ids that have changes in the specified column
 */
export async function getRowsWithColumnChanges(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  columnName: string,
  storageType: 'memory' | 'snapshot' = 'memory',
  hasOriginIdB?: boolean  // Whether target table had _cs_origin_id at diff creation
): Promise<Set<string>> {
  const sourceTableExpr = await resolveTableRef(sourceTableName)

  // Use the hasOriginIdB from diff creation for consistency (see fetchDiffPage for details)
  const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : await tableHasOriginId(targetTableName)

  // Build row matching expressions based on column availability
  const bRowsJoinCol = targetHasOriginId ? `d.b_origin_id` : `d.b_row_id`
  const bTableJoinCol = targetHasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'

  // Handle snapshot-backed diffs
  let diffExpr: string
  if (storageType === 'snapshot') {
    // Check if materialized view exists (use it for faster query)
    const viewTableName = getMaterializedDiffView(diffTableName)
    if (viewTableName) {
      const rows = await query<{ row_id: string }>(`
        SELECT row_id
        FROM "${viewTableName}"
        WHERE diff_status = 'modified'
          AND CAST("a_${columnName}" AS VARCHAR) IS DISTINCT FROM CAST("b_${columnName}" AS VARCHAR)
      `)
      return new Set(rows.map(r => r.row_id))
    }

    // Materialize diff table from Arrow IPC if not already done
    if (!registeredDiffTables.has(diffTableName)) {
      const db = await initDuckDB()
      const connLocal = await getConnection()
      await importTableFromSnapshot(db, connLocal, diffTableName, diffTableName)
      registeredDiffTables.add(diffTableName)
    }

    diffExpr = `"${diffTableName}"`
  } else {
    diffExpr = `"${diffTableName}"`
  }

  // Query for modified rows where this specific column changed
  // Uses _cs_origin_id for stable row matching when available, falls back to _cs_id
  const rows = await query<{ row_id: string }>(`
    SELECT d.row_id
    FROM ${diffExpr} d
    LEFT JOIN ${sourceTableExpr} a ON d.a_origin_id = a."${CS_ORIGIN_ID_COLUMN}"
    LEFT JOIN "${targetTableName}" b ON ${bRowsJoinCol} = b.${bTableJoinCol}
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
