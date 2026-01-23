/**
 * Audit Log Pruning Utility
 * Prevents database bloat by keeping only the last 100 audit entries
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

/**
 * Prune old audit entries to prevent database bloat
 * Keeps only the last 100 entries in _audit_details table
 * Called on app initialization after migration
 */
export async function pruneAuditLog(conn: AsyncDuckDBConnection): Promise<number> {
  try {
    // Check if _audit_details table exists
    const tableExistsResult = await conn.query(`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_name = '_audit_details'
    `)
    const tableExists = Number(tableExistsResult.toArray()[0].toJSON().count) > 0

    if (!tableExists) {
      console.log('[Audit Pruning] No _audit_details table found, skipping')
      return 0
    }

    // Get current count
    const countResult = await conn.query(
      'SELECT COUNT(*) as count FROM "_audit_details"'
    )
    const totalCount = Number(countResult.toArray()[0].toJSON().count)

    if (totalCount <= 100) {
      console.log(`[Audit Pruning] Only ${totalCount} entries, no pruning needed`)
      return 0
    }

    // Keep only last 100 entries (newest by entry_id)
    // Delete older entries
    await conn.query(`
      DELETE FROM "_audit_details"
      WHERE entry_id NOT IN (
        SELECT entry_id
        FROM "_audit_details"
        ORDER BY entry_id DESC
        LIMIT 100
      )
    `)

    const prunedCount = totalCount - 100
    console.log(`[Audit Pruning] Pruned ${prunedCount} old audit entries (kept last 100)`)

    return prunedCount
  } catch (err) {
    console.warn('[Audit Pruning] Failed to prune audit log:', err)
    return 0
  }
}
