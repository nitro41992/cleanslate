/**
 * OPFS Migration Utility
 * One-time migration from legacy CSV storage to DuckDB OPFS format
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

export interface MigrationResult {
  migrated: boolean
  tablesImported: number
  auditEntriesRestored: number
  error?: string
}

interface LegacyMetadata {
  tables: Array<{
    id: string
    name: string
    columns: Array<{ name: string; type: string }>
    rowCount: number
    createdAt: string
    updatedAt: string
  }>
  auditEntries?: Array<{
    id: string
    tableId: string
    tableName: string
    action: string
    details: string
    timestamp: string
    rowsAffected?: number
    type?: 'A' | 'B'
  }>
  version: string
}

/**
 * Check if legacy CSV storage exists
 */
async function hasLegacyStorage(): Promise<boolean> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    // Check for metadata.json in cleanslate/ directory
    const cleanslateDir = await opfsRoot.getDirectoryHandle('cleanslate', { create: false })
    await cleanslateDir.getFileHandle('metadata.json', { create: false })
    return true
  } catch {
    return false
  }
}

/**
 * Load legacy metadata.json
 */
async function loadLegacyMetadata(): Promise<LegacyMetadata | null> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const cleanslateDir = await opfsRoot.getDirectoryHandle('cleanslate', { create: false })
    const metadataHandle = await cleanslateDir.getFileHandle('metadata.json', { create: false })
    const file = await metadataHandle.getFile()
    const text = await file.text()
    return JSON.parse(text) as LegacyMetadata
  } catch (err) {
    console.error('[Migration] Failed to load legacy metadata:', err)
    return null
  }
}

/**
 * Delete legacy CSV storage
 * Only called after successful migration with row count verification
 */
async function deleteLegacyStorage(): Promise<void> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    await opfsRoot.removeEntry('cleanslate', { recursive: true })
    console.log('[Migration] Deleted legacy cleanslate/ directory')
  } catch (err) {
    console.warn('[Migration] Could not delete legacy storage:', err)
  }
}

/**
 * Rename legacy storage to backup folder (if migration fails)
 */
async function renameLegacyStorageToBackup(): Promise<void> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()

    // Create backup directory (side effect only - we just need it to exist)
    await opfsRoot.getDirectoryHandle(
      'cleanslate_backup_failed_migration',
      { create: true }
    )

    // Note: OPFS doesn't support renaming directories directly
    // Log warning for user to manually export data
    console.error(
      '[Migration] Row count verification failed. Legacy data preserved in cleanslate/ directory.'
    )
    console.error(
      '[Migration] Please export your data manually before proceeding.'
    )
  } catch (err) {
    console.error('[Migration] Could not create backup directory:', err)
  }
}

/**
 * Migrate from legacy CSV storage to DuckDB OPFS format
 * Called once on first load if legacy storage detected
 */
export async function migrateFromCSVStorage(
  _db: AsyncDuckDB,
  conn: AsyncDuckDBConnection
): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: false,
    tablesImported: 0,
    auditEntriesRestored: 0,
  }

  // Check if legacy storage exists
  const hasLegacy = await hasLegacyStorage()
  if (!hasLegacy) {
    console.log('[Migration] No legacy storage found, skipping migration')
    return result
  }

  console.log('[Migration] Legacy CSV storage detected, starting migration...')

  try {
    // Load legacy metadata
    const metadata = await loadLegacyMetadata()
    if (!metadata) {
      throw new Error('Could not load legacy metadata.json')
    }

    console.log(`[Migration] Found ${metadata.tables.length} tables to migrate`)

    // Track verification failures
    const verificationFailures: string[] = []

    // Migrate each table
    for (const tableMeta of metadata.tables) {
      try {
        // Skip timeline snapshots - these are transient and can be regenerated
        // This acts as forced garbage collection for bloated storage
        if (tableMeta.name.startsWith('_timeline_snapshot_') ||
            tableMeta.name.startsWith('_original_')) {
          console.log(`[Migration] Skipping legacy snapshot: ${tableMeta.name}`)
          continue
        }

        // Import CSV directly via DuckDB's read_csv_auto
        // This is 10-100x faster than manual parsing + INSERT
        const csvPath = `opfs://cleanslate/tables/${tableMeta.id}.csv`

        await conn.query(`
          CREATE OR REPLACE TABLE "${tableMeta.name}" AS
          SELECT * FROM read_csv_auto('${csvPath}')
        `)

        // Verify row count matches metadata (safety check)
        const countResult = await conn.query(
          `SELECT COUNT(*) as count FROM "${tableMeta.name}"`
        )
        const actualRows = Number(countResult.toArray()[0].toJSON().count)

        if (actualRows !== tableMeta.rowCount) {
          console.error(
            `[Migration] Row count mismatch for ${tableMeta.name}: expected ${tableMeta.rowCount}, got ${actualRows}`
          )
          verificationFailures.push(
            `${tableMeta.name} (expected ${tableMeta.rowCount} rows, got ${actualRows})`
          )
          // Don't throw - continue with other tables
          continue
        }

        console.log(`[Migration] Imported table: ${tableMeta.name} (${actualRows} rows)`)
        result.tablesImported++
      } catch (err) {
        console.error(`[Migration] Failed to import table ${tableMeta.name}:`, err)
        verificationFailures.push(`${tableMeta.name} (import failed)`)
      }
    }

    // Import audit details if exists
    try {
      const auditPath = 'opfs://cleanslate/audit_details.csv'
      await conn.query(`
        CREATE OR REPLACE TABLE "_audit_details" AS
        SELECT * FROM read_csv_auto('${auditPath}')
      `)

      const countResult = await conn.query(
        'SELECT COUNT(*) as count FROM "_audit_details"'
      )
      result.auditEntriesRestored = Number(countResult.toArray()[0].toJSON().count)

      console.log(`[Migration] Imported ${result.auditEntriesRestored} audit detail rows`)
    } catch (err) {
      console.warn('[Migration] Could not import audit details (non-fatal):', err)
    }

    // Check if migration was successful
    if (verificationFailures.length > 0) {
      // Partial failure - preserve legacy data
      result.error = `Row count verification failed for ${verificationFailures.length} table(s): ${verificationFailures.join(', ')}`
      await renameLegacyStorageToBackup()
      console.error(`[Migration] ${result.error}`)
    } else {
      // Full success - delete legacy storage
      await deleteLegacyStorage()
      console.log(
        `[Migration] Successfully migrated ${result.tablesImported} tables, deleting legacy storage`
      )
    }

    result.migrated = true
    return result
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[Migration] Migration failed:', errorMsg)
    result.error = errorMsg

    // Preserve legacy data on error
    await renameLegacyStorageToBackup()

    return result
  }
}
