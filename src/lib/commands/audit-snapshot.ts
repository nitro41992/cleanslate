/**
 * Audit Snapshot Utilities
 *
 * Pre/post snapshot capture for Tier 1 transforms.
 * Instead of relying solely on __base columns, this captures
 * actual before/after values at execution time.
 *
 * Usage:
 * 1. Before transform: capturePreSnapshot() stores affected rows
 * 2. After transform: capturePostDiff() compares and stores differences
 */

import type { DbConnection } from './audit-capture'
import { ensureAuditDetailsTable, ROW_DETAIL_THRESHOLD } from './audit-capture'

/**
 * Generate a safe table name suffix from an audit entry ID.
 * Uses first 8 chars, replacing invalid characters.
 */
function getSafeIdSuffix(auditEntryId: string): string {
  // Replace any non-alphanumeric characters with underscore
  return auditEntryId.slice(0, 8).replace(/[^a-zA-Z0-9]/g, '_')
}

/**
 * Capture pre-transform values for affected rows.
 * Creates a temporary table storing the current values before transformation.
 *
 * @param db - Database connection
 * @param tableName - Name of the table being transformed
 * @param column - Column being transformed
 * @param auditEntryId - Unique ID for this audit entry
 * @param affectedPredicate - SQL predicate to identify affected rows (optional)
 */
export async function capturePreSnapshot(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  affectedPredicate?: string
): Promise<void> {
  const safeSuffix = getSafeIdSuffix(auditEntryId)
  const tempTableName = `_audit_pre_${safeSuffix}`
  const quotedCol = `"${column}"`

  // Build WHERE clause - if no predicate, use 1=1 (all rows)
  const whereClause = affectedPredicate || '1=1'

  // Create temp table with affected row values
  // Note: Using _cs_id for row identity (stable UUID), not rowid (may change)
  const sql = `
    CREATE TEMP TABLE IF NOT EXISTS "${tempTableName}" AS
    SELECT "_cs_id", CAST(${quotedCol} AS VARCHAR) AS value
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  try {
    await db.execute(sql)
  } catch (err) {
    // Non-fatal - don't fail the transform if snapshot creation fails
    console.warn(`[AUDIT-SNAPSHOT] Failed to create pre-snapshot: ${err}`)
  }
}

/**
 * Compare pre-snapshot with current values and store differences.
 * Only captures rows where the value actually changed.
 *
 * @param db - Database connection
 * @param tableName - Name of the table that was transformed
 * @param column - Column that was transformed
 * @param auditEntryId - Unique ID for this audit entry
 * @returns true if any row details were captured
 */
export async function capturePostDiff(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string
): Promise<boolean> {
  await ensureAuditDetailsTable(db)

  const safeSuffix = getSafeIdSuffix(auditEntryId)
  const tempTableName = `_audit_pre_${safeSuffix}`
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  // Check if pre-snapshot table exists
  let tableExists = false
  try {
    const checkSql = `SELECT 1 FROM "${tempTableName}" LIMIT 1`
    await db.query(checkSql)
    tableExists = true
  } catch {
    // Table doesn't exist - snapshot wasn't created
    console.warn(`[AUDIT-SNAPSHOT] Pre-snapshot table not found: ${tempTableName}`)
    return false
  }

  if (!tableExists) return false

  // Compare pre-snapshot with current values, insert differences
  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      (ROW_NUMBER() OVER ()) as row_index,
      '${escapedColumn}',
      pre.value,
      CAST(t.${quotedCol} AS VARCHAR),
      CURRENT_TIMESTAMP
    FROM "${tableName}" t
    JOIN "${tempTableName}" pre ON t."_cs_id" = pre."_cs_id"
    WHERE pre.value IS DISTINCT FROM CAST(t.${quotedCol} AS VARCHAR)
  `

  try {
    await db.execute(insertSql)
  } catch (err) {
    console.warn(`[AUDIT-SNAPSHOT] Failed to capture post-diff: ${err}`)
  }

  // Cleanup temp table
  try {
    await db.execute(`DROP TABLE IF EXISTS "${tempTableName}"`)
  } catch {
    // Ignore cleanup errors
  }

  // Check if any details were inserted
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Helper to check if any row details were inserted for an audit entry.
 */
async function checkRowDetailsInserted(db: DbConnection, auditEntryId: string): Promise<boolean> {
  const countResult = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM _audit_details WHERE audit_entry_id = '${auditEntryId}'`
  )
  return Number(countResult[0]?.count ?? 0) > 0
}

/**
 * Cleanup any orphaned pre-snapshot tables.
 * Called during startup or error recovery.
 */
export async function cleanupOrphanedSnapshots(db: DbConnection): Promise<void> {
  try {
    // Find all temp tables matching our pattern
    const tables = await db.query<{ name: string }>(`
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_name LIKE '_audit_pre_%'
    `)

    for (const { name } of tables) {
      try {
        await db.execute(`DROP TABLE IF EXISTS "${name}"`)
        console.log(`[AUDIT-SNAPSHOT] Cleaned up orphaned snapshot: ${name}`)
      } catch {
        // Ignore individual table cleanup errors
      }
    }
  } catch (err) {
    console.warn(`[AUDIT-SNAPSHOT] Failed to cleanup orphaned snapshots: ${err}`)
  }
}
