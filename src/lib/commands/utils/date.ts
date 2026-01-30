/**
 * Date Utility Functions
 *
 * Helper functions for date parsing and formatting in the command system.
 * Uses DuckDB's TRY_STRPTIME for date parsing.
 *
 * Industry best practices for date detection:
 * - Unix timestamps detected by digit count (not value range)
 * - 10 digits = seconds, 13 = milliseconds, 16 = microseconds, 19 = nanoseconds
 * - String dates parsed in order: ISO 8601 first (unambiguous), then regional formats
 */

/**
 * Unix timestamp types by digit count
 */
export type UnixTimestampType = 'ns' | 'us' | 'ms' | 's' | null

/**
 * Detect Unix timestamp type by digit count.
 * This is more reliable than value range checks.
 *
 * Handles various numeric string formats:
 * - Pure integers: "1608422400000"
 * - Floating point: "1608422400000.0"
 * - Scientific notation: "1.608422e+12"
 *
 * @param value - A sample value (as string)
 * @returns The timestamp type or null if not a Unix timestamp
 */
export function detectUnixTimestampType(value: string): UnixTimestampType {
  const trimmed = value.trim()

  // Try to extract the integer portion from various numeric formats
  let integerStr: string | null = null

  // Check for pure integer: "1608422400000"
  if (/^\d+$/.test(trimmed)) {
    integerStr = trimmed
  }
  // Check for float with .0: "1608422400000.0"
  else if (/^\d+\.0*$/.test(trimmed)) {
    integerStr = trimmed.split('.')[0]
  }
  // Check for scientific notation: "1.608422e+12" or "1.608422E12"
  else if (/^[\d.]+[eE][+-]?\d+$/.test(trimmed)) {
    try {
      const num = parseFloat(trimmed)
      if (Number.isFinite(num) && num > 0) {
        // Convert to integer and get string representation
        integerStr = Math.round(num).toString()
      }
    } catch {
      // Not a valid number
    }
  }

  if (!integerStr) return null

  const len = integerStr.length
  if (len >= 18) return 'ns'      // 19 digits = nanoseconds
  if (len >= 15) return 'us'      // 16 digits = microseconds
  if (len >= 12) return 'ms'      // 13 digits = milliseconds
  if (len >= 9) return 's'        // 10 digits = seconds

  return null
}

/**
 * Build a DuckDB expression to convert a Unix timestamp to TIMESTAMP.
 *
 * @param quotedCol - The quoted column name
 * @param timestampType - The detected timestamp type
 * @returns SQL expression that produces a TIMESTAMP
 */
export function buildUnixToTimestampExpression(quotedCol: string, timestampType: UnixTimestampType): string | null {
  switch (timestampType) {
    case 'ns':
      // Nanoseconds - convert to microseconds for make_timestamp
      return `make_timestamp(TRY_CAST(${quotedCol} AS BIGINT) / 1000)`
    case 'us':
      // Microseconds - use make_timestamp directly
      return `make_timestamp(TRY_CAST(${quotedCol} AS BIGINT))`
    case 'ms':
      // Milliseconds - use epoch_ms
      return `epoch_ms(TRY_CAST(${quotedCol} AS BIGINT))`
    case 's':
      // Seconds - use to_timestamp
      return `to_timestamp(TRY_CAST(${quotedCol} AS BIGINT))`
    default:
      return null
  }
}

/**
 * Supported date formats for parsing (DuckDB strptime format strings)
 * Order matters - more specific formats should come first
 */
export const DATE_FORMATS = [
  '%Y-%m-%d',     // ISO: 2024-01-15
  '%Y%m%d',       // Compact: 20240115
  '%m/%d/%Y',     // US: 01/15/2024
  '%d/%m/%Y',     // EU: 15/01/2024
  '%Y/%m/%d',     // ISO with slashes: 2024/01/15
  '%d-%m-%Y',     // EU with dashes: 15-01-2024
  '%m-%d-%Y',     // US with dashes: 01-15-2024
  '%Y.%m.%d',     // Dot separated: 2024.01.15
  '%d.%m.%Y',     // EU with dots: 15.01.2024
] as const

/**
 * Output format options for date standardization
 */
export const OUTPUT_FORMATS = {
  'YYYY-MM-DD': '%Y-%m-%d',
  'MM/DD/YYYY': '%m/%d/%Y',
  'DD/MM/YYYY': '%d/%m/%Y',
} as const

export type OutputFormat = keyof typeof OUTPUT_FORMATS

/**
 * Output type options for Standardize Date command
 * - 'text': Returns VARCHAR (current behavior) via strftime()
 * - 'date': Returns DATE type via TRY_CAST
 * - 'timestamp': Returns TIMESTAMP type (TRY_STRPTIME returns TIMESTAMP)
 */
export type DateOutputType = 'text' | 'date' | 'timestamp'

/**
 * Build a COALESCE expression that tries multiple date formats
 * Returns the first successful parse as a TIMESTAMP
 */
export function buildDateParseExpression(column: string): string {
  const quotedCol = `"${column.replace(/"/g, '""')}"`
  const castCol = `CAST(${quotedCol} AS VARCHAR)`

  const tryParses = DATE_FORMATS.map(
    (fmt) => `TRY_STRPTIME(${castCol}, '${fmt}')`
  )

  // Add TRY_CAST as final fallback for dates that might already be DATE type
  return `COALESCE(
    ${tryParses.join(',\n    ')},
    TRY_CAST(${quotedCol} AS DATE)
  )`
}

/**
 * Build a comprehensive date parse expression that handles:
 * 1. Unix timestamps (by digit count: ms, s, us, ns)
 * 2. String date formats (ISO 8601, US, EU, etc.)
 *
 * @param column - The column name
 * @param detectedTimestampType - Pre-detected Unix timestamp type (if known)
 * @returns SQL expression that produces a TIMESTAMP
 */
export function buildSmartDateParseExpression(
  column: string,
  detectedTimestampType: UnixTimestampType = null
): string {
  const quotedCol = `"${column.replace(/"/g, '""')}"`

  // If we've detected a specific Unix timestamp type, use it directly
  if (detectedTimestampType) {
    const epochExpr = buildUnixToTimestampExpression(quotedCol, detectedTimestampType)
    if (epochExpr) {
      return epochExpr
    }
  }

  // Otherwise, build a COALESCE that tries Unix timestamps first, then string formats
  const castCol = `CAST(${quotedCol} AS VARCHAR)`
  const bigintCol = `TRY_CAST(${quotedCol} AS BIGINT)`

  // Try Unix timestamps by checking string length (digit count)
  // This handles numeric values that could be timestamps
  const unixAttempts = [
    // 13 digits = milliseconds (most common for modern timestamps)
    `CASE WHEN LENGTH(${castCol}) = 13 AND ${castCol} ~ '^[0-9]+$' THEN epoch_ms(${bigintCol}) END`,
    // 10 digits = seconds
    `CASE WHEN LENGTH(${castCol}) = 10 AND ${castCol} ~ '^[0-9]+$' THEN to_timestamp(${bigintCol}) END`,
    // 16 digits = microseconds
    `CASE WHEN LENGTH(${castCol}) = 16 AND ${castCol} ~ '^[0-9]+$' THEN make_timestamp(${bigintCol}) END`,
  ]

  // String date format attempts
  const stringAttempts = DATE_FORMATS.map(
    (fmt) => `TRY_STRPTIME(${castCol}, '${fmt}')`
  )

  return `COALESCE(
    ${unixAttempts.join(',\n    ')},
    ${stringAttempts.join(',\n    ')},
    TRY_CAST(${quotedCol} AS TIMESTAMP)
  )`
}

/**
 * Build a strftime expression with date parsing
 * Parses the input using multiple formats and outputs in the specified format
 *
 * @param column - The column name to parse
 * @param outputFormat - The desired output format (YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY)
 * @param outputType - The desired output type (text, date, timestamp)
 *   - 'text' (default): Returns VARCHAR via strftime()
 *   - 'date': Returns DATE type
 *   - 'timestamp': Returns TIMESTAMP type
 * @param detectedTimestampType - Pre-detected Unix timestamp type (optional)
 */
export function buildDateFormatExpression(
  column: string,
  outputFormat: OutputFormat,
  outputType: DateOutputType = 'text',
  detectedTimestampType: UnixTimestampType = null
): string {
  // Use smart parsing that handles both Unix timestamps and string dates
  const parseExpr = buildSmartDateParseExpression(column, detectedTimestampType)
  const strftimeFormat = OUTPUT_FORMATS[outputFormat]

  switch (outputType) {
    case 'date':
      // Cast the parsed TIMESTAMP to DATE
      return `TRY_CAST(${parseExpr} AS DATE)`

    case 'timestamp':
      // Return the TIMESTAMP directly
      return parseExpr

    case 'text':
    default:
      // Format as text string
      return `strftime(${parseExpr}, '${strftimeFormat}')`
  }
}

/**
 * Build an age calculation expression from a date column
 * Returns age in years using DATE_DIFF
 */
export function buildAgeExpression(column: string): string {
  const parseExpr = buildDateParseExpression(column)
  return `DATE_DIFF('year', ${parseExpr}, CURRENT_DATE)`
}

/**
 * Build a WHERE clause that identifies rows with parseable dates
 */
export function buildDateNotNullPredicate(column: string): string {
  const quotedCol = `"${column.replace(/"/g, '""')}"`
  return `${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS VARCHAR)) != ''`
}

/**
 * Build a WHERE clause that identifies rows where date parsing succeeded
 */
export function buildDateParseSuccessPredicate(column: string): string {
  const parseExpr = buildDateParseExpression(column)
  return `(${parseExpr}) IS NOT NULL`
}
