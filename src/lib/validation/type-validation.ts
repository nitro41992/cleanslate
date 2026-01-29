/**
 * Type Validation Utilities
 *
 * Validates cell values against DuckDB column types before editing.
 * Returns validation results with user-friendly error messages.
 */

export interface TypeValidationResult {
  isValid: boolean
  error?: string
  /** Suggested format example for the column type */
  formatHint?: string
}

/**
 * Common DuckDB type patterns
 */
const TYPE_PATTERNS = {
  // Integer types
  INTEGER: /^-?\d+$/,
  BIGINT: /^-?\d+$/,
  SMALLINT: /^-?\d+$/,
  TINYINT: /^-?\d+$/,
  HUGEINT: /^-?\d+$/,
  UBIGINT: /^\d+$/,
  UINTEGER: /^\d+$/,
  USMALLINT: /^\d+$/,
  UTINYINT: /^\d+$/,

  // Floating point
  DOUBLE: /^-?\d*\.?\d+([eE][+-]?\d+)?$/,
  FLOAT: /^-?\d*\.?\d+([eE][+-]?\d+)?$/,
  REAL: /^-?\d*\.?\d+([eE][+-]?\d+)?$/,
  DECIMAL: /^-?\d*\.?\d+$/,

  // Boolean
  BOOLEAN: /^(true|false|1|0|yes|no|t|f|y|n)$/i,

  // Date/Time patterns (common formats DuckDB accepts)
  DATE: /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4})$/,
  TIMESTAMP: /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?$/,
  TIME: /^\d{2}:\d{2}(:\d{2})?(\.\d+)?$/,
}

/**
 * Format hints for each type
 */
const FORMAT_HINTS: Record<string, string> = {
  INTEGER: 'e.g., 123, -456',
  BIGINT: 'e.g., 123, -456',
  SMALLINT: 'e.g., 123, -456',
  TINYINT: 'e.g., 0-255',
  DOUBLE: 'e.g., 123.45, -0.5, 1e10',
  FLOAT: 'e.g., 123.45, -0.5',
  REAL: 'e.g., 123.45, -0.5',
  DECIMAL: 'e.g., 123.45, -0.5',
  BOOLEAN: 'e.g., true, false, 1, 0',
  DATE: 'e.g., 2024-01-15, 01/15/2024',
  TIMESTAMP: 'e.g., 2024-01-15 10:30:00',
  TIME: 'e.g., 10:30:00, 14:45',
  VARCHAR: 'any text',
}

/**
 * Get the base type from a DuckDB type string.
 * Handles types like "DECIMAL(10,2)", "VARCHAR(255)", etc.
 */
function getBaseType(type: string): string {
  // Remove parameters like (10,2) or (255)
  const baseType = type.replace(/\(.*\)/, '').trim().toUpperCase()
  return baseType
}

/**
 * Validates a value against a DuckDB column type.
 *
 * @param value - The value to validate
 * @param columnType - The DuckDB column type (e.g., "INTEGER", "VARCHAR", "DATE")
 * @returns Validation result with error message if invalid
 */
export function validateValueForType(
  value: unknown,
  columnType: string
): TypeValidationResult {
  // Null values are always valid (if nullable, which we assume)
  if (value === null || value === undefined) {
    return { isValid: true }
  }

  // Empty string is valid (will be converted to NULL)
  const strValue = String(value).trim()
  if (strValue === '') {
    return { isValid: true }
  }

  const baseType = getBaseType(columnType)
  const formatHint = FORMAT_HINTS[baseType] || FORMAT_HINTS.VARCHAR

  // VARCHAR/TEXT types accept anything
  if (baseType === 'VARCHAR' || baseType === 'TEXT' || baseType === 'STRING') {
    return { isValid: true }
  }

  // Integer types
  if (['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT', 'INT', 'INT4', 'INT8', 'INT2', 'INT1'].includes(baseType)) {
    if (!TYPE_PATTERNS.INTEGER.test(strValue)) {
      return {
        isValid: false,
        error: `Expected integer value`,
        formatHint,
      }
    }

    // Check for range (basic check for common types)
    const num = parseInt(strValue, 10)
    if (baseType === 'TINYINT' && (num < -128 || num > 127)) {
      return {
        isValid: false,
        error: `Value out of range for TINYINT (-128 to 127)`,
        formatHint: 'e.g., -128 to 127',
      }
    }
    if (baseType === 'SMALLINT' && (num < -32768 || num > 32767)) {
      return {
        isValid: false,
        error: `Value out of range for SMALLINT (-32768 to 32767)`,
        formatHint: 'e.g., -32768 to 32767',
      }
    }

    return { isValid: true }
  }

  // Unsigned integer types
  if (['UBIGINT', 'UINTEGER', 'USMALLINT', 'UTINYINT', 'UINT8', 'UINT4', 'UINT2', 'UINT1'].includes(baseType)) {
    if (!TYPE_PATTERNS.UBIGINT.test(strValue)) {
      return {
        isValid: false,
        error: `Expected non-negative integer`,
        formatHint: 'e.g., 0, 123',
      }
    }
    return { isValid: true }
  }

  // Floating point types
  if (['DOUBLE', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC', 'FLOAT4', 'FLOAT8'].includes(baseType)) {
    if (!TYPE_PATTERNS.DOUBLE.test(strValue)) {
      return {
        isValid: false,
        error: `Expected numeric value`,
        formatHint,
      }
    }
    return { isValid: true }
  }

  // Boolean type
  if (baseType === 'BOOLEAN' || baseType === 'BOOL') {
    if (!TYPE_PATTERNS.BOOLEAN.test(strValue)) {
      return {
        isValid: false,
        error: `Expected boolean value`,
        formatHint,
      }
    }
    return { isValid: true }
  }

  // Date type
  if (baseType === 'DATE') {
    // Try parsing as date
    const date = new Date(strValue)
    if (isNaN(date.getTime())) {
      // Also check our pattern
      if (!TYPE_PATTERNS.DATE.test(strValue)) {
        return {
          isValid: false,
          error: `Expected date value`,
          formatHint,
        }
      }
    }
    return { isValid: true }
  }

  // Timestamp types
  if (baseType === 'TIMESTAMP' || baseType.startsWith('TIMESTAMP')) {
    const date = new Date(strValue)
    if (isNaN(date.getTime())) {
      if (!TYPE_PATTERNS.TIMESTAMP.test(strValue)) {
        return {
          isValid: false,
          error: `Expected timestamp value`,
          formatHint,
        }
      }
    }
    return { isValid: true }
  }

  // Time type
  if (baseType === 'TIME') {
    if (!TYPE_PATTERNS.TIME.test(strValue)) {
      return {
        isValid: false,
        error: `Expected time value`,
        formatHint,
      }
    }
    return { isValid: true }
  }

  // For any other type, allow the value (DuckDB will handle it)
  return { isValid: true }
}

/**
 * Gets a user-friendly display name for a DuckDB type
 */
export function getTypeDisplayName(columnType: string): string {
  const baseType = getBaseType(columnType)

  const displayNames: Record<string, string> = {
    VARCHAR: 'Text',
    TEXT: 'Text',
    STRING: 'Text',
    INTEGER: 'Integer',
    INT: 'Integer',
    INT4: 'Integer',
    BIGINT: 'Big Integer',
    INT8: 'Big Integer',
    SMALLINT: 'Small Integer',
    INT2: 'Small Integer',
    TINYINT: 'Tiny Integer',
    INT1: 'Tiny Integer',
    DOUBLE: 'Decimal',
    FLOAT: 'Float',
    REAL: 'Float',
    DECIMAL: 'Decimal',
    NUMERIC: 'Decimal',
    BOOLEAN: 'Boolean',
    BOOL: 'Boolean',
    DATE: 'Date',
    TIMESTAMP: 'Timestamp',
    TIME: 'Time',
  }

  return displayNames[baseType] || columnType
}

/**
 * Gets a format hint for a column type
 */
export function getFormatHint(columnType: string): string {
  const baseType = getBaseType(columnType)
  return FORMAT_HINTS[baseType] || 'any value'
}
