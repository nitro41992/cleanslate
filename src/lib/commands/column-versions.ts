/**
 * Column Version Manager - Expression Chaining
 *
 * Manages Tier 1 undo operations using expression chaining on a single base column.
 * Instead of creating multiple backup columns, we chain expressions together.
 *
 * Strategy:
 * 1. First transform on "Email":
 *    - RENAME "Email" TO "Email__base"
 *    - ADD COLUMN "Email" AS (TRIM("Email__base"))
 *
 * 2. Second transform (lowercase):
 *    - DROP COLUMN "Email"
 *    - ADD COLUMN "Email" AS (LOWER(TRIM("Email__base")))
 *
 * 3. Undo lowercase:
 *    - DROP COLUMN "Email"
 *    - ADD COLUMN "Email" AS (TRIM("Email__base"))
 *
 * 4. Undo trim (full restore):
 *    - DROP COLUMN "Email"
 *    - RENAME "Email__base" TO "Email"
 *
 * Key Advantages:
 * - Column name stays the same throughout - no UI changes needed
 * - Single base column regardless of transform count
 * - Zero-copy operation - instant regardless of row count
 * - Chained transforms work correctly
 */

import type { ColumnVersionInfo, ExpressionEntry } from './types'
import { quoteColumn, quoteTable } from './utils/sql'

/** Placeholder token for column reference in expressions */
export const COLUMN_PLACEHOLDER = '{{COL}}'

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

        if (!versionInfo) {
          // First transform on this column: create base column
          const baseColumn = getBaseColumnName(column)

          // Step 1: Rename original to base
          const renameSQL = `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(column)} TO ${quoteColumn(baseColumn)}`
          await db.execute(renameSQL)

          // Step 2: Create computed column with single expression
          const nestedExpr = replacePlaceholder(expression, quoteColumn(baseColumn))
          const addSQL = `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr})`
          await db.execute(addSQL)

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
          // Chained transform: rebuild with nested expressions
          const prevStack = [...versionInfo.expressionStack]

          // Add new expression to stack
          versionInfo.expressionStack.push({ expression, commandId })

          try {
            // Drop current computed column
            const dropSQL = `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)}`
            await db.execute(dropSQL)

            // Recreate with new nested expression
            const nestedExpr = buildNestedExpression(versionInfo.expressionStack, versionInfo.baseColumn)
            const addSQL = `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr})`
            await db.execute(addSQL)

            return {
              success: true,
              originalColumn: column,
              baseColumn: versionInfo.baseColumn,
              expressionCount: versionInfo.expressionStack.length,
            }
          } catch (error) {
            // Rollback: restore previous state
            versionInfo.expressionStack = prevStack
            try {
              // Try to restore previous computed column
              const nestedExpr = buildNestedExpression(prevStack, versionInfo.baseColumn)
              const addSQL = `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr})`
              await db.execute(addSQL)
            } catch (rollbackError) {
              // Critical failure - column state may be broken
              console.error('Rollback failed:', rollbackError)
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

        // Pop the last expression
        versionInfo.expressionStack.pop()

        if (versionInfo.expressionStack.length === 0) {
          // Full restore: drop computed column and rename base back to original
          // Step 1: Drop the computed column
          const dropSQL = `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)}`
          await db.execute(dropSQL)

          // Step 2: Rename base back to original
          const renameSQL = `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(versionInfo.baseColumn)} TO ${quoteColumn(column)}`
          await db.execute(renameSQL)

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
          // Step 1: Drop current computed column
          const dropSQL = `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)}`
          await db.execute(dropSQL)

          // Step 2: Recreate with remaining expressions
          const nestedExpr = buildNestedExpression(versionInfo.expressionStack, versionInfo.baseColumn)
          const addSQL = `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr})`
          await db.execute(addSQL)

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
 */
export function getTier1UndoSQL(
  tableName: string,
  column: string,
  versionInfo: ColumnVersionInfo
): string[] {
  if (versionInfo.expressionStack.length <= 1) {
    // Full restore
    return [
      `-- Step 1: Drop the computed column`,
      `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)};`,
      `-- Step 2: Restore from base`,
      `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(versionInfo.baseColumn)} TO ${quoteColumn(column)};`,
    ]
  } else {
    // Partial undo - rebuild with N-1 expressions
    const prevStack = versionInfo.expressionStack.slice(0, -1)
    const nestedExpr = buildNestedExpression(prevStack, versionInfo.baseColumn)
    return [
      `-- Step 1: Drop the computed column`,
      `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)};`,
      `-- Step 2: Recreate with previous expression`,
      `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr});`,
    ]
  }
}

/**
 * Get SQL for a Tier 1 transformation (for preview/dry-run)
 */
export function getTier1ExecuteSQL(
  tableName: string,
  column: string,
  expression: string,
  versionInfo: ColumnVersionInfo | undefined
): string[] {
  if (!versionInfo) {
    // First transform - create base column
    const baseColumn = getBaseColumnName(column)
    const nestedExpr = replacePlaceholder(expression, quoteColumn(baseColumn))
    return [
      `-- Step 1: Backup original column`,
      `ALTER TABLE ${quoteTable(tableName)} RENAME COLUMN ${quoteColumn(column)} TO ${quoteColumn(baseColumn)};`,
      `-- Step 2: Create transformed column with original name`,
      `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr});`,
    ]
  } else {
    // Chained transform - rebuild with nested expressions
    const newStack = [...versionInfo.expressionStack, { expression, commandId: 'preview' }]
    const nestedExpr = buildNestedExpression(newStack, versionInfo.baseColumn)
    return [
      `-- Step 1: Drop current computed column`,
      `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(column)};`,
      `-- Step 2: Recreate with nested expression`,
      `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(column)} AS (${nestedExpr});`,
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
