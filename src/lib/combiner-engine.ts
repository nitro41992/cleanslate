import { query, execute, getTableColumns, CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN, tableExists, initDuckDB, getConnection } from '@/lib/duckdb'
import { getChunkManager } from '@/lib/opfs/chunk-manager'
import { exportSingleShard, exportTableToSnapshot, importTableFromSnapshot, deleteSnapshot } from '@/lib/opfs/snapshot-storage'
import { writeManifest, readManifest, type SnapshotManifest, type ShardInfo } from '@/lib/opfs/manifest'
import { SHARD_SIZE } from '@/lib/constants'
import { withDuckDBLock } from './duckdb/lock'
import type { JoinType, StackValidation, JoinValidation, ColumnInfo } from '@/types'
import { yieldToMain } from '@/lib/utils/yield-to-main'

/**
 * Structured progress callback for combine operations.
 * Matches the combinerStore's `combineProgress` shape directly.
 */
export type CombineProgressCallback = (progress: {
  phase: 'schema' | 'indexing' | 'joining' | 'hydrating' | 'finalizing'
  current: number
  total: number
}) => void

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a table name to a safe OPFS snapshot identifier.
 * Lowercase, alphanumeric + underscore only.
 */
function normalizeSnapshotId(tableName: string): string {
  return tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
}

// ---------------------------------------------------------------------------
// Source Resolution
// ---------------------------------------------------------------------------

/**
 * Describes where a table's data lives — either in DuckDB memory or
 * frozen to OPFS as a micro-shard snapshot.
 */
interface ResolvedSource {
  type: 'duckdb' | 'snapshot'
  tableName: string
  snapshotId: string
  manifest: SnapshotManifest | null
}

/**
 * Determine whether a source table is currently loaded in DuckDB or
 * available as a frozen OPFS snapshot.
 *
 * @param tableName - The logical table name
 * @returns Resolved source descriptor
 * @throws If the table is neither in DuckDB nor in OPFS
 */
async function resolveSource(tableName: string): Promise<ResolvedSource> {
  const inDuckDB = await tableExists(tableName)
  const normalizedId = normalizeSnapshotId(tableName)

  if (inDuckDB) {
    return { type: 'duckdb', tableName, snapshotId: normalizedId, manifest: null }
  }

  // Not in DuckDB — check for a frozen snapshot in OPFS
  const manifest = await readManifest(normalizedId)
  if (manifest) {
    return { type: 'snapshot', tableName, snapshotId: normalizedId, manifest }
  }

  throw new Error(
    `[CombinerEngine] Table "${tableName}" is not in DuckDB and has no OPFS snapshot (looked for manifest: ${normalizedId})`
  )
}

// ---------------------------------------------------------------------------
// Column Metadata Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve column metadata for a resolved source.
 *
 * - DuckDB sources: use the standard getTableColumns() helper.
 * - Snapshot sources: load shard 0 via ChunkManager, query
 *   information_schema on the temp table, then evict the shard.
 */
async function getColumnsForSource(source: ResolvedSource): Promise<ColumnInfo[]> {
  if (source.type === 'duckdb') {
    return getTableColumns(source.tableName)
  }

  // Snapshot path: load shard 0 into DuckDB, introspect, evict
  const chunkManager = getChunkManager()
  const tempTable = await chunkManager.loadShard(source.snapshotId, 0)

  try {
    const conn = await getConnection()
    const result = await conn.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = '${tempTable}'
      ORDER BY ordinal_position
    `)
    const cols: ColumnInfo[] = result.toArray().map(row => {
      const json = row.toJSON()
      return {
        name: json.column_name as string,
        type: json.data_type as string,
        nullable: (json.is_nullable as string) === 'YES',
      }
    })
    // Filter out internal columns (same as getTableColumns default)
    return cols.filter(
      c => c.name !== CS_ID_COLUMN && c.name !== CS_ORIGIN_ID_COLUMN && !c.name.endsWith('__base') && !c.name.startsWith('duckdb_')
    )
  } finally {
    await chunkManager.evictShard(source.snapshotId, 0)
  }
}

// ---------------------------------------------------------------------------
// Metadata-Based Validation
// ---------------------------------------------------------------------------

/**
 * Validate whether two tables can be stacked, using pre-fetched column metadata.
 * Synchronous — no DB access required.
 */
export function validateStackFromMetadata(
  colsA: ColumnInfo[],
  colsB: ColumnInfo[],
  nameA: string,
  nameB: string
): StackValidation {
  const namesA = new Set(colsA.map(c => c.name))
  const namesB = new Set(colsB.map(c => c.name))

  const missingInA = colsB.filter(c => !namesA.has(c.name)).map(c => c.name)
  const missingInB = colsA.filter(c => !namesB.has(c.name)).map(c => c.name)

  const warnings: string[] = []

  if (missingInA.length > 0) {
    warnings.push(`Columns missing in ${nameA}: ${missingInA.join(', ')}`)
  }
  if (missingInB.length > 0) {
    warnings.push(`Columns missing in ${nameB}: ${missingInB.join(', ')}`)
  }

  // Type mismatch check on common columns
  const commonCols = colsA.filter(c => namesB.has(c.name))
  for (const colA of commonCols) {
    const colB = colsB.find(c => c.name === colA.name)
    if (colB && colA.type !== colB.type) {
      warnings.push(
        `Type mismatch for "${colA.name}": ${nameA} has ${colA.type}, ${nameB} has ${colB.type}`
      )
    }
  }

  return {
    isValid: true, // Stack is always possible with NULL padding
    missingInA,
    missingInB,
    warnings,
  }
}

/**
 * Validate whether two tables can be joined on a key column,
 * using pre-fetched column metadata. Synchronous.
 *
 * Note: Does NOT perform the whitespace check (that requires data access).
 */
export function validateJoinFromMetadata(
  colsA: ColumnInfo[],
  colsB: ColumnInfo[],
  nameA: string,
  nameB: string,
  keyColumn: string
): JoinValidation {
  const warnings: string[] = []

  const hasKeyA = colsA.some(c => c.name === keyColumn)
  const hasKeyB = colsB.some(c => c.name === keyColumn)

  if (!hasKeyA || !hasKeyB) {
    return {
      isValid: false,
      keyColumnMismatch: true,
      warnings: [
        `Key column "${keyColumn}" not found in ${!hasKeyA ? nameA : nameB}`,
      ],
    }
  }

  const typeA = colsA.find(c => c.name === keyColumn)?.type
  const typeB = colsB.find(c => c.name === keyColumn)?.type
  if (typeA !== typeB) {
    warnings.push(
      `Type mismatch for key column: ${nameA}.${keyColumn} is ${typeA}, ${nameB}.${keyColumn} is ${typeB}`
    )
  }

  return {
    isValid: true,
    keyColumnMismatch: false,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers for sharded paths
// ---------------------------------------------------------------------------

/**
 * Ensure a source has a snapshot in OPFS. If the source is in DuckDB but
 * has no snapshot, create a temporary one.
 *
 * @returns The snapshot ID to iterate and whether it is temporary
 */
async function ensureSnapshot(
  source: ResolvedSource,
  tempPrefix: string
): Promise<{ snapshotId: string; isTemp: boolean }> {
  if (source.type === 'snapshot') {
    return { snapshotId: source.snapshotId, isTemp: false }
  }

  // Source is in DuckDB — check if a snapshot already exists
  const existingManifest = await readManifest(source.snapshotId)
  if (existingManifest) {
    return { snapshotId: source.snapshotId, isTemp: false }
  }

  // No snapshot — export a temporary one
  const tempSnapshotId = `${tempPrefix}${normalizeSnapshotId(source.tableName)}`
  const db = await initDuckDB()
  const conn = await getConnection()
  await exportTableToSnapshot(db, conn, source.tableName, tempSnapshotId)
  return { snapshotId: tempSnapshotId, isTemp: true }
}

// ---------------------------------------------------------------------------
// Sharded Stack
// ---------------------------------------------------------------------------

/**
 * Stack (UNION ALL) two tables using shard-by-shard processing.
 *
 * Works for both in-DuckDB and frozen-to-OPFS sources. Each source shard
 * is loaded individually, NULL-padded, exported as a result shard, then
 * evicted — keeping peak memory at ~1 shard instead of 2 full tables.
 */
async function stackTablesSharded(
  tableA: string,
  tableB: string,
  resultName: string,
  onProgress?: CombineProgressCallback
): Promise<{ rowCount: number }> {
  const conn = await getConnection()
  const chunkManager = getChunkManager()
  const resultSnapshotId = `_combine_result_${Date.now()}`
  const tempSnapshots: string[] = [] // Track temp snapshots for cleanup

  try {
    // ── Phase 0: Resolve sources and discover schema ──────────────────
    onProgress?.({ phase: 'schema', current: 0, total: 0 })

    const sourceA = await resolveSource(tableA)
    const sourceB = await resolveSource(tableB)

    const colsA = await getColumnsForSource(sourceA)
    const colsB = await getColumnsForSource(sourceB)

    // Compute union column set (exclude internal columns — regenerated)
    const allColNames = [
      ...new Set([...colsA.map(c => c.name), ...colsB.map(c => c.name)]),
    ].filter(col => col !== CS_ID_COLUMN && col !== CS_ORIGIN_ID_COLUMN)

    const namesA = new Set(colsA.map(c => c.name))
    const namesB = new Set(colsB.map(c => c.name))

    // ── Phase 1: Ensure both sources have OPFS snapshots ──────────────
    const snapA = await ensureSnapshot(sourceA, '_combine_temp_')
    if (snapA.isTemp) tempSnapshots.push(snapA.snapshotId)

    const snapB = await ensureSnapshot(sourceB, '_combine_temp_')
    if (snapB.isTemp) tempSnapshots.push(snapB.snapshotId)

    // Clear manifest cache so freshly-created temp snapshots are visible
    chunkManager.clearManifestCache()

    const manifestA = await chunkManager.getManifest(snapA.snapshotId)
    const manifestB = await chunkManager.getManifest(snapB.snapshotId)

    const totalShards = manifestA.shards.length + manifestB.shards.length
    let outputShardIdx = 0
    let globalRowOffset = 0
    let totalRows = 0
    const shardInfos: ShardInfo[] = []

    // ── Phase 2: Process Source A shards ──────────────────────────────
    for (let i = 0; i < manifestA.shards.length; i++) {
      onProgress?.({ phase: 'hydrating', current: i + 1, total: totalShards })

      const tempTable = await chunkManager.loadShard(snapA.snapshotId, i)

      try {
        // Build NULL-padded SELECT
        const selectCols = allColNames
          .map(col => namesA.has(col) ? `"${col}"` : `NULL as "${col}"`)
          .join(', ')

        await conn.query(`
          CREATE TABLE "__combine_out" AS
          SELECT
            (ROW_NUMBER() OVER () + ${globalRowOffset}) * 100 as "${CS_ID_COLUMN}",
            gen_random_uuid()::VARCHAR as "${CS_ORIGIN_ID_COLUMN}",
            ${selectCols}
          FROM "${tempTable}"
        `)

        // Count rows in this shard
        const countResult = await conn.query(`SELECT COUNT(*) as count FROM "__combine_out"`)
        const shardRows = Number(countResult.toArray()[0].toJSON().count)

        // Export shard
        const shardInfo = await exportSingleShard(conn, '__combine_out', resultSnapshotId, outputShardIdx)
        shardInfos.push(shardInfo)

        globalRowOffset += shardRows
        totalRows += shardRows
        outputShardIdx++
      } finally {
        await conn.query('DROP TABLE IF EXISTS "__combine_out"')
        await chunkManager.evictShard(snapA.snapshotId, i)
      }

      await yieldToMain()
    }

    // ── Phase 3: Process Source B shards ──────────────────────────────
    for (let i = 0; i < manifestB.shards.length; i++) {
      onProgress?.({ phase: 'hydrating', current: manifestA.shards.length + i + 1, total: totalShards })

      const tempTable = await chunkManager.loadShard(snapB.snapshotId, i)

      try {
        const selectCols = allColNames
          .map(col => namesB.has(col) ? `"${col}"` : `NULL as "${col}"`)
          .join(', ')

        await conn.query(`
          CREATE TABLE "__combine_out" AS
          SELECT
            (ROW_NUMBER() OVER () + ${globalRowOffset}) * 100 as "${CS_ID_COLUMN}",
            gen_random_uuid()::VARCHAR as "${CS_ORIGIN_ID_COLUMN}",
            ${selectCols}
          FROM "${tempTable}"
        `)

        const countResult = await conn.query(`SELECT COUNT(*) as count FROM "__combine_out"`)
        const shardRows = Number(countResult.toArray()[0].toJSON().count)

        const shardInfo = await exportSingleShard(conn, '__combine_out', resultSnapshotId, outputShardIdx)
        shardInfos.push(shardInfo)

        globalRowOffset += shardRows
        totalRows += shardRows
        outputShardIdx++
      } finally {
        await conn.query('DROP TABLE IF EXISTS "__combine_out"')
        await chunkManager.evictShard(snapB.snapshotId, i)
      }

      await yieldToMain()
    }

    // ── Phase 4: Write manifest and import result ─────────────────────
    onProgress?.({ phase: 'finalizing', current: totalShards, total: totalShards })

    const resultManifest: SnapshotManifest = {
      version: 1,
      snapshotId: resultSnapshotId,
      totalRows,
      totalBytes: shardInfos.reduce((sum, s) => sum + s.byteSize, 0),
      shardSize: SHARD_SIZE,
      shards: shardInfos,
      columns: [CS_ID_COLUMN, CS_ORIGIN_ID_COLUMN, ...allColNames],
      orderByColumn: CS_ID_COLUMN,
      createdAt: Date.now(),
    }
    await writeManifest(resultManifest)

    // Clear manifest cache before import (it will read the new manifest)
    chunkManager.clearManifestCache()

    const db = await initDuckDB()
    await importTableFromSnapshot(db, conn, resultSnapshotId, resultName)

    // CHECKPOINT to release buffer pool
    try { await conn.query('CHECKPOINT') } catch { /* non-fatal */ }

    return { rowCount: totalRows }
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────
    // Drop any leftover temp tables
    try { await conn.query('DROP TABLE IF EXISTS "__combine_out"') } catch { /* ignore */ }

    // Delete result snapshot (data is now in DuckDB)
    try { await deleteSnapshot(resultSnapshotId) } catch { /* ignore */ }

    // Delete any temporary source snapshots we created
    for (const tempId of tempSnapshots) {
      try { await deleteSnapshot(tempId) } catch { /* ignore */ }
    }

    // Clear manifest cache after cleanup
    chunkManager.clearManifestCache()
  }
}

// ---------------------------------------------------------------------------
// Sharded Join
// ---------------------------------------------------------------------------

/**
 * Join two tables using an index-first shard algorithm.
 *
 * Phase 1-2: Build lightweight key indexes by scanning source shards.
 * Phase 3:   JOIN the indexes to produce a match table.
 * Phase 4:   Hydrate result shards by loading matching source rows.
 * Phase 5:   Write manifest, import result into DuckDB, cleanup.
 */
async function joinTablesSharded(
  leftTable: string,
  rightTable: string,
  keyColumn: string,
  joinType: JoinType,
  resultName: string,
  onProgress?: CombineProgressCallback
): Promise<{ rowCount: number }> {
  const conn = await getConnection()
  const chunkManager = getChunkManager()
  const resultSnapshotId = `_combine_result_${Date.now()}`
  const tempSnapshots: string[] = []

  // Temp table names we will clean up
  const tempTables = [
    '__combine_idx_left',
    '__combine_idx_right',
    '__combine_matches',
    '__combine_batch',
    '__combine_left_data',
    '__combine_right_data',
    '__combine_out',
  ]

  try {
    // ── Phase 0: Resolve sources and discover schema ──────────────────
    onProgress?.({ phase: 'schema', current: 0, total: 0 })

    const sourceL = await resolveSource(leftTable)
    const sourceR = await resolveSource(rightTable)

    const colsL = await getColumnsForSource(sourceL)
    const colsR = await getColumnsForSource(sourceR)

    // Find key column type from left source
    const keyColInfo = colsL.find(c => c.name === keyColumn)
    const keyType = keyColInfo?.type ?? 'VARCHAR'

    // Compute result columns: all left (minus internal) + right-only (minus internal, key, and left-dupes)
    const leftUserCols = colsL.filter(
      c => c.name !== CS_ID_COLUMN && c.name !== CS_ORIGIN_ID_COLUMN
    )
    const leftColNames = new Set(colsL.map(c => c.name))
    const rightOnlyCols = colsR.filter(
      c =>
        c.name !== keyColumn &&
        !leftColNames.has(c.name) &&
        c.name !== CS_ID_COLUMN &&
        c.name !== CS_ORIGIN_ID_COLUMN
    )

    // ── Ensure snapshots ──────────────────────────────────────────────
    const snapL = await ensureSnapshot(sourceL, '_combine_temp_')
    if (snapL.isTemp) tempSnapshots.push(snapL.snapshotId)

    const snapR = await ensureSnapshot(sourceR, '_combine_temp_')
    if (snapR.isTemp) tempSnapshots.push(snapR.snapshotId)

    chunkManager.clearManifestCache()

    const manifestL = await chunkManager.getManifest(snapL.snapshotId)
    const manifestR = await chunkManager.getManifest(snapR.snapshotId)

    const totalIndexShards = manifestL.shards.length + manifestR.shards.length

    // ── Phase 1: Build Left Key Index ─────────────────────────────────
    await conn.query(`
      CREATE TABLE "__combine_idx_left" (
        _cs_id VARCHAR,
        key_col ${keyType},
        _shard_idx INTEGER
      )
    `)

    for (let i = 0; i < manifestL.shards.length; i++) {
      onProgress?.({ phase: 'indexing', current: i + 1, total: totalIndexShards })

      const tempTable = await chunkManager.loadShard(snapL.snapshotId, i)
      try {
        await conn.query(`
          INSERT INTO "__combine_idx_left"
          SELECT
            CAST("${CS_ID_COLUMN}" AS VARCHAR),
            "${keyColumn}",
            ${i}
          FROM "${tempTable}"
        `)
      } finally {
        await chunkManager.evictShard(snapL.snapshotId, i)
      }
      await yieldToMain()
    }

    // ── Phase 2: Build Right Key Index ────────────────────────────────
    await conn.query(`
      CREATE TABLE "__combine_idx_right" (
        _cs_id VARCHAR,
        key_col ${keyType},
        _shard_idx INTEGER
      )
    `)

    for (let i = 0; i < manifestR.shards.length; i++) {
      onProgress?.({ phase: 'indexing', current: manifestL.shards.length + i + 1, total: totalIndexShards })

      const tempTable = await chunkManager.loadShard(snapR.snapshotId, i)
      try {
        await conn.query(`
          INSERT INTO "__combine_idx_right"
          SELECT
            CAST("${CS_ID_COLUMN}" AS VARCHAR),
            "${keyColumn}",
            ${i}
          FROM "${tempTable}"
        `)
      } finally {
        await chunkManager.evictShard(snapR.snapshotId, i)
      }
      await yieldToMain()
    }

    // ── Phase 3: Index JOIN ───────────────────────────────────────────
    onProgress?.({ phase: 'joining', current: 0, total: 1 })

    const joinTypeMap: Record<JoinType, string> = {
      inner: 'INNER JOIN',
      left: 'LEFT JOIN',
      full_outer: 'FULL OUTER JOIN',
    }
    const sqlJoinType = joinTypeMap[joinType]

    await conn.query(`
      CREATE TABLE "__combine_matches" AS
      SELECT
        l._cs_id as l_cs_id,
        r._cs_id as r_cs_id,
        l.key_col as l_key,
        r.key_col as r_key,
        l._shard_idx as l_shard_idx,
        r._shard_idx as r_shard_idx,
        ROW_NUMBER() OVER () as result_row_num
      FROM "__combine_idx_left" l
      ${sqlJoinType} "__combine_idx_right" r
        ON l.key_col = r.key_col
    `)

    // Drop index tables — no longer needed
    await conn.query('DROP TABLE IF EXISTS "__combine_idx_left"')
    await conn.query('DROP TABLE IF EXISTS "__combine_idx_right"')
    try { await conn.query('CHECKPOINT') } catch { /* non-fatal */ }

    // Get total matches
    const matchCountResult = await conn.query('SELECT COUNT(*) as count FROM "__combine_matches"')
    const totalMatches = Number(matchCountResult.toArray()[0].toJSON().count)

    onProgress?.({ phase: 'joining', current: 1, total: 1 })

    // Early return: 0 matches — create empty result table directly
    if (totalMatches === 0) {
      onProgress?.({ phase: 'finalizing', current: 1, total: 1 })

      // Build column definitions for empty result
      const colDefs = [
        `0::BIGINT as "${CS_ID_COLUMN}"`,
        `''::VARCHAR as "${CS_ORIGIN_ID_COLUMN}"`,
        `NULL::${keyType} as "${keyColumn}"`,
        ...leftUserCols
          .filter(c => c.name !== keyColumn)
          .map(c => `NULL::${c.type || 'VARCHAR'} as "${c.name}"`),
        ...rightOnlyCols
          .map(c => `NULL::${c.type || 'VARCHAR'} as "${c.name}"`),
      ]

      await conn.query(`
        CREATE OR REPLACE TABLE "${resultName}" AS
        SELECT ${colDefs.join(', ')}
        WHERE false
      `)

      // Cleanup match table
      await conn.query('DROP TABLE IF EXISTS "__combine_matches"')
      try { await conn.query('CHECKPOINT') } catch { /* non-fatal */ }

      return { rowCount: 0 }
    }

    // ── Phase 4: Hydrate Result Shards ────────────────────────────────
    const shardInfos: ShardInfo[] = []
    let outputShardIdx = 0
    const totalBatches = Math.ceil(totalMatches / SHARD_SIZE)

    for (let batchOffset = 0; batchOffset < totalMatches; batchOffset += SHARD_SIZE) {

      onProgress?.({ phase: 'hydrating', current: outputShardIdx + 1, total: totalBatches })

      // Get this batch of match IDs
      await conn.query(`DROP TABLE IF EXISTS "__combine_batch"`)
      await conn.query(`
        CREATE TABLE "__combine_batch" AS
        SELECT l_cs_id, r_cs_id, l_key, r_key, l_shard_idx, r_shard_idx, result_row_num
        FROM "__combine_matches"
        ORDER BY result_row_num
        LIMIT ${SHARD_SIZE} OFFSET ${batchOffset}
      `)

      const batchCountResult = await conn.query('SELECT COUNT(*) as count FROM "__combine_batch"')
      const batchSize = Number(batchCountResult.toArray()[0].toJSON().count)
      if (batchSize === 0) break

      // Determine which left shards we need for this batch
      const leftShardResult = await conn.query(`
        SELECT DISTINCT l_shard_idx FROM "__combine_batch" WHERE l_cs_id IS NOT NULL ORDER BY l_shard_idx
      `)
      const leftShardIdxs = leftShardResult.toArray().map(r => Number(r.toJSON().l_shard_idx))

      // Collect matching left rows
      await conn.query('DROP TABLE IF EXISTS "__combine_left_data"')
      let leftDataCreated = false

      for (const shardIdx of leftShardIdxs) {
        const tempTable = await chunkManager.loadShard(snapL.snapshotId, shardIdx)
        try {
          if (!leftDataCreated) {
            await conn.query(`
              CREATE TABLE "__combine_left_data" AS
              SELECT s.*
              FROM "${tempTable}" s
              WHERE CAST(s."${CS_ID_COLUMN}" AS VARCHAR) IN (
                SELECT l_cs_id FROM "__combine_batch" WHERE l_cs_id IS NOT NULL
              )
            `)
            leftDataCreated = true
          } else {
            await conn.query(`
              INSERT INTO "__combine_left_data"
              SELECT s.*
              FROM "${tempTable}" s
              WHERE CAST(s."${CS_ID_COLUMN}" AS VARCHAR) IN (
                SELECT l_cs_id FROM "__combine_batch" WHERE l_cs_id IS NOT NULL
              )
            `)
          }
        } finally {
          await chunkManager.evictShard(snapL.snapshotId, shardIdx)
        }
        await yieldToMain()
      }

      // If no left data table was created (all NULLs from FULL OUTER), create empty one
      if (!leftDataCreated) {
        // Create an empty table with the correct schema by loading shard 0 and selecting 0 rows
        const tempTable = await chunkManager.loadShard(snapL.snapshotId, 0)
        try {
          await conn.query(`
            CREATE TABLE "__combine_left_data" AS
            SELECT * FROM "${tempTable}" WHERE false
          `)
        } finally {
          await chunkManager.evictShard(snapL.snapshotId, 0)
        }
      }

      // Determine which right shards we need for this batch
      const rightShardResult = await conn.query(`
        SELECT DISTINCT r_shard_idx FROM "__combine_batch" WHERE r_cs_id IS NOT NULL ORDER BY r_shard_idx
      `)
      const rightShardIdxs = rightShardResult.toArray().map(r => Number(r.toJSON().r_shard_idx))

      // Collect matching right rows
      await conn.query('DROP TABLE IF EXISTS "__combine_right_data"')
      let rightDataCreated = false

      for (const shardIdx of rightShardIdxs) {
        const tempTable = await chunkManager.loadShard(snapR.snapshotId, shardIdx)
        try {
          if (!rightDataCreated) {
            await conn.query(`
              CREATE TABLE "__combine_right_data" AS
              SELECT s.*
              FROM "${tempTable}" s
              WHERE CAST(s."${CS_ID_COLUMN}" AS VARCHAR) IN (
                SELECT r_cs_id FROM "__combine_batch" WHERE r_cs_id IS NOT NULL
              )
            `)
            rightDataCreated = true
          } else {
            await conn.query(`
              INSERT INTO "__combine_right_data"
              SELECT s.*
              FROM "${tempTable}" s
              WHERE CAST(s."${CS_ID_COLUMN}" AS VARCHAR) IN (
                SELECT r_cs_id FROM "__combine_batch" WHERE r_cs_id IS NOT NULL
              )
            `)
          }
        } finally {
          await chunkManager.evictShard(snapR.snapshotId, shardIdx)
        }
        await yieldToMain()
      }

      // If no right data table was created, create empty one
      if (!rightDataCreated) {
        const tempTable = await chunkManager.loadShard(snapR.snapshotId, 0)
        try {
          await conn.query(`
            CREATE TABLE "__combine_right_data" AS
            SELECT * FROM "${tempTable}" WHERE false
          `)
        } finally {
          await chunkManager.evictShard(snapR.snapshotId, 0)
        }
      }

      // Build the result shard from batch + left_data + right_data
      const rightSelectParts = rightOnlyCols
        .map(c => `r."${c.name}"`)
        .join(', ')

      // COALESCE key column for FULL OUTER JOIN (left may be NULL)
      const keySelectExpr = `COALESCE(l."${keyColumn}", r."${keyColumn}") as "${keyColumn}"`

      // Build the left columns excluding the key column (it's handled by COALESCE)
      const leftNonKeyCols = leftUserCols
        .filter(c => c.name !== keyColumn)
        .map(c => `l."${c.name}"`)
        .join(', ')

      // Construct SELECT clause
      let selectParts = `
        (ROW_NUMBER() OVER () + ${batchOffset}) * 100 as "${CS_ID_COLUMN}",
        gen_random_uuid()::VARCHAR as "${CS_ORIGIN_ID_COLUMN}",
        ${keySelectExpr}`
      if (leftNonKeyCols.length > 0) {
        selectParts += `, ${leftNonKeyCols}`
      }
      if (rightSelectParts.length > 0) {
        selectParts += `, ${rightSelectParts}`
      }

      await conn.query('DROP TABLE IF EXISTS "__combine_out"')
      await conn.query(`
        CREATE TABLE "__combine_out" AS
        SELECT ${selectParts}
        FROM "__combine_batch" b
        LEFT JOIN "__combine_left_data" l
          ON b.l_cs_id = CAST(l."${CS_ID_COLUMN}" AS VARCHAR)
        LEFT JOIN "__combine_right_data" r
          ON b.r_cs_id = CAST(r."${CS_ID_COLUMN}" AS VARCHAR)
        ORDER BY b.result_row_num
      `)

      // Export the shard
      const shardInfo = await exportSingleShard(conn, '__combine_out', resultSnapshotId, outputShardIdx)
      shardInfos.push(shardInfo)
      outputShardIdx++

      // Cleanup batch temp tables
      await conn.query('DROP TABLE IF EXISTS "__combine_out"')
      await conn.query('DROP TABLE IF EXISTS "__combine_left_data"')
      await conn.query('DROP TABLE IF EXISTS "__combine_right_data"')
      await conn.query('DROP TABLE IF EXISTS "__combine_batch"')

      await yieldToMain()
    }

    // ── Phase 5: Finalize ─────────────────────────────────────────────
    onProgress?.({ phase: 'finalizing', current: totalBatches, total: totalBatches })

    // Drop match table
    await conn.query('DROP TABLE IF EXISTS "__combine_matches"')

    // Compute result columns for manifest
    const resultColumns = [
      CS_ID_COLUMN,
      CS_ORIGIN_ID_COLUMN,
      keyColumn,
      ...leftUserCols.filter(c => c.name !== keyColumn).map(c => c.name),
      ...rightOnlyCols.map(c => c.name),
    ]

    const resultManifest: SnapshotManifest = {
      version: 1,
      snapshotId: resultSnapshotId,
      totalRows: totalMatches,
      totalBytes: shardInfos.reduce((sum, s) => sum + s.byteSize, 0),
      shardSize: SHARD_SIZE,
      shards: shardInfos,
      columns: resultColumns,
      orderByColumn: CS_ID_COLUMN,
      createdAt: Date.now(),
    }
    await writeManifest(resultManifest)

    chunkManager.clearManifestCache()

    const db = await initDuckDB()
    await importTableFromSnapshot(db, conn, resultSnapshotId, resultName)

    try { await conn.query('CHECKPOINT') } catch { /* non-fatal */ }

    return { rowCount: totalMatches }
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────
    for (const t of tempTables) {
      try { await conn.query(`DROP TABLE IF EXISTS "${t}"`) } catch { /* ignore */ }
    }

    try { await deleteSnapshot(resultSnapshotId) } catch { /* ignore */ }

    for (const tempId of tempSnapshots) {
      try { await deleteSnapshot(tempId) } catch { /* ignore */ }
    }

    chunkManager.clearManifestCache()
  }
}

// ---------------------------------------------------------------------------
// Public API — existing functions preserved, with shard dispatch added
// ---------------------------------------------------------------------------

/**
 * Validate whether two tables can be stacked (UNION ALL)
 * Checks for column alignment and reports mismatches
 */
export async function validateStack(
  tableA: string,
  tableB: string
): Promise<StackValidation> {
  // Resolve sources to handle frozen tables (not in DuckDB, shard-backed in OPFS)
  const sourceA = await resolveSource(tableA)
  const sourceB = await resolveSource(tableB)

  const colsA = await getColumnsForSource(sourceA)
  const colsB = await getColumnsForSource(sourceB)

  const namesA = new Set(colsA.map((c) => c.name))
  const namesB = new Set(colsB.map((c) => c.name))

  const missingInA = colsB.filter((c) => !namesA.has(c.name)).map((c) => c.name)
  const missingInB = colsA.filter((c) => !namesB.has(c.name)).map((c) => c.name)

  const warnings: string[] = []

  if (missingInA.length > 0) {
    warnings.push(`Columns missing in ${tableA}: ${missingInA.join(', ')}`)
  }
  if (missingInB.length > 0) {
    warnings.push(`Columns missing in ${tableB}: ${missingInB.join(', ')}`)
  }

  // Check for type mismatches on common columns
  const commonCols = colsA.filter((c) => namesB.has(c.name))
  for (const colA of commonCols) {
    const colB = colsB.find((c) => c.name === colA.name)
    if (colB && colA.type !== colB.type) {
      warnings.push(
        `Type mismatch for "${colA.name}": ${tableA} has ${colA.type}, ${tableB} has ${colB.type}`
      )
    }
  }

  return {
    isValid: true, // Stack is always possible with NULL padding
    missingInA,
    missingInB,
    warnings,
  }
}

/**
 * Stack two tables using UNION ALL
 * Missing columns are filled with NULL
 *
 * NOTE: Both _cs_id and _cs_origin_id are regenerated for the combined table.
 * _cs_origin_id gets new UUIDs since rows from different source tables
 * should not share identity (they came from different original data sources).
 *
 * Dispatches to sharded path when either table is frozen (not in DuckDB)
 * or the combined row count exceeds SHARD_SIZE.
 */
export async function stackTables(
  tableA: string,
  tableB: string,
  resultName: string,
  onProgress?: CombineProgressCallback
): Promise<{ rowCount: number }> {
  return withDuckDBLock(async () => {
    // Phase 4D: Temporarily dematerialize active table to free ~120MB during combine
    // IMPORTANT: Skip if active table is one of the source tables being combined.
    // Dematerializing a source table would DROP it from DuckDB mid-operation.
    let dematerializedTable: { tableName: string; tableId: string } | null = null
    try {
      const { dematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
      const { useTableStore } = await import('@/stores/tableStore')
      const activeTable = useTableStore.getState().tables.find(
        t => t.id === useTableStore.getState().activeTableId
      )
      const activeTableInUse = activeTable && (
        activeTable.name === tableA ||
        activeTable.name === tableB
      )
      if (!activeTableInUse) {
        dematerializedTable = await dematerializeActiveTable()
        if (dematerializedTable) {
          onProgress?.({ phase: 'schema', current: 0, total: 0 })
        }
      }
    } catch (err) {
      console.warn('[Combine] Dematerialization skipped:', err)
    }

    try {
    // Check if both tables exist in DuckDB
    const aExists = await tableExists(tableA)
    const bExists = await tableExists(tableB)

    // Fast path: both in DuckDB and small enough for direct SQL
    if (aExists && bExists) {
      const countA = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${tableA}"`)
      const countB = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${tableB}"`)
      const totalRows = Number(countA[0].count) + Number(countB[0].count)

      if (totalRows <= SHARD_SIZE) {
        // ── Original direct SQL path (unchanged) ──────────────────────
        const colsA = await getTableColumns(tableA)
        const colsB = await getTableColumns(tableB)

        const allColNames = [
          ...new Set([...colsA.map((c) => c.name), ...colsB.map((c) => c.name)]),
        ].filter((col) => col !== CS_ID_COLUMN && col !== CS_ORIGIN_ID_COLUMN)

        const namesA = new Set(colsA.map((c) => c.name))
        const namesB = new Set(colsB.map((c) => c.name))

        const selectA = allColNames
          .map((col) => (namesA.has(col) ? `"${col}"` : `NULL as "${col}"`))
          .join(', ')

        const selectB = allColNames
          .map((col) => (namesB.has(col) ? `"${col}"` : `NULL as "${col}"`))
          .join(', ')

        await execute(`
          CREATE OR REPLACE TABLE "${resultName}" AS
          SELECT
            ROW_NUMBER() OVER () * 100 as "${CS_ID_COLUMN}",
            gen_random_uuid()::VARCHAR as "${CS_ORIGIN_ID_COLUMN}",
            ${allColNames.map((c) => `"${c}"`).join(', ')}
          FROM (
            SELECT ${selectA} FROM "${tableA}"
            UNION ALL
            SELECT ${selectB} FROM "${tableB}"
          )
        `)

        const countResult = await query<{ count: number }>(
          `SELECT COUNT(*) as count FROM "${resultName}"`
        )
        const rowCount = Number(countResult[0].count)

        return { rowCount }
      }
    }

    // Shard path: handles frozen tables + large datasets
    return stackTablesSharded(tableA, tableB, resultName, onProgress)
    } finally {
      // Phase 4D: Rematerialize active table after combine completes
      if (dematerializedTable) {
        try {
          const { rematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
          await rematerializeActiveTable(dematerializedTable.tableName, dematerializedTable.tableId)
        } catch (err) {
          console.warn('[Combine] Rematerialization failed (table stays frozen):', err)
        }
      }
    }
  })
}

/**
 * Validate whether two tables can be joined on a key column
 * FR-E3: Check if keys need cleaning before joining
 */
export async function validateJoin(
  tableA: string,
  tableB: string,
  keyColumn: string
): Promise<JoinValidation> {
  // Resolve sources to handle frozen tables (not in DuckDB, shard-backed in OPFS)
  const sourceA = await resolveSource(tableA)
  const sourceB = await resolveSource(tableB)

  const colsA = await getColumnsForSource(sourceA)
  const colsB = await getColumnsForSource(sourceB)

  const warnings: string[] = []

  // Check if key column exists in both tables
  const hasKeyA = colsA.some((c) => c.name === keyColumn)
  const hasKeyB = colsB.some((c) => c.name === keyColumn)

  if (!hasKeyA || !hasKeyB) {
    return {
      isValid: false,
      keyColumnMismatch: true,
      warnings: [
        `Key column "${keyColumn}" not found in ${!hasKeyA ? tableA : tableB}`,
      ],
    }
  }

  // Check for type mismatch
  const typeA = colsA.find((c) => c.name === keyColumn)?.type
  const typeB = colsB.find((c) => c.name === keyColumn)?.type
  if (typeA !== typeB) {
    warnings.push(
      `Type mismatch for key column: ${tableA}.${keyColumn} is ${typeA}, ${tableB}.${keyColumn} is ${typeB}`
    )
  }

  // FR-E3: Check if key columns have leading/trailing whitespace
  // Only check for text columns when both tables are in DuckDB (can't run SQL on frozen tables)
  const bothInDuckDB = sourceA.type === 'duckdb' && sourceB.type === 'duckdb'
  const isTextColumn = typeA === 'VARCHAR' || typeA === 'TEXT'
  if (isTextColumn && bothInDuckDB) {
    const wsCheckA = await query<{ has_whitespace: boolean }>(`
      SELECT COUNT(*) > 0 as has_whitespace
      FROM "${tableA}"
      WHERE "${keyColumn}" != TRIM("${keyColumn}")
    `)
    const wsCheckB = await query<{ has_whitespace: boolean }>(`
      SELECT COUNT(*) > 0 as has_whitespace
      FROM "${tableB}"
      WHERE "${keyColumn}" != TRIM("${keyColumn}")
    `)

    if (wsCheckA[0].has_whitespace || wsCheckB[0].has_whitespace) {
      warnings.push(
        'Key column has leading/trailing whitespace. Consider using "Auto-Clean Keys" before joining.'
      )
    }
  }

  return {
    isValid: true,
    keyColumnMismatch: false,
    warnings,
  }
}

/**
 * Auto-clean key columns by trimming whitespace
 * FR-E3: Clean-first guardrail
 */
export async function autoCleanKeys(
  tableA: string,
  tableB: string,
  keyColumn: string
): Promise<{ cleanedA: number; cleanedB: number }> {
  // Count and trim in table A
  const countA = await query<{ count: number }>(`
    SELECT COUNT(*) as count FROM "${tableA}"
    WHERE "${keyColumn}" != TRIM("${keyColumn}")
  `)
  await execute(`
    UPDATE "${tableA}"
    SET "${keyColumn}" = TRIM("${keyColumn}")
  `)

  // Count and trim in table B
  const countB = await query<{ count: number }>(`
    SELECT COUNT(*) as count FROM "${tableB}"
    WHERE "${keyColumn}" != TRIM("${keyColumn}")
  `)
  await execute(`
    UPDATE "${tableB}"
    SET "${keyColumn}" = TRIM("${keyColumn}")
  `)

  return {
    cleanedA: Number(countA[0].count),
    cleanedB: Number(countB[0].count),
  }
}

/**
 * Join two tables on a key column
 *
 * NOTE: Both _cs_id and _cs_origin_id are regenerated for the joined table.
 * _cs_origin_id gets new UUIDs since join results create new row combinations
 * that didn't exist in either source table.
 *
 * Dispatches to sharded path when either table is frozen (not in DuckDB)
 * or the combined row count exceeds SHARD_SIZE.
 */
export async function joinTables(
  leftTable: string,
  rightTable: string,
  keyColumn: string,
  joinType: JoinType,
  resultName: string,
  onProgress?: CombineProgressCallback
): Promise<{ rowCount: number }> {
  return withDuckDBLock(async () => {
    // Phase 4D: Temporarily dematerialize active table to free ~120MB during combine
    // IMPORTANT: Skip if active table is one of the source tables being joined.
    // Dematerializing a source table would DROP it from DuckDB mid-operation.
    let dematerializedTable: { tableName: string; tableId: string } | null = null
    try {
      const { dematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
      const { useTableStore } = await import('@/stores/tableStore')
      const activeTable = useTableStore.getState().tables.find(
        t => t.id === useTableStore.getState().activeTableId
      )
      const activeTableInUse = activeTable && (
        activeTable.name === leftTable ||
        activeTable.name === rightTable
      )
      if (!activeTableInUse) {
        dematerializedTable = await dematerializeActiveTable()
        if (dematerializedTable) {
          onProgress?.({ phase: 'schema', current: 0, total: 0 })
        }
      }
    } catch (err) {
      console.warn('[Combine] Dematerialization skipped:', err)
    }

    try {
    // Check if both tables exist in DuckDB
    const lExists = await tableExists(leftTable)
    const rExists = await tableExists(rightTable)

    // Fast path: both in DuckDB and small enough for direct SQL
    if (lExists && rExists) {
      const countL = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${leftTable}"`)
      const countR = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${rightTable}"`)
      const totalRows = Number(countL[0].count) + Number(countR[0].count)

      if (totalRows <= SHARD_SIZE) {
        // ── Original direct SQL path (unchanged) ──────────────────────
        const colsL = await getTableColumns(leftTable)
        const colsR = await getTableColumns(rightTable)

        const leftColNames = new Set(colsL.map((c) => c.name))
        const rightOnlyCols = colsR.filter(
          (c) =>
            c.name !== keyColumn &&
            !leftColNames.has(c.name) &&
            c.name !== CS_ID_COLUMN &&
            c.name !== CS_ORIGIN_ID_COLUMN
        )

        const leftSelect = colsL
          .filter((c) => c.name !== CS_ID_COLUMN && c.name !== CS_ORIGIN_ID_COLUMN)
          .map((c) => `l."${c.name}"`)
          .join(', ')
        const rightSelect = rightOnlyCols.map((c) => `r."${c.name}"`).join(', ')
        const selectClause =
          rightSelect.length > 0 ? `${leftSelect}, ${rightSelect}` : leftSelect

        const joinTypeMap: Record<JoinType, string> = {
          left: 'LEFT JOIN',
          inner: 'INNER JOIN',
          full_outer: 'FULL OUTER JOIN',
        }
        const sqlJoinType = joinTypeMap[joinType]

        await execute(`
          CREATE OR REPLACE TABLE "${resultName}" AS
          SELECT
            ROW_NUMBER() OVER () * 100 as "${CS_ID_COLUMN}",
            gen_random_uuid()::VARCHAR as "${CS_ORIGIN_ID_COLUMN}",
            *
          FROM (
            SELECT ${selectClause}
            FROM "${leftTable}" l
            ${sqlJoinType} "${rightTable}" r ON l."${keyColumn}" = r."${keyColumn}"
          )
        `)

        const countResult = await query<{ count: number }>(
          `SELECT COUNT(*) as count FROM "${resultName}"`
        )
        const rowCount = Number(countResult[0].count)

        return { rowCount }
      }
    }

    // Shard path: handles frozen tables + large datasets
    return joinTablesSharded(leftTable, rightTable, keyColumn, joinType, resultName, onProgress)
    } finally {
      // Phase 4D: Rematerialize active table after combine completes
      if (dematerializedTable) {
        try {
          const { rematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
          await rematerializeActiveTable(dematerializedTable.tableName, dematerializedTable.tableId)
        } catch (err) {
          console.warn('[Combine] Rematerialization failed (table stays frozen):', err)
        }
      }
    }
  })
}
