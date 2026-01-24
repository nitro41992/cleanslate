/**
 * Column Version Manager - Expression Chaining (Table Recreation Pattern)
 *
 * Manages Tier 1 undo operations using expression chaining on a single base column.
 * Instead of creating multiple backup columns, we chain expressions together.
 *
 * NOTE: DuckDB WASM doesn't support adding computed columns after table creation,
 * so we use a CTAS (Create Table As Select) pattern with regular columns instead.
 *
 * Strategy:
 * 1. First transform on "Email":
 *    - CREATE TABLE temp AS SELECT *, "Email" AS "Email__base", TRIM("Email") AS "Email_new" FROM t
 *    - DROP TABLE t
 *    - ALTER TABLE temp RENAME TO t
 *    - DROP COLUMN "Email", RENAME "Email_new" TO "Email"
 *    (Simplified: use CTAS to rebuild with both base and transformed columns)
 *
 * 2. Chained transforms use the same pattern, re-computing from base
 *
 * 3. Undo: Recreate table with previous expression (or restore from base for full undo)
 *
 * Key Advantages:
 * - Column name stays the same throughout - no UI changes needed
 * - Single base column regardless of transform count
 * - Works with DuckDB WASM limitations
 * - Chained transforms work correctly
 */

import type { ColumnVersionInfo, ExpressionEntry } from './types'
import { quoteColumn, quoteTable } from './utils/sql'
import { duplicateTable, dropTable } from '@/lib/duckdb'

/** Placeholder token for column reference in expressions */
export const COLUMN_PLACEHOLDER = '{{COL}}'

/**
 * After this many transforms on a single column, materialize the result.
 * This prevents expression stacks from growing too large.
 */
export const COLUMN_MATERIALIZATION_THRESHOLD = 10

/** Pre-compiled regex for replacing the placeholder */
const PLACEHOLDER_REGEX = /\{\{COL\}\}/g

/**
 * Replace {{COL}} placeholder with a value
 */
function replacePlaceholder(expression: string, value: string): string {
  return expression.replace(PLACEHOLDER_REGEX, value)
}

export interface ColumnVersionManager {
  /** Get version info for a column */
  getVersion(column: string): ColumnVersionInfo | undefined

  /** Check if a column has any versioning active */
  hasVersion(column: string): boolean

  /**
   * Create or extend versioning for a column (for execute)
   * @param tableName - Name of the table
   * @param column - Column to transform
   * @param expression - SQL expression with {{COL}} placeholder
   * @param commandId - ID of the command
   */
  createVersion(
    tableName: string,
    column: string,
    expression: string,
    commandId: string
  ): Promise<VersionResult>

  /** Undo the last transform on a column (pop expression stack) */
  undoVersion(tableName: string, column: string): Promise<UndoResult>

  /** Get all columns that have version history */
  getVersionedColumns(): string[]

  /** Clean up old versions (drop base column after full restore) */
  cleanup(tableName: string, column: string): Promise<void>
}

export interface VersionResult {
  success: boolean
  originalColumn: string
  baseColumn: string
  expressionCount: number
  error?: string
}

export interface UndoResult {
  success: boolean
  restoredColumn: string
  expressionsRemaining: number
  fullyRestored: boolean
  error?: string
}

export interface ColumnVersionStore {
  versions: Map<string, ColumnVersionInfo>
}

/**
 * Build a nested SQL expression from expression stack
 * @param stack - Array of expressions with {{COL}} placeholder
 * @param baseColumn - The base column name (already quoted)
 * @returns Final nested SQL expression
 *
 * Example:
 *   stack: [{expr: 'TRIM({{COL}})'}, {expr: 'LOWER({{COL}})'}]
 *   baseColumn: "Email__base"
 *   Result: LOWER(TRIM("Email__base"))
 */
export function buildNestedExpression(
  stack: ExpressionEntry[],
  baseColumn: string
): string {
  if (stack.length === 0) {
    return quoteColumn(baseColumn)
  }

  let result = quoteColumn(baseColumn)
  for (const { expression } of stack) {
    // Replace {{COL}} placeholder with current result
    result = replacePlaceholder(expression, result)
  }
  return result
}

/**
 * Get the base column name for a given column
 */
export function getBaseColumnName(originalColumn: string): string {
  return `${originalColumn}__base`
}

/**
 * Check if a column name is a base column
 */
export function isBaseColumn(columnName: string): boolean {
  return columnName.endsWith('__base')
}

/**
 * Extract original column name from base column name
 */
export function getOriginalFromBase(baseColumnName: string): string | null {
  if (!isBaseColumn(baseColumnName)) {
    return null
  }
  return baseColumnName.slice(0, -7) // Remove '__base' suffix
}

/**
 * Materialize a column by copying the current computed value back to base.
 * Creates a snapshot for undo safety and resets the expression stack.
 *
 * This is called when expression stack reaches COLUMN_MATERIALIZATION_THRESHOLD
 * to prevent expressions from growing too large and impacting performance.
 *
 * MEMORY OPTIMIZATION: Exports snapshot to Parquet instead of keeping in RAM
 */
async function materializeColumn(
  db: {
    execute: (sql: string) => Promise<void>
    query: <T>(sql: string) => Promise<T[]>
  },
  tableName: string,
  column: string,
  versionInfo: ColumnVersionInfo
): Promise<void> {
  // Create snapshot for undo safety (in case user wants to undo past materialization)
  const snapshotName = `_mat_${tableName}_${column}_${Date.now()}`
  await duplicateTable(tableName, snapshotName, true)

  // MEMORY OPTIMIZATION: Export snapshot to Parquet and drop from RAM
  // This preserves undo functionality while freeing memory
  try {
    const { initDuckDB, getConnection } = await import('@/lib/duckdb')
    const { exportTableToParquet } = await import('@/lib/opfs/snapshot-storage')

    const duckdb = await initDuckDB()
    const conn = await getConnection()
    const snapshotId = `mat_${tableName}_${column}_${Date.now()}`

    // Export to OPFS Parquet
    await exportTableToParquet(duckdb, conn, snapshotName, snapshotId)

    // Drop the in-memory duplicate (snapshot now in OPFS)
    await dropTable(snapshotName)
    console.log(`[Materialization] Exported snapshot to OPFS, dropped from RAM`)

    // Store Parquet reference for potential undo
    versionInfo.materializationSnapshot = `parquet:${snapshotId}`
    versionInfo.materializationPosition = versionInfo.expressionStack.length

  } catch (error) {
    // On failure, keep in-memory snapshot as fallback
    console.error('[Materialization] Parquet export failed, keeping in-memory snapshot:', error)
    versionInfo.materializationSnapshot = snapshotName
    versionInfo.materializationPosition = versionInfo.expressionStack.length
  }

  // Materialize: copy current computed value to base column
  // This uses CTAS pattern for DuckDB WASM compatibility
  const tempTable = `${tableName}_mat_temp_${Date.now()}`

  // Get all columns
  const colsResult = await db.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `)
  const allColumns = colsResult.map((c) => c.column_name)

  // Build SELECT: update base column with current value, keep everything else
  const selectParts: string[] = []
  for (const col of allColumns) {
    if (col === versionInfo.baseColumn) {
      // Copy current computed value to base
      selectParts.push(`${quoteColumn(column)} AS ${quoteColumn(versionInfo.baseColumn)}`)
    } else {
      selectParts.push(quoteColumn(col))
    }
  }

  // Create temp table with materialized base
  const ctasSQL = `CREATE TABLE ${quoteTable(tempTable)} AS SELECT ${selectParts.join(', ')} FROM ${quoteTable(tableName)}`
  await db.execute(ctasSQL)

  // Swap tables
  await db.execute(`DROP TABLE ${quoteTable(tableName)}`)
  await db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

  // Reset stack to identity (base column now holds the materialized value)
  versionInfo.expressionStack = [{ expression: '{{COL}}', commandId: 'materialized' }]
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

    hasVersion(column: string): boolean {
      return versions.has(column)
    },

    async createVersion(
      tableName: string,
      column: string,
      expression: string,
      commandId: string
    ): Promise<VersionResult> {
      try {
        let versionInfo = versions.get(column)
        const tempTable = `${tableName}_cv_temp_${Date.now()}`
        const baseColumn = versionInfo?.baseColumn || getBaseColumnName(column)

        // Get all current columns
        const colsResult = await db.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = '${tableName}'
          ORDER BY ordinal_position
        `)
        const allColumns = colsResult.map((c) => c.column_name)

        if (!versionInfo) {
          // First transform on this column: create base column and transformed column
          // Build SELECT list: all columns except target, plus base and transformed
          const selectParts: string[] = []
          for (const col of allColumns) {
            if (col === column) {
              // Add base column (copy of original)
              selectParts.push(`${quoteColumn(col)} AS ${quoteColumn(baseColumn)}`)
              // Add transformed column with original name
              const transformedExpr = replacePlaceholder(expression, quoteColumn(col))
              selectParts.push(`${transformedExpr} AS ${quoteColumn(col)}`)
            } else {
              selectParts.push(quoteColumn(col))
            }
          }

          // Create temp table with new structure
          const ctasSQL = `CREATE TABLE ${quoteTable(tempTable)} AS SELECT ${selectParts.join(', ')} FROM ${quoteTable(tableName)}`
          await db.execute(ctasSQL)

          // Swap tables
          await db.execute(`DROP TABLE ${quoteTable(tableName)}`)
          await db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

          // Initialize version info
          versionInfo = {
            originalColumn: column,
            baseColumn,
            expressionStack: [{ expression, commandId }],
          }
          versions.set(column, versionInfo)

          return {
            success: true,
            originalColumn: column,
            baseColumn,
            expressionCount: 1,
          }
        } else {
          // Chained transform: rebuild with nested expression applied to base
          const prevStack = [...versionInfo.expressionStack]

          // Add new expression to stack
          versionInfo.expressionStack.push({ expression, commandId })

          try {
            // Build nested expression from base column
            const nestedExpr = buildNestedExpression(versionInfo.expressionStack, versionInfo.baseColumn)

            // Build SELECT list: all columns except target, replace target with new expression
            const selectParts: string[] = []
            for (const col of allColumns) {
              if (col === column) {
                // Replace with new computed value
                selectParts.push(`${nestedExpr} AS ${quoteColumn(col)}`)
              } else {
                selectParts.push(quoteColumn(col))
              }
            }

            // Create temp table with updated column
            const ctasSQL = `CREATE TABLE ${quoteTable(tempTable)} AS SELECT ${selectParts.join(', ')} FROM ${quoteTable(tableName)}`
            await db.execute(ctasSQL)

            // Swap tables
            await db.execute(`DROP TABLE ${quoteTable(tableName)}`)
            await db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

            // Check if we need to materialize (expression stack too large)
            // For large tables (>500k rows), materialize earlier to reduce overhead
            const countResult = await db.query<{ count: bigint }>(`SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`)
            const rowCount = Number(countResult[0].count)
            const threshold = rowCount > 500_000 ? 5 : COLUMN_MATERIALIZATION_THRESHOLD

            if (versionInfo.expressionStack.length >= threshold) {
              console.log(`[Column Versions] Materializing column "${column}" (${versionInfo.expressionStack.length} transforms, ${rowCount.toLocaleString()} rows)`)
              await materializeColumn(db, tableName, column, versionInfo)
            }

            return {
              success: true,
              originalColumn: column,
              baseColumn: versionInfo.baseColumn,
              expressionCount: versionInfo.expressionStack.length,
            }
          } catch (error) {
            // Rollback: restore previous stack
            versionInfo.expressionStack = prevStack
            // Clean up temp table if it exists
            try {
              await db.execute(`DROP TABLE IF EXISTS ${quoteTable(tempTable)}`)
            } catch {
              // Ignore cleanup errors
            }
            throw error
          }
        }
      } catch (error) {
        return {
          success: false,
          originalColumn: column,
          baseColumn: '',
          expressionCount: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async undoVersion(tableName: string, column: string): Promise<UndoResult> {
      try {
        const versionInfo = versions.get(column)
        if (!versionInfo || versionInfo.expressionStack.length === 0) {
          return {
            success: false,
            restoredColumn: column,
            expressionsRemaining: 0,
            fullyRestored: false,
            error: `No version history for column ${column}`,
          }
        }

        const tempTable = `${tableName}_cv_undo_${Date.now()}`

        // Get all current columns
        const colsResult = await db.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = '${tableName}'
          ORDER BY ordinal_position
        `)
        const allColumns = colsResult.map((c) => c.column_name)

        // Check if we're trying to undo past a materialization point
        const lastExpr = versionInfo.expressionStack[versionInfo.expressionStack.length - 1]
        if (lastExpr && lastExpr.commandId === 'materialized' && versionInfo.expressionStack.length === 1) {
          // At materialization boundary - cannot undo past this point
          // Clean up the materialization snapshot since we're at the limit
          if (versionInfo.materializationSnapshot) {
            // Handle both Parquet and in-memory snapshots
            if (versionInfo.materializationSnapshot.startsWith('parquet:')) {
              const snapshotId = versionInfo.materializationSnapshot.replace('parquet:', '')
              const { deleteParquetSnapshot } = await import('@/lib/opfs/snapshot-storage')
              await deleteParquetSnapshot(snapshotId).catch(() => {})
            } else {
              await dropTable(versionInfo.materializationSnapshot).catch(() => {})
            }
            versionInfo.materializationSnapshot = undefined
            versionInfo.materializationPosition = undefined
          }
          return {
            success: false,
            restoredColumn: column,
            expressionsRemaining: 1,
            fullyRestored: false,
            error: 'Undo unavailable: Column was materialized for performance',
          }
        }

        // Pop the last expression
        versionInfo.expressionStack.pop()

        if (versionInfo.expressionStack.length === 0) {
          // Full restore: replace transformed column with base column, drop base
          const selectParts: string[] = []
          for (const col of allColumns) {
            if (col === column) {
              // Replace transformed column with base column value
              selectParts.push(`${quoteColumn(versionInfo.baseColumn)} AS ${quoteColumn(col)}`)
            } else if (col === versionInfo.baseColumn) {
              // Skip base column (don't include it)
              continue
            } else {
              selectParts.push(quoteColumn(col))
            }
          }

          // Create temp table with restored structure
          const ctasSQL = `CREATE TABLE ${quoteTable(tempTable)} AS SELECT ${selectParts.join(', ')} FROM ${quoteTable(tableName)}`
          await db.execute(ctasSQL)

          // Swap tables
          await db.execute(`DROP TABLE ${quoteTable(tableName)}`)
          await db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

          // Clean up materialization snapshot if it exists
          if (versionInfo.materializationSnapshot) {
            // Handle both Parquet and in-memory snapshots
            if (versionInfo.materializationSnapshot.startsWith('parquet:')) {
              const snapshotId = versionInfo.materializationSnapshot.replace('parquet:', '')
              const { deleteParquetSnapshot } = await import('@/lib/opfs/snapshot-storage')
              await deleteParquetSnapshot(snapshotId).catch(() => {})
            } else {
              await dropTable(versionInfo.materializationSnapshot).catch(() => {})
            }
          }

          // Remove from version store
          versions.delete(column)

          return {
            success: true,
            restoredColumn: column,
            expressionsRemaining: 0,
            fullyRestored: true,
          }
        } else {
          // Partial undo: rebuild with remaining expressions
          const nestedExpr = buildNestedExpression(versionInfo.expressionStack, versionInfo.baseColumn)

          // Build SELECT list with reverted expression
          const selectParts: string[] = []
          for (const col of allColumns) {
            if (col === column) {
              selectParts.push(`${nestedExpr} AS ${quoteColumn(col)}`)
            } else {
              selectParts.push(quoteColumn(col))
            }
          }

          // Create temp table with reverted column
          const ctasSQL = `CREATE TABLE ${quoteTable(tempTable)} AS SELECT ${selectParts.join(', ')} FROM ${quoteTable(tableName)}`
          await db.execute(ctasSQL)

          // Swap tables
          await db.execute(`DROP TABLE ${quoteTable(tableName)}`)
          await db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

          return {
            success: true,
            restoredColumn: column,
            expressionsRemaining: versionInfo.expressionStack.length,
            fullyRestored: false,
          }
        }
      } catch (error) {
        return {
          success: false,
          restoredColumn: column,
          expressionsRemaining: versions.get(column)?.expressionStack.length ?? 0,
          fullyRestored: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },

    getVersionedColumns(): string[] {
      return Array.from(versions.keys())
    },

    async cleanup(tableName: string, column: string): Promise<void> {
      const versionInfo = versions.get(column)
      if (!versionInfo) return

      // If there are still expressions, we can't clean up
      if (versionInfo.expressionStack.length > 0) return

      // Try to drop base column if it exists (shouldn't after full undo)
      try {
        await db.execute(
          `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN IF EXISTS ${quoteColumn(versionInfo.baseColumn)}`
        )
      } catch {
        // Ignore - column might not exist
      }

      versions.delete(column)
    },
  }
}

/**
 * Scan a table for existing base columns and rebuild version store
 * Useful for recovery or migration scenarios
 */
export async function scanForBaseColumns(
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

  // Find base columns
  for (const col of columns) {
    if (isBaseColumn(col.column_name)) {
      const original = getOriginalFromBase(col.column_name)
      if (original) {
        // Check if the original column also exists (computed column)
        const hasOriginal = columns.some((c) => c.column_name === original)
        if (hasOriginal) {
          // Found a versioned column pair
          result.set(original, {
            originalColumn: original,
            baseColumn: col.column_name,
            expressionStack: [
              {
                expression: `${COLUMN_PLACEHOLDER}`, // Unknown - would need to parse column definition
                commandId: 'recovered',
              },
            ],
          })
        }
      }
    }
  }

  return result
}

/**
 * Get SQL to undo a Tier 1 operation (for preview/dry-run)
 * Note: These use CTAS pattern for DuckDB WASM compatibility
 */
export function getTier1UndoSQL(
  tableName: string,
  column: string,
  versionInfo: ColumnVersionInfo
): string[] {
  if (versionInfo.expressionStack.length <= 1) {
    // Full restore - replace transformed with base, drop base
    return [
      `-- Full undo: Restore original column from base`,
      `-- (Uses CTAS pattern to recreate table without base column,`,
      `--  using base column value as the restored column)`,
      `CREATE TABLE ${quoteTable(tableName + '_temp')} AS`,
      `  SELECT ...other_cols..., ${quoteColumn(versionInfo.baseColumn)} AS ${quoteColumn(column)}`,
      `  FROM ${quoteTable(tableName)};`,
      `DROP TABLE ${quoteTable(tableName)};`,
      `ALTER TABLE ${quoteTable(tableName + '_temp')} RENAME TO ${quoteTable(tableName)};`,
    ]
  } else {
    // Partial undo - rebuild with N-1 expressions
    const prevStack = versionInfo.expressionStack.slice(0, -1)
    const nestedExpr = buildNestedExpression(prevStack, versionInfo.baseColumn)
    return [
      `-- Partial undo: Revert to previous expression`,
      `CREATE TABLE ${quoteTable(tableName + '_temp')} AS`,
      `  SELECT ...other_cols..., ${nestedExpr} AS ${quoteColumn(column)}, ${quoteColumn(versionInfo.baseColumn)}`,
      `  FROM ${quoteTable(tableName)};`,
      `DROP TABLE ${quoteTable(tableName)};`,
      `ALTER TABLE ${quoteTable(tableName + '_temp')} RENAME TO ${quoteTable(tableName)};`,
    ]
  }
}

/**
 * Get SQL for a Tier 1 transformation (for preview/dry-run)
 * Note: These use CTAS pattern for DuckDB WASM compatibility
 */
export function getTier1ExecuteSQL(
  tableName: string,
  column: string,
  expression: string,
  versionInfo: ColumnVersionInfo | undefined
): string[] {
  if (!versionInfo) {
    // First transform - create base column and transformed column
    const baseColumn = getBaseColumnName(column)
    const transformedExpr = replacePlaceholder(expression, quoteColumn(column))
    return [
      `-- First transform: Create base column backup and apply transformation`,
      `CREATE TABLE ${quoteTable(tableName + '_temp')} AS`,
      `  SELECT ...other_cols..., ${quoteColumn(column)} AS ${quoteColumn(baseColumn)}, ${transformedExpr} AS ${quoteColumn(column)}`,
      `  FROM ${quoteTable(tableName)};`,
      `DROP TABLE ${quoteTable(tableName)};`,
      `ALTER TABLE ${quoteTable(tableName + '_temp')} RENAME TO ${quoteTable(tableName)};`,
    ]
  } else {
    // Chained transform - rebuild with nested expressions
    const newStack = [...versionInfo.expressionStack, { expression, commandId: 'preview' }]
    const nestedExpr = buildNestedExpression(newStack, versionInfo.baseColumn)
    return [
      `-- Chained transform: Apply nested expression`,
      `CREATE TABLE ${quoteTable(tableName + '_temp')} AS`,
      `  SELECT ...other_cols..., ${nestedExpr} AS ${quoteColumn(column)}, ${quoteColumn(versionInfo.baseColumn)}`,
      `  FROM ${quoteTable(tableName)};`,
      `DROP TABLE ${quoteTable(tableName)};`,
      `ALTER TABLE ${quoteTable(tableName + '_temp')} RENAME TO ${quoteTable(tableName)};`,
    ]
  }
}

// ===== BACKWARD COMPATIBILITY =====
// Keep old functions for any code that might still use them

/**
 * @deprecated Use getBaseColumnName instead
 */
export function getBackupColumnName(originalColumn: string, _version: number): string {
  return getBaseColumnName(originalColumn)
}

/**
 * @deprecated Use isBaseColumn instead
 */
export function isBackupColumn(columnName: string): boolean {
  // Support both old backup_v# pattern and new __base pattern
  return /__backup_v\d+$/.test(columnName) || isBaseColumn(columnName)
}

/**
 * @deprecated Use getOriginalFromBase instead
 */
export function getOriginalFromBackup(backupColumnName: string): string | null {
  // Support old pattern
  const oldMatch = backupColumnName.match(/^(.+)__backup_v\d+$/)
  if (oldMatch) return oldMatch[1]
  // Support new pattern
  return getOriginalFromBase(backupColumnName)
}

/**
 * @deprecated Use scanForBaseColumns instead
 */
export const scanForBackupColumns = scanForBaseColumns
