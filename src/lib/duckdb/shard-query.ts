/**
 * Shard-Backed Query Functions
 *
 * Provides grid-compatible query functions that route through ChunkManager
 * instead of querying a DuckDB table directly. Used when a table is in
 * "shard-backed" mode (frozen to OPFS, not materialized in DuckDB).
 *
 * These functions produce the same result shapes as their counterparts in
 * duckdb/index.ts, so the grid component works identically in both modes.
 */

import { getChunkManager } from '@/lib/opfs/chunk-manager'
import type { SnapshotManifest } from '@/lib/opfs/manifest'
import { getConnection } from '@/lib/duckdb'
import { CS_ID_COLUMN, filterInternalColumns, normalizeCsId } from '@/lib/duckdb'
import type { ArrowKeysetPageResult, KeysetCursor } from '@/lib/duckdb'

/**
 * Get the normalized snapshot ID for a table name.
 * Mirrors the normalization in freezeTable/thawTable.
 */
function getSnapshotId(tableName: string): string {
  return tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
}

/**
 * Find which shard(s) contain rows for a given _cs_id range.
 * Uses minCsId/maxCsId from manifest when available, falls back to
 * cumulative row count lookup.
 */
function findShardsForCsId(
  manifest: SnapshotManifest,
  csId: number | null
): number[] {
  if (csId === null) return [0] // First page → first shard

  // Try range-based lookup if minCsId/maxCsId are populated
  const hasRanges = manifest.shards.every(s => s.minCsId != null && s.maxCsId != null)
  if (hasRanges) {
    const matching: number[] = []
    for (const shard of manifest.shards) {
      if (csId >= shard.minCsId! && csId <= shard.maxCsId!) {
        matching.push(shard.index)
      }
    }
    // Also include the next shard (for cross-boundary pages)
    if (matching.length > 0) {
      const lastMatch = matching[matching.length - 1]
      if (lastMatch + 1 < manifest.shards.length) {
        matching.push(lastMatch + 1)
      }
    }
    return matching.length > 0 ? matching : [0]
  }

  // Fallback: return all shards (will be filtered by DuckDB WHERE clause)
  return manifest.shards.map(s => s.index)
}

/**
 * Find which shard contains a given global row index using cumulative row counts.
 */
function findShardForRowIndex(
  manifest: SnapshotManifest,
  rowIndex: number
): { shardIndex: number; localOffset: number } {
  let cumulative = 0
  for (const shard of manifest.shards) {
    if (rowIndex < cumulative + shard.rowCount) {
      return {
        shardIndex: shard.index,
        localOffset: rowIndex - cumulative,
      }
    }
    cumulative += shard.rowCount
  }
  // Past end — return last shard
  const lastShard = manifest.shards[manifest.shards.length - 1]
  return {
    shardIndex: lastShard.index,
    localOffset: lastShard.rowCount - 1,
  }
}

/**
 * Shard-backed version of getTableDataArrowWithKeyset.
 *
 * Loads the relevant shard(s) via ChunkManager, queries the temp table(s),
 * and returns the same ArrowKeysetPageResult shape as the direct DuckDB path.
 *
 * @param tableName - Original table name (for snapshot ID resolution)
 * @param cursor - Keyset pagination cursor
 * @param limit - Number of rows to fetch
 * @param startRow - Starting row index for this page
 */
export async function getShardDataArrowWithKeyset(
  tableName: string,
  cursor: KeysetCursor,
  limit: number,
  startRow: number
): Promise<ArrowKeysetPageResult> {
  const snapshotId = getSnapshotId(tableName)
  const chunkManager = getChunkManager()
  const manifest = await chunkManager.getManifest(snapshotId)
  const conn = await getConnection()

  // Determine which shard(s) to load
  const csIdNum = cursor.csId ? Number(cursor.csId) : null
  let shardIndices: number[]

  if (!cursor.csId) {
    // First page — start from beginning
    shardIndices = [0]
    // Also load shard 1 if page might span boundary
    if (manifest.shards.length > 1 && limit > manifest.shards[0].rowCount) {
      shardIndices.push(1)
    }
  } else {
    shardIndices = findShardsForCsId(manifest, csIdNum)
  }

  // Load the required shards
  const loadedTables: string[] = []
  for (const idx of shardIndices) {
    if (idx < manifest.shards.length) {
      const tempTable = await chunkManager.loadShard(snapshotId, idx)
      loadedTables.push(tempTable)
    }
  }

  if (loadedTables.length === 0) {
    // Empty result
    const emptyResult = await conn.query('SELECT 1 WHERE false')
    return {
      arrowTable: emptyResult,
      columns: manifest.columns.filter(c => c !== CS_ID_COLUMN && c !== '_cs_origin_id'),
      rowIndexToCsId: new Map(),
      firstCsId: null,
      lastCsId: null,
      hasMore: false,
      startRow,
    }
  }

  // Build a UNION ALL view across loaded shards for querying
  let sourceExpr: string
  if (loadedTables.length === 1) {
    sourceExpr = `"${loadedTables[0]}"`
  } else {
    // UNION ALL across multiple shard temp tables
    sourceExpr = `(${loadedTables.map(t => `SELECT * FROM "${t}"`).join(' UNION ALL ')})`
  }

  // Build WHERE clause (same logic as getTableDataArrowWithKeyset)
  const whereConditions: string[] = []
  if (cursor.whereClause) {
    whereConditions.push(`(${cursor.whereClause})`)
  }

  const hasCustomSort = Boolean(cursor.orderByClause)
  const orderByClause = cursor.orderByClause || `"${CS_ID_COLUMN}"`

  let query: string
  if (!cursor.csId) {
    const whereStr = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : ''
    query = `SELECT * FROM ${sourceExpr} ${whereStr} ORDER BY ${orderByClause} LIMIT ${limit + 1}`
  } else if (hasCustomSort) {
    const whereStr = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : ''
    query = `SELECT * FROM ${sourceExpr} ${whereStr} ORDER BY ${orderByClause} LIMIT ${limit + 1}`
  } else if (cursor.direction === 'forward') {
    whereConditions.push(`"${CS_ID_COLUMN}" > ${cursor.csId}`)
    const whereStr = `WHERE ${whereConditions.join(' AND ')}`
    query = `SELECT * FROM ${sourceExpr} ${whereStr} ORDER BY ${orderByClause} LIMIT ${limit + 1}`
  } else {
    whereConditions.push(`"${CS_ID_COLUMN}" < ${cursor.csId}`)
    const whereStr = `WHERE ${whereConditions.join(' AND ')}`
    query = `SELECT * FROM ${sourceExpr} ${whereStr} ORDER BY "${CS_ID_COLUMN}" DESC LIMIT ${limit + 1}`
  }

  const result = await conn.query(query)

  // Process result (same as getTableDataArrowWithKeyset)
  const hasMore = result.numRows > limit
  const allColumns = result.schema.fields.map(f => f.name)
  const columns = filterInternalColumns(allColumns)
  const csIdColIndex = allColumns.indexOf(CS_ID_COLUMN)

  const rowIndexToCsId = new Map<number, string>()
  const rowCount = Math.min(result.numRows, limit)

  if (csIdColIndex >= 0) {
    const csIdVector = result.getChildAt(csIdColIndex)
    if (csIdVector) {
      for (let i = 0; i < rowCount; i++) {
        const csIdValue = csIdVector.get(i)
        if (csIdValue !== null && csIdValue !== undefined) {
          rowIndexToCsId.set(i, normalizeCsId(csIdValue))
        }
      }
    }
  }

  let firstCsId: string | null = null
  let lastCsId: string | null = null
  if (rowCount > 0 && csIdColIndex >= 0) {
    const csIdVector = result.getChildAt(csIdColIndex)
    if (csIdVector) {
      firstCsId = normalizeCsId(csIdVector.get(0))
      lastCsId = normalizeCsId(csIdVector.get(rowCount - 1))
    }
  }

  return {
    arrowTable: result,
    columns,
    rowIndexToCsId,
    firstCsId,
    lastCsId,
    hasMore,
    startRow,
  }
}

/**
 * Shard-backed version of estimateCsIdForRow.
 *
 * Finds the right shard via cumulative row counts, loads it,
 * and queries the _cs_id at the local offset.
 *
 * @param tableName - Original table name
 * @param rowIndex - 0-based global row index
 * @returns _cs_id value as string, or null if out of range
 */
export async function estimateShardCsIdForRow(
  tableName: string,
  rowIndex: number
): Promise<string | null> {
  const snapshotId = getSnapshotId(tableName)
  const chunkManager = getChunkManager()

  let manifest: SnapshotManifest
  try {
    manifest = await chunkManager.getManifest(snapshotId)
  } catch {
    return null // No manifest = no data
  }

  if (rowIndex < 0 || rowIndex >= manifest.totalRows) {
    return null
  }

  const { shardIndex, localOffset } = findShardForRowIndex(manifest, rowIndex)
  const tempTable = await chunkManager.loadShard(snapshotId, shardIndex)
  const conn = await getConnection()

  const result = await conn.query(
    `SELECT "${CS_ID_COLUMN}" FROM "${tempTable}" ORDER BY CAST("${CS_ID_COLUMN}" AS BIGINT) LIMIT 1 OFFSET ${localOffset}`
  )
  const rows = result.toArray()
  if (rows.length === 0) return null
  return String(rows[0]?.toJSON()?.[CS_ID_COLUMN] ?? null)
}
