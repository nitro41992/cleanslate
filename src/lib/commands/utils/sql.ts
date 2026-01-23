/**
 * SQL Utility Functions
 *
 * Helper functions for building safe SQL statements in the command system.
 * All functions handle escaping and quoting to prevent SQL injection.
 */

/**
 * Escape a string for use in SQL (single quotes)
 * Doubles single quotes to escape them
 */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Quote a column name with double quotes (DuckDB identifier quoting)
 */
export function quoteColumn(columnName: string): string {
  // Escape any double quotes in the column name
  const escaped = columnName.replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * Quote a table name with double quotes (DuckDB identifier quoting)
 */
export function quoteTable(tableName: string): string {
  // Same as column quoting in DuckDB
  const escaped = tableName.replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * Build a SQL value literal from a JavaScript value
 */
export function toSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return 'NULL'
    }
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`
  }
  // String or other - escape and quote
  return `'${escapeSqlString(String(value))}'`
}

/**
 * Escape special characters for use in LIKE pattern
 */
export function escapeLikePattern(pattern: string): string {
  // Escape %, _, and backslash
  return pattern.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Escape special characters for use in regex pattern
 */
export function escapeRegexPattern(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a CASE WHEN expression for conditional updates
 */
export function buildCaseWhen(
  _column: string,
  whenClauses: { when: string; then: string }[],
  elseValue?: string
): string {
  // Note: column parameter reserved for future use (e.g., CASE column WHEN syntax)
  const clauses = whenClauses
    .map(({ when, then }) => `WHEN ${when} THEN ${then}`)
    .join(' ')
  const elseClause = elseValue !== undefined ? ` ELSE ${elseValue}` : ''
  return `CASE ${clauses}${elseClause} END`
}

/**
 * Build a column list for SELECT statements
 */
export function buildColumnList(columns: string[], prefix?: string): string {
  return columns
    .map((col) => {
      const quoted = quoteColumn(col)
      return prefix ? `${prefix}.${quoted}` : quoted
    })
    .join(', ')
}

/**
 * Build an UPDATE SET clause from a map of column -> expression
 */
export function buildSetClause(
  updates: Record<string, string>
): string {
  return Object.entries(updates)
    .map(([col, expr]) => `${quoteColumn(col)} = ${expr}`)
    .join(', ')
}

/**
 * Build a WHERE IN clause from an array of values
 */
export function buildInClause(values: unknown[]): string {
  if (values.length === 0) {
    return 'FALSE' // Empty IN is always false
  }
  return `IN (${values.map(toSqlValue).join(', ')})`
}

/**
 * Generate a unique backup column name for Tier 1 undo
 * Format: {original}__backup_v{version}
 */
export function getBackupColumnName(originalColumn: string, version: number): string {
  return `${originalColumn}__backup_v${version}`
}

/**
 * Check if a column name is a backup column
 */
export function isBackupColumn(columnName: string): boolean {
  return /__backup_v\d+$/.test(columnName)
}

/**
 * Extract original column name from backup column name
 */
export function getOriginalFromBackup(backupColumnName: string): string | null {
  const match = backupColumnName.match(/^(.+)__backup_v\d+$/)
  return match ? match[1] : null
}

/**
 * Build a DuckDB ALTER TABLE statement for column operations
 */
export function buildAlterTable(
  tableName: string,
  operation: 'ADD COLUMN' | 'DROP COLUMN' | 'RENAME COLUMN',
  columnName: string,
  options?: {
    newName?: string
    dataType?: string
    expression?: string
  }
): string {
  const quotedTable = quoteTable(tableName)
  const quotedColName = quoteColumn(columnName)

  switch (operation) {
    case 'ADD COLUMN':
      if (options?.expression) {
        return `ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColName} AS (${options.expression})`
      }
      return `ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColName} ${options?.dataType || 'VARCHAR'}`

    case 'DROP COLUMN':
      return `ALTER TABLE ${quotedTable} DROP COLUMN ${quotedColName}`

    case 'RENAME COLUMN':
      if (!options?.newName) {
        throw new Error('newName is required for RENAME COLUMN')
      }
      return `ALTER TABLE ${quotedTable} RENAME COLUMN ${quotedColName} TO ${quoteColumn(options.newName)}`
  }
}
