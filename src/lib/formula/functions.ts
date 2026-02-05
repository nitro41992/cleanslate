/**
 * Excel Function → DuckDB SQL Mapping
 *
 * Defines how Excel-like functions are transpiled to DuckDB SQL.
 * Handles type coercion and argument validation.
 */

import type { FunctionName } from './ast'

/** Category for organizing functions in the UI */
export type FunctionCategory = 'conditional' | 'text' | 'numeric' | 'logical' | 'null' | 'comparison' | 'date'

export interface FunctionSpec {
  /** Minimum number of arguments */
  minArgs: number
  /** Maximum number of arguments (-1 for unlimited) */
  maxArgs: number
  /**
   * SQL template generator.
   * Takes array of SQL expressions for arguments, returns DuckDB SQL.
   */
  toSQL: (args: string[]) => string
  /** Whether this function returns a string type */
  returnsString?: boolean
  /** Whether this function returns a number type */
  returnsNumber?: boolean
  /** Whether this function returns a boolean type */
  returnsBoolean?: boolean
  /** Description for error messages */
  description: string
  /** UI: Function signature for display (e.g., "IF(condition, true_val, false_val)") */
  signature?: string
  /** UI: Category for grouping in function browser */
  category?: FunctionCategory
  /** UI: Example formula demonstrating usage */
  example?: string
}

/**
 * Excel function specifications with DuckDB SQL mappings.
 *
 * Key differences from Excel:
 * - String functions cast input to VARCHAR for safety with numeric columns
 * - IF/IFERROR handle type coercion for mixed return types
 * - Comparison uses SQL operators instead of Excel's =, <>
 */
export const FUNCTION_SPECS: Record<FunctionName, FunctionSpec> = {
  // ===== CONDITIONAL =====
  IF: {
    minArgs: 3,
    maxArgs: 3,
    toSQL: (args) => `CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2]} END`,
    description: 'IF(condition, true_value, false_value)',
    signature: 'IF(condition, value_if_true, value_if_false)',
    category: 'conditional',
    example: 'IF(@score > 80, "Pass", "Fail")',
  },
  IFERROR: {
    minArgs: 2,
    maxArgs: 2,
    // TRY evaluates expression and returns NULL on error
    toSQL: (args) => `COALESCE(TRY(${args[0]}), ${args[1]})`,
    description: 'IFERROR(expression, fallback_value)',
    signature: 'IFERROR(expression, fallback_value)',
    category: 'conditional',
    example: 'IFERROR(@price / @qty, 0)',
  },

  // ===== STRING FUNCTIONS =====
  // All string functions cast to VARCHAR for safety with numeric columns
  LEN: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `LENGTH(CAST(${args[0]} AS VARCHAR))`,
    returnsNumber: true,
    description: 'LEN(text) - Returns length of text',
    signature: 'LEN(text)',
    category: 'text',
    example: 'LEN(@name)',
  },
  UPPER: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `UPPER(CAST(${args[0]} AS VARCHAR))`,
    returnsString: true,
    description: 'UPPER(text) - Converts to uppercase',
    signature: 'UPPER(text)',
    category: 'text',
    example: 'UPPER(@name)',
  },
  LOWER: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `LOWER(CAST(${args[0]} AS VARCHAR))`,
    returnsString: true,
    description: 'LOWER(text) - Converts to lowercase',
    signature: 'LOWER(text)',
    category: 'text',
    example: 'LOWER(@email)',
  },
  LEFT: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `LEFT(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsString: true,
    description: 'LEFT(text, num_chars)',
    signature: 'LEFT(text, num_chars)',
    category: 'text',
    example: 'LEFT(@code, 3)',
  },
  RIGHT: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `RIGHT(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsString: true,
    description: 'RIGHT(text, num_chars)',
    signature: 'RIGHT(text, num_chars)',
    category: 'text',
    example: 'RIGHT(@phone, 4)',
  },
  MID: {
    minArgs: 3,
    maxArgs: 3,
    // Excel MID is 1-indexed, DuckDB SUBSTR is also 1-indexed
    toSQL: (args) => `SUBSTR(CAST(${args[0]} AS VARCHAR), ${args[1]}, ${args[2]})`,
    returnsString: true,
    description: 'MID(text, start_pos, num_chars)',
    signature: 'MID(text, start_pos, num_chars)',
    category: 'text',
    example: 'MID(@ssn, 5, 2)',
  },
  TRIM: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `TRIM(CAST(${args[0]} AS VARCHAR))`,
    returnsString: true,
    description: 'TRIM(text) - Removes leading/trailing spaces',
    signature: 'TRIM(text)',
    category: 'text',
    example: 'TRIM(@name)',
  },
  CONCAT: {
    minArgs: 1,
    maxArgs: -1, // Unlimited
    toSQL: (args) => `CONCAT(${args.join(', ')})`,
    returnsString: true,
    description: 'CONCAT(text1, text2, ...) - Joins text values',
    signature: 'CONCAT(text1, text2, ...)',
    category: 'text',
    example: 'CONCAT(@first, " ", @last)',
  },
  SUBSTITUTE: {
    minArgs: 3,
    maxArgs: 3,
    toSQL: (args) => `REPLACE(CAST(${args[0]} AS VARCHAR), ${args[1]}, ${args[2]})`,
    returnsString: true,
    description: 'SUBSTITUTE(text, old_text, new_text)',
    signature: 'SUBSTITUTE(text, old_text, new_text)',
    category: 'text',
    example: 'SUBSTITUTE(@phone, "-", "")',
  },
  PROPER: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `INITCAP(CAST(${args[0]} AS VARCHAR))`,
    returnsString: true,
    description: 'PROPER(text) - Capitalizes first letter of each word',
    signature: 'PROPER(text)',
    category: 'text',
    example: 'PROPER(@name)',
  },
  SPLIT: {
    minArgs: 3,
    maxArgs: 3,
    toSQL: (args) => `SPLIT_PART(CAST(${args[0]} AS VARCHAR), ${args[1]}, ${args[2]})`,
    returnsString: true,
    description: 'SPLIT(text, delimiter, position) - Splits text and returns Nth part (1-indexed)',
    signature: 'SPLIT(text, delimiter, position)',
    category: 'text',
    example: 'SPLIT(@full_name, " ", 1)',
  },

  // ===== NUMERIC FUNCTIONS =====
  ROUND: {
    minArgs: 1,
    maxArgs: 2,
    toSQL: (args) => args.length === 2 ? `ROUND(${args[0]}, ${args[1]})` : `ROUND(${args[0]})`,
    returnsNumber: true,
    description: 'ROUND(number, [decimals])',
    signature: 'ROUND(number, [decimals])',
    category: 'numeric',
    example: 'ROUND(@price, 2)',
  },
  ABS: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `ABS(${args[0]})`,
    returnsNumber: true,
    description: 'ABS(number) - Absolute value',
    signature: 'ABS(number)',
    category: 'numeric',
    example: 'ABS(@difference)',
  },
  CEILING: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `CEIL(${args[0]})`,
    returnsNumber: true,
    description: 'CEILING(number) - Rounds up to nearest integer',
    signature: 'CEILING(number)',
    category: 'numeric',
    example: 'CEILING(@price)',
  },
  FLOOR: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `FLOOR(${args[0]})`,
    returnsNumber: true,
    description: 'FLOOR(number) - Rounds down to nearest integer',
    signature: 'FLOOR(number)',
    category: 'numeric',
    example: 'FLOOR(@amount)',
  },
  MOD: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `(${args[0]} % ${args[1]})`,
    returnsNumber: true,
    description: 'MOD(number, divisor) - Remainder after division',
    signature: 'MOD(number, divisor)',
    category: 'numeric',
    example: 'MOD(@id, 10)',
  },
  POWER: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `POWER(${args[0]}, ${args[1]})`,
    returnsNumber: true,
    description: 'POWER(base, exponent)',
    signature: 'POWER(base, exponent)',
    category: 'numeric',
    example: 'POWER(@value, 2)',
  },
  SQRT: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `SQRT(${args[0]})`,
    returnsNumber: true,
    description: 'SQRT(number) - Square root',
    signature: 'SQRT(number)',
    category: 'numeric',
    example: 'SQRT(@variance)',
  },

  // ===== LOGICAL FUNCTIONS =====
  AND: {
    minArgs: 2,
    maxArgs: -1, // Unlimited
    toSQL: (args) => `(${args.join(' AND ')})`,
    returnsBoolean: true,
    description: 'AND(condition1, condition2, ...)',
    signature: 'AND(condition1, condition2, ...)',
    category: 'logical',
    example: 'AND(@age > 18, @status = "active")',
  },
  OR: {
    minArgs: 2,
    maxArgs: -1, // Unlimited
    toSQL: (args) => `(${args.join(' OR ')})`,
    returnsBoolean: true,
    description: 'OR(condition1, condition2, ...)',
    signature: 'OR(condition1, condition2, ...)',
    category: 'logical',
    example: 'OR(@type = "A", @type = "B")',
  },
  NOT: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `NOT(${args[0]})`,
    returnsBoolean: true,
    description: 'NOT(condition)',
    signature: 'NOT(condition)',
    category: 'logical',
    example: 'NOT(ISBLANK(@email))',
  },

  // ===== NULL HANDLING =====
  COALESCE: {
    minArgs: 2,
    maxArgs: -1, // Unlimited
    toSQL: (args) => `COALESCE(${args.join(', ')})`,
    description: 'COALESCE(value1, value2, ...) - First non-null value',
    signature: 'COALESCE(value1, value2, ...)',
    category: 'null',
    example: 'COALESCE(@nickname, @name, "Unknown")',
  },
  ISBLANK: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `(${args[0]} IS NULL OR TRIM(CAST(${args[0]} AS VARCHAR)) = '')`,
    returnsBoolean: true,
    description: 'ISBLANK(value) - Checks if value is empty or null',
    signature: 'ISBLANK(value)',
    category: 'null',
    example: 'IF(ISBLANK(@phone), "N/A", @phone)',
  },

  // ===== COMPARISON FUNCTIONS =====
  CONTAINS: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `CONTAINS(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsBoolean: true,
    description: 'CONTAINS(text, search) - Check if text contains search string',
    signature: 'CONTAINS(text, search)',
    category: 'comparison',
    example: 'IF(CONTAINS(@email, "@gmail"), "Gmail", "Other")',
  },
  ICONTAINS: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `CONTAINS(LOWER(CAST(${args[0]} AS VARCHAR)), LOWER(${args[1]}))`,
    returnsBoolean: true,
    description: 'ICONTAINS(text, search) - Case-insensitive contains check',
    signature: 'ICONTAINS(text, search)',
    category: 'comparison',
    example: 'IF(ICONTAINS(@name, "smith"), "Match", "No match")',
  },
  STARTSWITH: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `STARTS_WITH(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsBoolean: true,
    description: 'STARTSWITH(text, prefix) - Check if text starts with prefix',
    signature: 'STARTSWITH(text, prefix)',
    category: 'comparison',
    example: 'IF(STARTSWITH(@phone, "+1"), "US", "International")',
  },
  ENDSWITH: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `ENDS_WITH(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsBoolean: true,
    description: 'ENDSWITH(text, suffix) - Check if text ends with suffix',
    signature: 'ENDSWITH(text, suffix)',
    category: 'comparison',
    example: 'IF(ENDSWITH(@email, ".edu"), "Academic", "Other")',
  },
  LIKE: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `(CAST(${args[0]} AS VARCHAR) LIKE ${args[1]})`,
    returnsBoolean: true,
    description: 'LIKE(text, pattern) - SQL LIKE pattern matching (% = any chars, _ = single char)',
    signature: 'LIKE(text, pattern)',
    category: 'comparison',
    example: 'IF(LIKE(@code, "A%"), "A-series", "Other")',
  },
  ILIKE: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `(CAST(${args[0]} AS VARCHAR) ILIKE ${args[1]})`,
    returnsBoolean: true,
    description: 'ILIKE(text, pattern) - Case-insensitive LIKE pattern matching',
    signature: 'ILIKE(text, pattern)',
    category: 'comparison',
    example: 'IF(ILIKE(@name, "john%"), "John variant", "Other")',
  },
  REGEX: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `REGEXP_MATCHES(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsBoolean: true,
    description: 'REGEX(text, pattern) - Regular expression matching',
    signature: 'REGEX(text, pattern)',
    category: 'comparison',
    example: 'IF(REGEX(@email, "^[a-z]+@"), "Valid prefix", "Invalid")',
  },
  REGEXEXTRACT: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `REGEXP_EXTRACT(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
    returnsString: true,
    description: 'REGEXEXTRACT(text, pattern) - Extracts text matching regex pattern',
    signature: 'REGEXEXTRACT(text, pattern)',
    category: 'comparison',
    example: 'REGEXEXTRACT(@email, "^[^@]+")',
  },
  BETWEEN: {
    minArgs: 3,
    maxArgs: 3,
    toSQL: (args) => `(${args[0]} BETWEEN ${args[1]} AND ${args[2]})`,
    returnsBoolean: true,
    description: 'BETWEEN(value, min, max) - Check if value is within range (inclusive)',
    signature: 'BETWEEN(value, min, max)',
    category: 'comparison',
    example: 'IF(BETWEEN(@age, 18, 65), "Working age", "Other")',
  },

  // ===== DATE FUNCTIONS =====
  YEAR: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `YEAR(${args[0]})`,
    returnsNumber: true,
    description: 'YEAR(date) - Extracts year from date',
    signature: 'YEAR(date)',
    category: 'date',
    example: 'YEAR(@created_at)',
  },
  MONTH: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `MONTH(${args[0]})`,
    returnsNumber: true,
    description: 'MONTH(date) - Extracts month (1-12) from date',
    signature: 'MONTH(date)',
    category: 'date',
    example: 'MONTH(@created_at)',
  },
  DAY: {
    minArgs: 1,
    maxArgs: 1,
    toSQL: (args) => `DAY(${args[0]})`,
    returnsNumber: true,
    description: 'DAY(date) - Extracts day of month (1-31) from date',
    signature: 'DAY(date)',
    category: 'date',
    example: 'DAY(@created_at)',
  },
  DATEDIFF: {
    minArgs: 2,
    maxArgs: 2,
    toSQL: (args) => `DATE_DIFF('day', ${args[0]}, ${args[1]})`,
    returnsNumber: true,
    description: 'DATEDIFF(start_date, end_date) - Days between two dates',
    signature: 'DATEDIFF(start_date, end_date)',
    category: 'date',
    example: 'DATEDIFF(@start_date, @end_date)',
  },
}

/**
 * Get a function spec by name (case-insensitive).
 */
export function getFunctionSpec(name: string): FunctionSpec | undefined {
  const normalized = name.toUpperCase() as FunctionName
  return FUNCTION_SPECS[normalized]
}

/**
 * Check if a function name is supported.
 */
export function isSupportedFunction(name: string): name is FunctionName {
  return name.toUpperCase() in FUNCTION_SPECS
}

/**
 * Get list of all supported function names.
 */
export function getSupportedFunctions(): FunctionName[] {
  return Object.keys(FUNCTION_SPECS) as FunctionName[]
}
