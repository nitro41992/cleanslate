/**
 * Column Sizing Utilities
 *
 * Type-aware default column widths for DataGrid.
 * Provides intelligent defaults based on DuckDB column types.
 */

export interface ColumnWidthConfig {
  min: number
  default: number
  max: number
}

/**
 * Type-based default widths for columns.
 * Optimized for common data patterns:
 * - Numeric types: narrower (IDs, counts, amounts)
 * - Text types: wider (names, descriptions, emails)
 * - Date/time: fixed width based on format
 * - Boolean: minimal width
 */
export const TYPE_WIDTH_DEFAULTS: Record<string, ColumnWidthConfig> = {
  // Integer types - typically IDs or counts, need less space
  INTEGER: { min: 60, default: 90, max: 150 },
  INT: { min: 60, default: 90, max: 150 },
  INT4: { min: 60, default: 90, max: 150 },
  BIGINT: { min: 80, default: 110, max: 180 },
  INT8: { min: 80, default: 110, max: 180 },
  SMALLINT: { min: 60, default: 80, max: 120 },
  INT2: { min: 60, default: 80, max: 120 },
  TINYINT: { min: 50, default: 70, max: 100 },
  INT1: { min: 50, default: 70, max: 100 },
  HUGEINT: { min: 100, default: 130, max: 200 },

  // Unsigned integers
  UBIGINT: { min: 80, default: 110, max: 180 },
  UINTEGER: { min: 60, default: 90, max: 150 },
  UINT4: { min: 60, default: 90, max: 150 },
  UINT8: { min: 80, default: 110, max: 180 },
  USMALLINT: { min: 60, default: 80, max: 120 },
  UINT2: { min: 60, default: 80, max: 120 },
  UTINYINT: { min: 50, default: 70, max: 100 },
  UINT1: { min: 50, default: 70, max: 100 },

  // Floating point - need more space for decimals
  DOUBLE: { min: 80, default: 120, max: 180 },
  FLOAT8: { min: 80, default: 120, max: 180 },
  FLOAT: { min: 80, default: 110, max: 160 },
  FLOAT4: { min: 80, default: 110, max: 160 },
  REAL: { min: 80, default: 110, max: 160 },
  DECIMAL: { min: 80, default: 120, max: 180 },
  NUMERIC: { min: 80, default: 120, max: 180 },

  // Text types - need the most space
  VARCHAR: { min: 100, default: 180, max: 400 },
  TEXT: { min: 100, default: 180, max: 400 },
  STRING: { min: 100, default: 180, max: 400 },

  // Date/Time - fixed formats, predictable widths
  DATE: { min: 100, default: 120, max: 140 },
  TIMESTAMP: { min: 140, default: 180, max: 220 },
  TIME: { min: 80, default: 100, max: 120 },

  // Boolean - minimal width needed
  BOOLEAN: { min: 60, default: 80, max: 100 },
  BOOL: { min: 60, default: 80, max: 100 },

  // UUID - fixed format
  UUID: { min: 280, default: 300, max: 320 },

  // Blob/Binary
  BLOB: { min: 100, default: 150, max: 200 },

  // JSON
  JSON: { min: 150, default: 250, max: 500 },
}

/**
 * Default width config for unknown types
 */
const DEFAULT_WIDTH_CONFIG: ColumnWidthConfig = {
  min: 80,
  default: 150,
  max: 300,
}

/**
 * Get the base type from a DuckDB type string.
 * Handles types like "DECIMAL(10,2)", "VARCHAR(255)", etc.
 */
function getBaseType(type: string): string {
  return type.replace(/\(.*\)/, '').trim().toUpperCase()
}

/**
 * Get width configuration for a column based on its DuckDB type.
 *
 * @param columnType - The DuckDB column type (e.g., "INTEGER", "VARCHAR(255)")
 * @returns Width configuration with min, default, and max values
 */
export function getColumnWidthConfig(columnType: string): ColumnWidthConfig {
  const baseType = getBaseType(columnType)
  return TYPE_WIDTH_DEFAULTS[baseType] || DEFAULT_WIDTH_CONFIG
}

/**
 * Get the default width for a column based on its type.
 *
 * @param columnType - The DuckDB column type
 * @returns Default width in pixels
 */
export function getDefaultColumnWidth(columnType: string): number {
  return getColumnWidthConfig(columnType).default
}

/**
 * Clamp a width value within the configured bounds for a type.
 *
 * @param width - The width to clamp
 * @param columnType - The DuckDB column type
 * @returns Clamped width value
 */
export function clampColumnWidth(width: number, columnType: string): number {
  const config = getColumnWidthConfig(columnType)
  return Math.max(config.min, Math.min(config.max, width))
}

/**
 * Global minimum and maximum column widths.
 * Used by DataGrid's minColumnWidth and maxColumnWidth props.
 */
export const GLOBAL_MIN_COLUMN_WIDTH = 50
export const GLOBAL_MAX_COLUMN_WIDTH = 500
export const MAX_COLUMN_AUTO_WIDTH = 400
