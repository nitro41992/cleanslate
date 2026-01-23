/**
 * Column Version Manager
 *
 * Manages Tier 1 undo operations using column versioning.
 * Instead of snapshots, we use ADD COLUMN + RENAME to preserve original data.
 *
 * Strategy:
 * 1. Execute (e.g., trim on "Email"):
 *    - RENAME "Email" TO "Email__backup_v1"
 *    - ADD COLUMN "Email" AS (TRIM("Email__backup_v1"))
 *
 * 2. Undo:
 *    - DROP COLUMN "Email"
 *    - RENAME "Email__backup_v1" TO "Email"
 *
 * Key Advantage: Column name stays the same. No UI changes needed.
 * Zero-copy operation - instant regardless of row count.
 */

import type { ColumnVersionInfo } from './types'
import {
  quoteColumn,
  quoteTable,
  getBackupColumnName,
  isBackupColumn,
  getOriginalFromBackup,
} from './utils/sql'

export interface ColumnVersionManager {
  /** Get version info for a column */
  getVersion(column: string): ColumnVersionInfo | undefined

  /** Create a new version of a column (for execute) */
  createVersion(
    tableName: string,
    column: string,
    expression: string,
    commandId: string
  ): Promise<VersionResult>

  /** Undo to previous version (drop current, restore backup) */
  undoVersion(tableName: string, column: string): Promise<UndoResult>

  /** Get all columns that have version history */
  getVersionedColumns(): string[]

  /** Clean up old versions (prune history) */
  pruneOldVersions(tableName: string, maxVersions?: number): Promise<number>
}

export interface VersionResult {
  success: boolean
  originalColumn: string
  backupColumn: string
  version: number
  error?: string
}

export interface UndoResult {
  success: boolean
  restoredColumn: string
  droppedBackup: string
  error?: string
}

export interface ColumnVersionStore {
  versions: Map<string, ColumnVersionInfo>
}

/**
 * Create a column version manager for a specific table
 */
export function createColumnVersionManager(
  db: {
    execute: (sql: string) => Promise<void>
    query: <T>(sql: string) => Promise<T[]>
  },
  store: ColumnVersionStore
): ColumnVersionManager {
  const { versions } = store

  return {
    getVersion(column: string): ColumnVersionInfo | undefined {
      return versions.get(column)
    },

    async createVersion(
      tableName: string,
      column: string,
      expression: string,
      commandId: string
    ): Promise<VersionResult> {
      try {
        // Get or create version info for this column
        let versionInfo = versions.get(column)
        const newVersion = versionInfo ? versionInfo.currentVersion + 1 : 1

        // Generate backup column name
        const backupColumn = getBackupColumnName(column, newVersion)

        // Step 1: Rename original to backup
        const renameSQL = `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(column)} TO ${quoteColumn(backupColumn)}`
        await db.execute(renameSQL)

        // Step 2: Add new column with transformed data (using the original name)
        // Replace column reference in expression with backup column
        const transformedExpression = expression.replace(
          new RegExp(`"${column}"`, 'g'),
          quoteColumn(backupColumn)
        )
        const addSQL = `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${transformedExpression})`
        await db.execute(addSQL)

        // Update version store
        if (!versionInfo) {
          versionInfo = {
            originalColumn: column,
            currentVersion: newVersion,
            versionHistory: [],
          }
          versions.set(column, versionInfo)
        } else {
          versionInfo.currentVersion = newVersion
        }

        versionInfo.versionHistory.push({
          version: newVersion,
          columnName: backupColumn,
          commandId,
        })

        return {
          success: true,
          originalColumn: column,
          backupColumn,
          version: newVersion,
        }
      } catch (error) {
        return {
          success: false,
          originalColumn: column,
          backupColumn: '',
          version: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async undoVersion(
      tableName: string,
      column: string
    ): Promise<UndoResult> {
      try {
        const versionInfo = versions.get(column)
        if (!versionInfo || versionInfo.versionHistory.length === 0) {
          return {
            success: false,
            restoredColumn: column,
            droppedBackup: '',
            error: `No version history for column ${column}`,
          }
        }

        // Get the most recent version
        const lastVersion = versionInfo.versionHistory.pop()!
        const backupColumn = lastVersion.columnName

        // Step 1: Drop the computed column (current "original" name)
        const dropSQL = `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)}`
        await db.execute(dropSQL)

        // Step 2: Rename backup back to original name
        const renameSQL = `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(backupColumn)} TO ${quoteColumn(column)}`
        await db.execute(renameSQL)

        // Update version info
        if (versionInfo.versionHistory.length === 0) {
          // No more versions, remove from store
          versions.delete(column)
        } else {
          versionInfo.currentVersion =
            versionInfo.versionHistory[versionInfo.versionHistory.length - 1].version
        }

        return {
          success: true,
          restoredColumn: column,
          droppedBackup: backupColumn,
        }
      } catch (error) {
        return {
          success: false,
          restoredColumn: column,
          droppedBackup: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },

    getVersionedColumns(): string[] {
      return Array.from(versions.keys())
    },

    async pruneOldVersions(
      tableName: string,
      maxVersions: number = 10
    ): Promise<number> {
      let pruned = 0

      for (const [column, versionInfo] of versions.entries()) {
        while (versionInfo.versionHistory.length > maxVersions) {
          // Remove oldest version
          const oldest = versionInfo.versionHistory.shift()
          if (oldest) {
            try {
              // Drop the old backup column
              const dropSQL = `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN IF EXISTS ${quoteColumn(oldest.columnName)}`
              await db.execute(dropSQL)
              pruned++
            } catch {
              // Column might already be gone, ignore
            }
          }
        }

        // Remove from store if no versions left
        if (versionInfo.versionHistory.length === 0) {
          versions.delete(column)
        }
      }

      return pruned
    },
  }
}

/**
 * Scan a table for existing backup columns and rebuild version store
 * Useful for recovery or migration scenarios
 */
export async function scanForBackupColumns(
  db: { query: <T>(sql: string) => Promise<T[]> },
  tableName: string
): Promise<Map<string, ColumnVersionInfo>> {
  const result = new Map<string, ColumnVersionInfo>()

  // Query column names from information_schema
  const columns = await db.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `)

  // Find backup columns and group by original column
  const backupColumns: { original: string; backup: string; version: number }[] = []

  for (const col of columns) {
    if (isBackupColumn(col.column_name)) {
      const original = getOriginalFromBackup(col.column_name)
      const versionMatch = col.column_name.match(/__backup_v(\d+)$/)
      if (original && versionMatch) {
        backupColumns.push({
          original,
          backup: col.column_name,
          version: parseInt(versionMatch[1], 10),
        })
      }
    }
  }

  // Group by original column
  const grouped = new Map<string, typeof backupColumns>()
  for (const bc of backupColumns) {
    const list = grouped.get(bc.original) || []
    list.push(bc)
    grouped.set(bc.original, list)
  }

  // Build version info
  for (const [original, backups] of grouped) {
    // Sort by version ascending
    backups.sort((a, b) => a.version - b.version)

    const versionInfo: ColumnVersionInfo = {
      originalColumn: original,
      currentVersion: backups[backups.length - 1].version,
      versionHistory: backups.map((b) => ({
        version: b.version,
        columnName: b.backup,
        commandId: 'recovered', // Unknown command ID during recovery
      })),
    }

    result.set(original, versionInfo)
  }

  return result
}

/**
 * Get SQL to undo a Tier 1 operation (for preview/dry-run)
 */
export function getTier1UndoSQL(
  tableName: string,
  column: string,
  backupColumn: string
): string[] {
  return [
    `-- Step 1: Drop the computed column`,
    `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)};`,
    `-- Step 2: Restore from backup`,
    `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(backupColumn)} TO ${quoteColumn(column)};`,
  ]
}

/**
 * Get SQL for a Tier 1 transformation (for preview/dry-run)
 */
export function getTier1ExecuteSQL(
  tableName: string,
  column: string,
  expression: string,
  version: number
): string[] {
  const backupColumn = getBackupColumnName(column, version)
  const transformedExpr = expression.replace(
    new RegExp(`"${column}"`, 'g'),
    quoteColumn(backupColumn)
  )

  return [
    `-- Step 1: Backup original column`,
    `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(column)} TO ${quoteColumn(backupColumn)};`,
    `-- Step 2: Create transformed column with original name`,
    `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${transformedExpr});`,
  ]
}
