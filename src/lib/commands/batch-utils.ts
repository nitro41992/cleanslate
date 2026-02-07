/**
 * Shared batching helper for transform commands
 * Reduces command updates to just 3 lines of code
 *
 * Supports two execution paths:
 *   1. OFFSET batch path (legacy) — staging table with OFFSET/LIMIT batching
 *   2. Shard path (Phase 2) — DROP table, process OPFS shards one-by-one, rebuild
 *
 * The shard path drops peak memory from ~1GB to ~150MB for 1M-row tables.
 * Selection is automatic based on manifest availability + command type.
 */

import type { CommandContext, ExecutionResult } from './types'
import { batchExecute, swapStagingTable, cleanupStagingTable } from './batch-executor'
import { getConnection, initDuckDB, tableHasCsId, tableHasOriginId, CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN } from '@/lib/duckdb'
import { useTableStore } from '@/stores/tableStore'
import { isInternalColumn } from './utils/column-ordering'
import { readManifest, writeManifest, type ShardInfo, type SnapshotManifest } from '@/lib/opfs/manifest'
import { exportSingleShard, swapSnapshots, importTableFromSnapshot, importSingleShard, deleteSnapshot } from '@/lib/opfs/snapshot-storage'
import { SHARD_SIZE } from '@/lib/constants'
import { yieldToMain } from '@/lib/utils/yield-to-main'

/**
 * Get the column order for a table from the store.
 * Falls back to column names from context if not set.
 * Exported for use by Tier 3 commands that need column ordering for non-batch SQL.
 */
export function getColumnOrderForTable(ctx: CommandContext): string[] {
  const tableStore = useTableStore.getState()
  const table = tableStore.tables.find(t => t.id === ctx.table.id)

  // Use stored column order if available
  if (table?.columnOrder && table.columnOrder.length > 0) {
    return table.columnOrder
  }

  // Fallback to current columns from context (excluding internal columns)
  return ctx.table.columns
    .map(c => c.name)
    .filter(name => !isInternalColumn(name))
}

/**
 * Build a SELECT query that preserves column order.
 *
 * CRITICAL: Using SELECT * EXCLUDE (...) loses column ordering in DuckDB.
 * This function explicitly lists all columns in the user-defined order,
 * applying transformations to specific columns in-place.
 *
 * Internal columns (_cs_id, _cs_origin_id) are included at the end to preserve row identity.
 *
 * Exported for use by Tier 3 commands that need column ordering for non-batch SQL.
 *
 * @param tableName - Source table name
 * @param columnOrder - User-defined column order (from getColumnOrderForTable)
 * @param columnTransforms - Map of column name -> SQL expression for transformation
 * @param includeCsId - Whether to include _cs_id column (should be true if source table has it)
 * @param includeCsOriginId - Whether to include _cs_origin_id column (should be true if source table has it)
 * @returns SQL SELECT query with columns in correct order
 */
export function buildColumnOrderedSelect(
  tableName: string,
  columnOrder: string[],
  columnTransforms: Record<string, string>,
  includeCsId = false,
  includeCsOriginId = false
): string {
  // Build select parts for user-visible columns in order
  const selectParts = columnOrder
    .filter(col => !isInternalColumn(col))
    .map(col => {
      const transform = columnTransforms[col]
      if (transform) {
        return `${transform} as "${col}"`
      }
      return `"${col}"`
    })

  // Include internal identity columns at the end if they exist in the source table
  if (includeCsId) {
    selectParts.push(`"${CS_ID_COLUMN}"`)
  }
  if (includeCsOriginId) {
    selectParts.push(`"${CS_ORIGIN_ID_COLUMN}"`)
  }

  return `SELECT ${selectParts.join(', ')} FROM "${tableName}"`
}

/**
 * Run a batched single-column transformation with automatic column order preservation.
 *
 * This is the preferred API for commands - just pass the column and transformation expression.
 * Column ordering is handled automatically.
 *
 * @param ctx - Command context with batch settings
 * @param column - Column name to transform
 * @param transformExpr - SQL expression for the transformation (should reference the column with quotes)
 * @param samplePredicate - Optional WHERE predicate for sample query (e.g., '"col" IS DISTINCT FROM UPPER("col")')
 * @returns Execution result with affected row count and optional sample changes
 *
 * @example
 * // In UppercaseCommand.execute():
 * if (ctx.batchMode) {
 *   return runBatchedColumnTransform(ctx, col, `UPPER("${col}")`)
 * }
 */
export async function runBatchedColumnTransform(
  ctx: CommandContext,
  column: string,
  transformExpr: string,
  samplePredicate?: string
): Promise<ExecutionResult> {
  const columnOrder = getColumnOrderForTable(ctx)

  // Check if source table has internal identity columns
  const hasCsId = await tableHasCsId(ctx.table.name)
  const hasOriginId = await tableHasOriginId(ctx.table.name)

  // Build sample query if predicate provided
  const sampleQuery = samplePredicate
    ? `SELECT "${column}" as before, ${transformExpr} as after
       FROM "${ctx.table.name}"
       WHERE ${samplePredicate}`
    : undefined

  // Try shard path first (Phase 2: ~150MB peak instead of ~1GB)
  const canShard = await canUseShardPath(ctx.table.name, ctx.commandType)
  if (canShard) {
    const buildQuery = (src: string) => buildColumnOrderedSelect(
      src, columnOrder, { [column]: transformExpr }, hasCsId, hasOriginId
    )
    return runShardTransform(ctx, buildQuery, sampleQuery)
  }

  // Fallback: OFFSET batch path
  const selectQuery = buildColumnOrderedSelect(
    ctx.table.name,
    columnOrder,
    { [column]: transformExpr },
    hasCsId,
    hasOriginId
  )

  return runBatchedTransform(ctx, selectQuery, sampleQuery)
}

/**
 * Run a batched transformation using staging table strategy (raw SQL version).
 *
 * NOTE: For single-column transforms, prefer runBatchedColumnTransform() which
 * automatically handles column ordering. Use this only for complex multi-column
 * transforms or when you need full control over the SELECT query.
 *
 * @param ctx - Command context with batch settings
 * @param selectQuery - SQL SELECT query to execute in batches
 * @param sampleQuery - Optional SQL query to capture before/after samples for audit
 * @returns Execution result with affected row count and optional sample changes
 */
export async function runBatchedTransform(
  ctx: CommandContext,
  selectQuery: string,
  sampleQuery?: string
): Promise<ExecutionResult> {
  // Try shard path first (Phase 2: ~150MB peak instead of ~1GB)
  // Only if caller didn't already go through runBatchedColumnTransform (which checks itself)
  const canShard = await canUseShardPath(ctx.table.name, ctx.commandType)
  if (canShard) {
    // Build the query builder by replacing the table name in the SQL
    const tableName = ctx.table.name
    const buildQuery = (src: string) =>
      selectQuery.split(`"${tableName}"`).join(`"${src}"`)
    return runShardTransform(ctx, buildQuery, sampleQuery)
  }

  // Fallback: OFFSET batch path
  const conn = await getConnection()
  const stagingTable = `_staging_${ctx.table.name}`

  // Capture samples BEFORE transformation (limit 1000 rows)
  let sampleChanges: { before: string; after: string }[] = []

  if (sampleQuery) {
    try {
      // Only add LIMIT if not already present (some callers include it already)
      const hasLimit = /LIMIT\s+\d+/i.test(sampleQuery)
      const query = hasLimit ? sampleQuery : `${sampleQuery} LIMIT 1000`
      const sampleResult = await conn.query(query)
      sampleChanges = sampleResult.toArray().map(row => {
        const json = row.toJSON()
        return {
          before: String(json.before ?? ''),
          after: String(json.after ?? '')
        }
      })
      console.log(`[BatchExecutor] Captured ${sampleChanges.length} sample rows`)
    } catch (err) {
      console.warn('[BatchExecutor] Sample query failed:', err)
      // Continue without samples - don't block the transformation
    }
  }

  try {
    // Batch execute the transformation
    const result = await batchExecute(conn, {
      sourceTable: ctx.table.name,
      stagingTable,
      selectQuery,
      batchSize: ctx.batchSize,
      onProgress: ctx.onBatchProgress
    })

    // Atomically swap staging → live
    await swapStagingTable(conn, ctx.table.name, result.stagingTable)

    // Return success
    const columns = await ctx.db.getTableColumns(ctx.table.name)
    return {
      success: true,
      rowCount: result.rowsProcessed,
      columns,
      affected: result.rowsProcessed,
      newColumnNames: [],
      droppedColumnNames: [],
      sampleChanges: sampleChanges.length > 0 ? sampleChanges : undefined
    }
  } catch (error) {
    // Cleanup on failure
    await cleanupStagingTable(conn, stagingTable)
    throw error
  }
}

// ===== SHARD TRANSFORM PATH (Phase 2) =====

/**
 * Commands that CANNOT be processed shard-by-shard because they need
 * cross-row visibility (dedup needs all rows, fill_down reads previous row, etc.)
 */
const NON_SHARD_PARALLEL = new Set([
  'transform:remove_duplicates',
  'transform:fill_down',
  'transform:custom_sql',
  'transform:excel_formula',
  'combine:stack',
  'combine:join',
  'match:merge',
])

/**
 * Determine whether a table + command combination can use the shard path.
 *
 * Requirements:
 *   1. The command must be shard-parallel (no cross-row dependencies)
 *   2. An OPFS manifest must exist for the table (table has been saved)
 *
 * @param tableName - DuckDB table name
 * @param commandType - Command type string (e.g., 'transform:trim')
 * @returns true if the shard path can be used
 */
async function canUseShardPath(tableName: string, commandType?: string): Promise<boolean> {
  if (commandType && NON_SHARD_PARALLEL.has(commandType)) return false

  const snapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  const manifest = await readManifest(snapshotId)
  return manifest !== null && manifest.shards.length > 0
}

/**
 * Shard-based transform orchestrator (Phase 2).
 *
 * Instead of OFFSET/LIMIT batching on the full DuckDB table (~1GB peak),
 * this function:
 *   1. Ensures the OPFS snapshot is current
 *   2. DROPs the live DuckDB table (frees ~500MB)
 *   3. Processes shards one-by-one: load → transform → write output → evict
 *   4. Rebuilds the DuckDB table from the new output shards
 *
 * Peak memory: ~150MB (1 input shard + 1 output shard) vs ~1GB (source + staging).
 *
 * @param ctx - Command context (must have batchMode=true)
 * @param buildSelectQuery - Callback: given a temp input table name, returns a SELECT with transforms
 * @param sampleQuery - Optional query for audit before/after samples (run on shard 0)
 * @returns ExecutionResult with snapshotAlreadySaved=true
 */
async function runShardTransform(
  ctx: CommandContext,
  buildSelectQuery: (sourceTableName: string) => string,
  sampleQuery?: string
): Promise<ExecutionResult> {
  const conn = await getConnection()
  const db = await initDuckDB()
  const tableName = ctx.table.name
  const snapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  const outputSnapshotId = `_xform_${snapshotId}_${Date.now()}`

  // Read source manifest
  const sourceManifest = await readManifest(snapshotId)
  if (!sourceManifest) {
    throw new Error(`[ShardTransform] No manifest for ${snapshotId} — should have been caught by canUseShardPath`)
  }

  const totalShards = sourceManifest.shards.length
  const totalRows = sourceManifest.totalRows

  console.log(`[ShardTransform] Starting shard transform on ${tableName}: ${totalShards} shard(s), ${totalRows.toLocaleString()} rows`)

  // Phase 1: Capture audit samples from the live table BEFORE dropping it
  let sampleChanges: { before: string; after: string }[] = []
  if (sampleQuery) {
    try {
      const hasLimit = /LIMIT\s+\d+/i.test(sampleQuery)
      const query = hasLimit ? sampleQuery : `${sampleQuery} LIMIT 1000`
      const sampleResult = await conn.query(query)
      sampleChanges = sampleResult.toArray().map(row => {
        const json = row.toJSON()
        return {
          before: String(json.before ?? ''),
          after: String(json.after ?? '')
        }
      })
      console.log(`[ShardTransform] Captured ${sampleChanges.length} audit samples`)
    } catch (err) {
      console.warn('[ShardTransform] Sample query failed:', err)
    }
  }

  // Phase 2: DROP the live DuckDB table to free ~500MB
  await conn.query(`DROP TABLE IF EXISTS "${tableName}"`)
  try {
    await conn.query('CHECKPOINT')
  } catch { /* non-fatal */ }
  console.log(`[ShardTransform] Dropped live table "${tableName}" — memory freed`)

  // Phase 3: Process shards one-by-one
  const outputShards: ShardInfo[] = []
  let processedRows = 0

  try {
    for (let i = 0; i < totalShards; i++) {
      const shard = sourceManifest.shards[i]
      const tempInputTable = `__xform_in_${i}`
      const tempOutputTable = `__xform_out_${i}`

      // Load source shard from OPFS into DuckDB
      await importSingleShard(db, conn, snapshotId, i, tempInputTable)

      // Transform: run the caller's SELECT against the temp input table
      const transformQuery = buildSelectQuery(tempInputTable)
      await conn.query(`CREATE TABLE "${tempOutputTable}" AS ${transformQuery}`)

      // Export transformed shard to OPFS
      const shardInfo = await exportSingleShard(conn, tempOutputTable, outputSnapshotId, i)
      outputShards.push(shardInfo)

      // Drop both temp tables to free memory
      await conn.query(`DROP TABLE IF EXISTS "${tempInputTable}"`)
      await conn.query(`DROP TABLE IF EXISTS "${tempOutputTable}"`)

      // CHECKPOINT every 2 shards to release DuckDB buffer pool
      if ((i + 1) % 2 === 0) {
        try {
          await conn.query('CHECKPOINT')
        } catch { /* non-fatal */ }
      }

      processedRows += shard.rowCount

      // Report progress
      if (ctx.onBatchProgress) {
        const pct = Math.round(((i + 1) / totalShards) * 100)
        ctx.onBatchProgress(i + 1, totalShards, pct)
      }

      // Yield to browser between shards
      await yieldToMain()
    }

    // Phase 4: Write output manifest
    // Get column names from the first output shard (schema may have changed, e.g., split_column)
    let outputColumns: string[] = sourceManifest.columns
    if (outputShards.length > 0) {
      try {
        // Temporarily import shard 0 to read its schema
        const tempSchemaTable = `__xform_schema_probe`
        await importSingleShard(db, conn, outputSnapshotId, 0, tempSchemaTable)
        const colResult = await conn.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = '${tempSchemaTable}'
          ORDER BY ordinal_position
        `)
        outputColumns = colResult.toArray().map(row => row.toJSON().column_name as string)
        await conn.query(`DROP TABLE IF EXISTS "${tempSchemaTable}"`)
      } catch {
        // Fallback to source columns
        console.warn('[ShardTransform] Could not probe output schema, using source columns')
      }
    }

    const outputManifest: SnapshotManifest = {
      version: 1,
      snapshotId: outputSnapshotId,
      totalRows: processedRows,
      totalBytes: outputShards.reduce((sum, s) => sum + s.byteSize, 0),
      shardSize: SHARD_SIZE,
      shards: outputShards,
      columns: outputColumns,
      orderByColumn: sourceManifest.orderByColumn,
      createdAt: Date.now(),
    }
    await writeManifest(outputManifest)

    // Phase 5: Rebuild DuckDB table from output shards
    await importTableFromSnapshot(db, conn, outputSnapshotId, tableName)
    console.log(`[ShardTransform] Rebuilt "${tableName}" from ${totalShards} output shard(s)`)

    // Phase 6: Atomic swap — replace old OPFS snapshot with new output
    await swapSnapshots(snapshotId, outputSnapshotId, snapshotId)
    console.log(`[ShardTransform] Swapped OPFS snapshot: ${outputSnapshotId} → ${snapshotId}`)

    // Final CHECKPOINT
    try {
      await conn.query('CHECKPOINT')
    } catch { /* non-fatal */ }

    // Return success — snapshotAlreadySaved tells executor to skip priority save
    const columns = await ctx.db.getTableColumns(tableName)
    return {
      success: true,
      rowCount: processedRows,
      columns,
      affected: processedRows,
      newColumnNames: [],
      droppedColumnNames: [],
      sampleChanges: sampleChanges.length > 0 ? sampleChanges : undefined,
      snapshotAlreadySaved: true,
    }
  } catch (error) {
    // Error recovery: delete temp output snapshot and reimport original
    console.error('[ShardTransform] Error during shard processing, recovering...', error)

    // Clean up any leftover temp tables
    for (let i = 0; i < totalShards; i++) {
      try { await conn.query(`DROP TABLE IF EXISTS "__xform_in_${i}"`) } catch { /* ignore */ }
      try { await conn.query(`DROP TABLE IF EXISTS "__xform_out_${i}"`) } catch { /* ignore */ }
    }
    try { await conn.query(`DROP TABLE IF EXISTS "__xform_schema_probe"`) } catch { /* ignore */ }

    // Delete partial output snapshot
    try {
      await deleteSnapshot(outputSnapshotId)
    } catch { /* ignore */ }

    // Reimport original snapshot to restore the DuckDB table.
    // The original OPFS files are untouched — they were never modified.
    try {
      await importTableFromSnapshot(db, conn, snapshotId, tableName)
      console.log(`[ShardTransform] Recovered: reimported "${tableName}" from original snapshot`)
    } catch (reimportError) {
      // CRITICAL: DuckDB table is gone and reimport failed.
      // The original OPFS shard files still exist — a page reload will recover them.
      console.error(
        `[ShardTransform] CRITICAL: Failed to reimport "${tableName}" from snapshot. ` +
        `Original OPFS files are intact — a page reload will recover the data.`,
        reimportError
      )
      // Wrap with actionable message so the executor can surface it to the user
      throw new Error(
        `Transform failed and automatic recovery failed. ` +
        `Your data is safe on disk — please refresh the page to recover. ` +
        `(Original error: ${error instanceof Error ? error.message : String(error)})`
      )
    }

    throw error
  }
}
