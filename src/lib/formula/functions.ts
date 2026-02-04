/**
 * Excel Function → DuckDB SQL Mapping
 *
 * Defines how Excel-like functions are transpiled to DuckDB SQL.
 * Handles type coercion and argument validation.
 */

import type { FunctionName } from './ast'

/** Category for organizing functions in the UI */
export type FunctionCategory = 'conditional' | 'text' | 'numeric' | 'logical' | 'null'

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
