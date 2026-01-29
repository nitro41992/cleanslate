import type { ColumnFilter, FilterOperator } from '@/types'

/**
 * SQL Filter Builder for Data Grid View Operations
 *
 * Builds WHERE and ORDER BY clauses for filtering and sorting table data.
 * These are VIEW operations - they modify queries, not underlying data.
 *
 * Key design decisions:
 * - Use ILIKE for case-insensitive text matching
 * - Handle NULLs explicitly: is_empty = (col IS NULL OR col = '')
 * - Use NULLS LAST in ORDER BY for predictable sorting
 * - Escape values properly to prevent SQL injection
 */

/**
 * Map DuckDB column types to logical filter categories
 */
export type FilterCategory = 'text' | 'numeric' | 'date' | 'boolean' | 'unknown'

/**
 * Determine the filter category for a DuckDB data type
 */
export function getFilterCategory(duckdbType: string): FilterCategory {
  const type = duckdbType.toUpperCase()

  // Numeric types
  if (
    type.includes('INT') ||
    type.includes('DECIMAL') ||
    type.includes('NUMERIC') ||
    type.includes('FLOAT') ||
    type.includes('DOUBLE') ||
    type.includes('REAL') ||
    type === 'BIGINT' ||
    type === 'HUGEINT' ||
    type === 'SMALLINT' ||
    type === 'TINYINT' ||
    type === 'UBIGINT' ||
    type === 'UINTEGER' ||
    type === 'USMALLINT' ||
    type === 'UTINYINT'
  ) {
    return 'numeric'
  }

  // Date/Time types
  if (
    type.includes('DATE') ||
    type.includes('TIME') ||
    type.includes('TIMESTAMP') ||
    type === 'INTERVAL'
  ) {
    return 'date'
  }

  // Boolean
  if (type === 'BOOLEAN' || type === 'BOOL') {
    return 'boolean'
  }

  // Text types (VARCHAR, TEXT, CHAR, etc.)
  if (
    type.includes('VARCHAR') ||
    type.includes('CHAR') ||
    type.includes('TEXT') ||
    type === 'STRING' ||
    type === 'UUID' ||
    type.includes('BLOB')
  ) {
    return 'text'
  }

  return 'unknown'
}

/**
 * Get valid operators for a filter category
 */
export function getOperatorsForCategory(category: FilterCategory): FilterOperator[] {
  switch (category) {
    case 'text':
      return ['contains', 'equals', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']
    case 'numeric':
      return ['eq', 'gt', 'lt', 'gte', 'lte', 'between', 'is_empty', 'is_not_empty']
    case 'date':
      return ['date_eq', 'date_before', 'date_after', 'date_between', 'last_n_days', 'is_empty', 'is_not_empty']
    case 'boolean':
      return ['is_true', 'is_false', 'is_empty', 'is_not_empty']
    default:
      // Unknown types get text operators as fallback
      return ['contains', 'equals', 'is_empty', 'is_not_empty']
  }
}

/**
 * Human-readable labels for filter operators
 */
export function getOperatorLabel(operator: FilterOperator): string {
  const labels: Record<FilterOperator, string> = {
    // Text
    contains: 'contains',
    equals: 'equals',
    starts_with: 'starts with',
    ends_with: 'ends with',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
    // Numeric
    eq: '=',
    gt: '>',
    lt: '<',
    gte: '>=',
    lte: '<=',
    between: 'between',
    // Date
    date_eq: 'equals',
    date_before: 'before',
    date_after: 'after',
    date_between: 'between',
    last_n_days: 'last N days',
    // Boolean
    is_true: 'is true',
    is_false: 'is false',
  }
  return labels[operator] || operator
}

/**
 * Escape a string value for SQL LIKE patterns
 * Escapes %, _, and \ characters
 */
function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

/**
 * Escape a string value for SQL string literals
 * Doubles single quotes
 */
function escapeStringValue(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Build a single filter condition SQL clause
 */
function buildFilterCondition(filter: ColumnFilter): string {
  const column = `"${filter.column}"`
  const { operator, value, value2 } = filter

  // Empty/not empty operators don't need a value
  if (operator === 'is_empty') {
    return `(${column} IS NULL OR CAST(${column} AS VARCHAR) = '')`
  }
  if (operator === 'is_not_empty') {
    return `(${column} IS NOT NULL AND CAST(${column} AS VARCHAR) <> '')`
  }

  // Boolean operators
  if (operator === 'is_true') {
    return `${column} = TRUE`
  }
  if (operator === 'is_false') {
    return `${column} = FALSE`
  }

  // Text operators (case-insensitive using ILIKE)
  if (operator === 'contains' && typeof value === 'string') {
    const escaped = escapeStringValue(escapeLikePattern(value))
    return `CAST(${column} AS VARCHAR) ILIKE '%${escaped}%'`
  }
  if (operator === 'equals' && typeof value === 'string') {
    const escaped = escapeStringValue(value)
    return `CAST(${column} AS VARCHAR) ILIKE '${escaped}'`
  }
  if (operator === 'starts_with' && typeof value === 'string') {
    const escaped = escapeStringValue(escapeLikePattern(value))
    return `CAST(${column} AS VARCHAR) ILIKE '${escaped}%'`
  }
  if (operator === 'ends_with' && typeof value === 'string') {
    const escaped = escapeStringValue(escapeLikePattern(value))
    return `CAST(${column} AS VARCHAR) ILIKE '%${escaped}'`
  }

  // Numeric operators
  if (operator === 'eq' && (typeof value === 'number' || typeof value === 'string')) {
    return `${column} = ${Number(value)}`
  }
  if (operator === 'gt' && (typeof value === 'number' || typeof value === 'string')) {
    return `${column} > ${Number(value)}`
  }
  if (operator === 'lt' && (typeof value === 'number' || typeof value === 'string')) {
    return `${column} < ${Number(value)}`
  }
  if (operator === 'gte' && (typeof value === 'number' || typeof value === 'string')) {
    return `${column} >= ${Number(value)}`
  }
  if (operator === 'lte' && (typeof value === 'number' || typeof value === 'string')) {
    return `${column} <= ${Number(value)}`
  }
  if (operator === 'between' && value !== null && value2 !== undefined) {
    return `${column} BETWEEN ${Number(value)} AND ${Number(value2)}`
  }

  // Date operators
  if (operator === 'date_eq' && typeof value === 'string') {
    const escaped = escapeStringValue(value)
    return `CAST(${column} AS DATE) = '${escaped}'`
  }
  if (operator === 'date_before' && typeof value === 'string') {
    const escaped = escapeStringValue(value)
    return `CAST(${column} AS DATE) < '${escaped}'`
  }
  if (operator === 'date_after' && typeof value === 'string') {
    const escaped = escapeStringValue(value)
    return `CAST(${column} AS DATE) > '${escaped}'`
  }
  if (operator === 'date_between' && typeof value === 'string' && typeof value2 === 'string') {
    const escaped1 = escapeStringValue(value)
    const escaped2 = escapeStringValue(value2)
    return `CAST(${column} AS DATE) BETWEEN '${escaped1}' AND '${escaped2}'`
  }
  if (operator === 'last_n_days' && (typeof value === 'number' || typeof value === 'string')) {
    const days = Number(value)
    return `CAST(${column} AS DATE) >= CURRENT_DATE - INTERVAL '${days}' DAY`
  }

  // Fallback: treat as text equals
  if (value !== null && value !== undefined) {
    const escaped = escapeStringValue(String(value))
    return `CAST(${column} AS VARCHAR) ILIKE '${escaped}'`
  }

  return '1=1' // No-op filter if no value provided
}

/**
 * Build a WHERE clause from an array of filters
 *
 * @param filters - Array of column filters
 * @returns SQL WHERE clause string (without the "WHERE" keyword), or empty string if no filters
 */
export function buildWhereClause(filters: ColumnFilter[]): string {
  if (!filters || filters.length === 0) {
    return ''
  }

  const conditions = filters
    .map(buildFilterCondition)
    .filter(Boolean)

  if (conditions.length === 0) {
    return ''
  }

  return conditions.join(' AND ')
}

/**
 * Build an ORDER BY clause for sorting
 *
 * @param sortColumn - Column to sort by (null for no sort)
 * @param sortDirection - 'asc' or 'desc'
 * @param csIdColumn - The _cs_id column name for secondary sort (ensures deterministic order)
 * @returns SQL ORDER BY clause string (without "ORDER BY" keyword), or empty string if no sort
 */
export function buildOrderByClause(
  sortColumn: string | null,
  sortDirection: 'asc' | 'desc',
  csIdColumn = '_cs_id'
): string {
  if (!sortColumn) {
    // Default sort by _cs_id for deterministic pagination
    return `"${csIdColumn}"`
  }

  // User sort with _cs_id as secondary sort for deterministic tie-breaking
  // NULLS LAST ensures NULL values are sorted to the end
  const direction = sortDirection.toUpperCase()
  return `"${sortColumn}" ${direction} NULLS LAST, "${csIdColumn}"`
}

/**
 * Format a filter for display (e.g., in active filters bar)
 *
 * @param filter - The filter to format
 * @returns Human-readable string like "name contains John"
 */
export function formatFilterForDisplay(filter: ColumnFilter): string {
  const { column, operator, value, value2 } = filter
  const opLabel = getOperatorLabel(operator)

  // Operators that don't show a value
  if (operator === 'is_empty' || operator === 'is_not_empty' ||
      operator === 'is_true' || operator === 'is_false') {
    return `${column} ${opLabel}`
  }

  // Between operator shows both values
  if ((operator === 'between' || operator === 'date_between') && value2 !== undefined) {
    return `${column} ${opLabel} ${value} and ${value2}`
  }

  // Standard operator with single value
  return `${column} ${opLabel} "${value}"`
}
