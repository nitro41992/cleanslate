/**
 * JSON Serialization Utilities with BigInt Support
 *
 * JavaScript's native JSON.stringify() throws errors on BigInt values.
 * These utilities safely convert BigInt to strings for JSON serialization.
 */

/**
 * Recursively sanitize an object for JSON serialization.
 * Converts all BigInt values to strings to prevent JSON.stringify errors.
 *
 * @param obj - Object to sanitize
 * @returns Sanitized object safe for JSON.stringify
 */
export function sanitizeForJSON<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj
  }

  // Handle BigInt directly
  if (typeof obj === 'bigint') {
    return String(obj) as T
  }

  // Handle primitives
  if (typeof obj !== 'object') {
    return obj
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForJSON(item)) as T
  }

  // Handle objects
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizeForJSON(value)
  }
  return sanitized as T
}

/**
 * JSON replacer function for use with JSON.stringify().
 * Converts BigInt values to strings.
 *
 * @example
 * JSON.stringify(data, bigIntReplacer)
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return String(value)
  }
  return value
}

/**
 * Safe JSON.stringify that handles BigInt values.
 *
 * @param value - Value to stringify
 * @param space - Indentation for pretty printing (optional)
 * @returns JSON string
 */
export function stringifyJSON(value: unknown, space?: string | number): string {
  return JSON.stringify(value, bigIntReplacer, space)
}
