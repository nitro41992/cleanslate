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
  '%B %d, %Y',    // Full month: April 5, 2018
  '%b %d, %Y',    // Abbrev month: Apr 5, 2018
  '%d %B %Y',     // EU full month: 5 April 2018
  '%d %b %Y',     // EU abbrev month: 5 Apr 2018
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
 * 1. Unix timestamps (if pre-detected type is provided)
 * 2. String date formats (ISO 8601, US, EU, etc.)
 *
 * Note: Unix timestamp detection via CASE statements in COALESCE causes issues
 * in DuckDB-WASM. Callers should detect Unix timestamps separately using
 * detectUnixTimestampType() and pass the result here.
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

  // No Unix timestamp detected - use string format parsing only
  // Note: CASE statements for runtime Unix detection in COALESCE cause issues
  // in DuckDB-WASM, so we rely on pre-detection instead
  return buildDateParseExpression(column)
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
      // Format as text string - cast to TIMESTAMP first to handle TIMESTAMPTZ
      return `strftime(TRY_CAST(${parseExpr} AS TIMESTAMP), '${strftimeFormat}')`
  }
}

/**
 * Age precision types
 */
export type AgePrecision = 'years' | 'decimal'

/**
 * Get today's date as a DuckDB DATE literal string.
 *
 * Uses JavaScript Date to avoid CURRENT_DATE in SQL, which triggers
 * ICU extension autoloading in DuckDB-WASM (icu_duckdb_cpp_init missing).
 */
export function getCurrentDateLiteral(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `'${yyyy}-${mm}-${dd}'::DATE`
}

/**
 * Build an age calculation expression from a date column
 * Returns age in years using pure arithmetic (no ICU extension required).
 *
 * NOTE: DuckDB-WASM's ICU extension fails to load (icu_duckdb_cpp_init missing).
 * CURRENT_DATE, DATE_DIFF, and EXTRACT all trigger ICU autoloading.
 * We use a JS-injected date literal + strftime-based extraction instead.
 *
 * @param column - The column name containing dates
 * @param precision - 'years' for whole years, 'decimal' for fractional years
 */
export function buildAgeExpression(column: string, precision: AgePrecision = 'years'): string {
  const parseExpr = buildDateParseExpression(column)
  // Cast parsed timestamp to DATE for date arithmetic
  const castExpr = `TRY_CAST(${parseExpr} AS DATE)`
  const today = getCurrentDateLiteral()

  if (precision === 'decimal') {
    // Calculate fractional years using date subtraction (date - date returns integer days in DuckDB)
    return `ROUND((${today} - ${castExpr}) / 365.25, 1)`
  }

  // Use strftime to extract year/month/day as integers (avoids EXTRACT which triggers ICU)
  const birthYear = `CAST(strftime(${castExpr}, '%Y') AS INTEGER)`
  const birthMonth = `CAST(strftime(${castExpr}, '%m') AS INTEGER)`
  const birthDay = `CAST(strftime(${castExpr}, '%d') AS INTEGER)`
  const curYear = `CAST(strftime(${today}, '%Y') AS INTEGER)`
  const curMonth = `CAST(strftime(${today}, '%m') AS INTEGER)`
  const curDay = `CAST(strftime(${today}, '%d') AS INTEGER)`

  // Calculate whole years: subtract years, then adjust if birthday hasn't occurred yet this year
  return `(${curYear} - ${birthYear}
    - CASE WHEN (${curMonth} < ${birthMonth}
                 OR (${curMonth} = ${birthMonth} AND ${curDay} < ${birthDay}))
           THEN 1 ELSE 0 END)`
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
