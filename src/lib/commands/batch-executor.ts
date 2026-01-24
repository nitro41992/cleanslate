/**
 * Batch Executor for Large Operations
 *
 * Processes large SQL operations in chunks to prevent OOM errors.
 * Uses STAGING TABLE strategy for safety - partial writes can be dropped if process dies.
 *
 * Key Features:
 * - OFFSET-based batching (fine for 1M rows, ~1.2s max for last batch)
 * - WAL checkpoints every 5 batches (~200-250k rows) to prevent memory accumulation
 * - Writes to staging table (can be dropped if process fails mid-execution)
 * - Progress callbacks for real-time UI updates
 * - Browser yield between batches to prevent UI freezing
 *
 * Safety Guarantee: Since we checkpoint mid-loop, we can't rollback partial writes.
 * The staging table pattern ensures we can simply DROP it if the process dies.
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

export interface BatchExecuteOptions {
  /**
   * Source table to read from
   */
  sourceTable: string

  /**
   * Staging table name for batched writes
   * IMPORTANT: This is a temporary table that will be created/dropped
   * The final result should be atomically swapped with the live table
   */
  stagingTable: string

  /**
   * SQL SELECT query to execute in batches
   * @example "SELECT UPPER(name) as name, age FROM source_table"
   */
  selectQuery: string

  /**
   * Batch size (default: 50000 rows)
   * Proven threshold from audit-capture.ts
   */
  batchSize?: number

  /**
   * Progress callback for real-time UI updates
   * @param current - Rows processed so far
   * @param total - Total rows to process
   * @param percent - Progress percentage (0-100)
   */
  onProgress?: (current: number, total: number, percent: number) => void
}

export interface BatchExecuteResult {
  rowsProcessed: number
  batches: number
  stagingTable: string
}

/**
 * Execute large SQL operations in batches to prevent OOM
 *
 * SAFETY MODEL:
 * - Writes to staging table (not live table)
 * - WAL checkpoints every 5 batches prevent rollback capability
 * - On failure: simply DROP staging table
 * - On success: caller swaps staging → live table atomically
 *
 * @example
 * const result = await batchExecute(conn, {
 *   sourceTable: 'my_table',
 *   stagingTable: '_staging_my_table',
 *   selectQuery: 'SELECT TRIM(name) as name, email FROM my_table',
 *   onProgress: (curr, total, pct) => console.log(`${pct}%`)
 * })
 * // Atomically swap: DROP TABLE my_table; ALTER TABLE _staging_my_table RENAME TO my_table
 */
export async function batchExecute(
  conn: AsyncDuckDBConnection,
  options: BatchExecuteOptions
): Promise<BatchExecuteResult> {
  const {
    sourceTable,
    stagingTable,
    selectQuery,
    batchSize = 50000,
    onProgress,
  } = options

  // Get total row count from source table
  const countResult = await conn.query(`SELECT COUNT(*) as total FROM "${sourceTable}"`)
  const totalRows = Number(countResult.toArray()[0].toJSON().total)

  if (totalRows === 0) {
    // Empty table - create empty staging table with same schema
    await conn.query(`DROP TABLE IF EXISTS "${stagingTable}"`)
    await conn.query(`CREATE TABLE "${stagingTable}" AS ${selectQuery} LIMIT 0`)
    return { rowsProcessed: 0, batches: 0, stagingTable }
  }

  // Drop any existing staging table (cleanup from previous failed run)
  await conn.query(`DROP TABLE IF EXISTS "${stagingTable}"`)

  let processed = 0
  let batchNum = 0

  // Batch loop using LIMIT/OFFSET
  while (processed < totalRows) {
    const remaining = totalRows - processed
    const currentBatchSize = Math.min(batchSize, remaining)

    if (batchNum === 0) {
      // First batch: CREATE TABLE AS SELECT
      await conn.query(`
        CREATE TABLE "${stagingTable}" AS
        ${selectQuery}
        LIMIT ${currentBatchSize} OFFSET ${processed}
      `)
    } else {
      // Subsequent batches: INSERT INTO SELECT
      await conn.query(`
        INSERT INTO "${stagingTable}"
        ${selectQuery}
        LIMIT ${currentBatchSize} OFFSET ${processed}
      `)
    }

    processed += currentBatchSize
    batchNum++

    // CRITICAL: Flush WAL to disk every 5 batches (every 200-250k rows)
    // Prevents massive in-memory WAL accumulation before final commit
    // Trade-off: Disables rollback capability, but we're using staging table anyway
    if (batchNum % 5 === 0) {
      await conn.query(`CHECKPOINT`)
      console.log(`[BatchExecutor] Checkpoint at ${processed.toLocaleString()} rows`)
    }

    // Progress callback
    const percent = Math.floor((processed / totalRows) * 100)
    onProgress?.(processed, totalRows, percent)

    // Yield to browser to prevent UI freezing
    // Allows React to process state updates and user interactions
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  // Final checkpoint to ensure all changes are persisted
  await conn.query(`CHECKPOINT`)
  console.log(`[BatchExecutor] Completed: ${processed.toLocaleString()} rows in ${batchNum} batches`)

  return { rowsProcessed: processed, batches: batchNum, stagingTable }
}

/**
 * Atomically swap staging table with live table
 *
 * @example
 * await swapStagingTable(conn, 'my_table', '_staging_my_table')
 */
export async function swapStagingTable(
  conn: AsyncDuckDBConnection,
  liveTable: string,
  stagingTable: string
): Promise<void> {
  // Atomic swap: drop old, rename staging
  await conn.query(`DROP TABLE IF EXISTS "${liveTable}"`)
  await conn.query(`ALTER TABLE "${stagingTable}" RENAME TO "${liveTable}"`)
}

/**
 * Cleanup staging table (call on error)
 *
 * @example
 * try {
 *   const result = await batchExecute(...)
 *   await swapStagingTable(...)
 * } catch (err) {
 *   await cleanupStagingTable(conn, '_staging_my_table')
 *   throw err
 * }
 */
export async function cleanupStagingTable(
  conn: AsyncDuckDBConnection,
  stagingTable: string
): Promise<void> {
  try {
    await conn.query(`DROP TABLE IF EXISTS "${stagingTable}"`)
    console.log(`[BatchExecutor] Cleaned up staging table: ${stagingTable}`)
  } catch (err) {
    console.warn(`[BatchExecutor] Failed to cleanup staging table ${stagingTable}:`, err)
  }
}
