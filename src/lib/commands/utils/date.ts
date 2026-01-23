/**
 * Date Utility Functions
 *
 * Helper functions for date parsing and formatting in the command system.
 * Uses DuckDB's TRY_STRPTIME for date parsing.
 */

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
 * Build a COALESCE expression that tries multiple date formats
 * Returns the first successful parse as a DATE
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
 * Build a strftime expression with date parsing
 * Parses the input using multiple formats and outputs in the specified format
 */
export function buildDateFormatExpression(
  column: string,
  outputFormat: OutputFormat
): string {
  const parseExpr = buildDateParseExpression(column)
  const strftimeFormat = OUTPUT_FORMATS[outputFormat]
  return `strftime(${parseExpr}, '${strftimeFormat}')`
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
