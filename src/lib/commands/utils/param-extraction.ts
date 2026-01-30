/**
 * Parameter Extraction Utilities
 *
 * Provides type-safe extraction of custom parameters from command params.
 * Used to ensure parameters are properly preserved through the dual-timeline
 * system (executor.ts → timelineStore → timeline-engine.ts).
 *
 * The Problem:
 * Commands have params like { tableId, column, length, delimiter, caseSensitive }.
 * When syncing to timelineStore, we need to extract ONLY the custom params
 * (length, delimiter, caseSensitive) and nest them in params.params for replay.
 *
 * The Solution:
 * 1. Compile-time safety via TypeScript generics
 * 2. Runtime validation in development mode as backup
 */

/**
 * Base parameters that exist on all command params.
 * These are handled separately and should NOT be nested in params.params.
 */
export interface BaseCommandParams {
  tableId: string
  column?: string
  tableName?: string  // Some commands use tableName
}

/**
 * List of base param keys to exclude when extracting custom params.
 * Matches BaseCommandParams interface.
 */
const BASE_PARAM_KEYS: ReadonlySet<string> = new Set([
  'tableId',
  'column',
  'tableName',
])

/**
 * Extract custom parameters from command params, excluding base params.
 *
 * Uses TypeScript generics for COMPILE-TIME safety - the compiler catches
 * type mismatches before runtime.
 *
 * @example
 * ```typescript
 * const params = { tableId: 'abc', column: 'name', length: 9, fillChar: '0' }
 * const custom = extractCustomParams(params)
 * // custom = { length: 9, fillChar: '0' }
 * ```
 *
 * @param params - Full command params including tableId, column, etc.
 * @returns Object containing only the custom params (excludes tableId, column, tableName)
 */
export function extractCustomParams<T extends BaseCommandParams>(
  params: T
): Omit<T, keyof BaseCommandParams> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (!BASE_PARAM_KEYS.has(key)) {
      result[key] = value
    }
  }

  return result as Omit<T, keyof BaseCommandParams>
}

/**
 * Check if params object has any custom params (non-base params).
 *
 * @param params - Command params to check
 * @returns true if there are custom params beyond tableId/column/tableName
 */
export function hasCustomParams(params: Record<string, unknown>): boolean {
  for (const key of Object.keys(params)) {
    if (!BASE_PARAM_KEYS.has(key)) {
      return true
    }
  }
  return false
}

/**
 * Get list of custom param keys from a params object.
 * Useful for debugging and validation.
 *
 * @param params - Command params to inspect
 * @returns Array of custom param key names
 */
export function getCustomParamKeys(params: Record<string, unknown>): string[] {
  return Object.keys(params).filter(key => !BASE_PARAM_KEYS.has(key))
}

/**
 * Runtime validation for param structure (development mode only).
 *
 * Validates that custom params in command.params match what's stored
 * in timeline params. This catches bugs during development.
 *
 * @param commandParams - Original command params
 * @param timelineParams - Params stored in timeline (should have nested params.params)
 * @param commandType - Command type for error messages
 * @throws Error in development mode if params don't match
 */
export function validateParamSync(
  commandParams: Record<string, unknown>,
  timelineParams: { params?: Record<string, unknown> },
  commandType: string
): void {
  // Only validate in development mode
  if (process.env.NODE_ENV !== 'development') {
    return
  }

  const customParams = extractCustomParams(commandParams as BaseCommandParams & Record<string, unknown>)
  const customKeys = Object.keys(customParams)

  // If no custom params, nothing to validate
  if (customKeys.length === 0) {
    return
  }

  // Check that timelineParams.params exists and contains all custom keys
  const nestedParams = timelineParams.params || {}

  for (const key of customKeys) {
    if (!(key in nestedParams)) {
      console.warn(
        `[ParamSync] Missing custom param "${key}" in timeline params for ${commandType}. ` +
        `Command has: ${JSON.stringify(customParams)}, ` +
        `Timeline has: ${JSON.stringify(nestedParams)}`
      )
    } else if (nestedParams[key] !== customParams[key]) {
      console.warn(
        `[ParamSync] Param mismatch for "${key}" in ${commandType}. ` +
        `Command: ${JSON.stringify(customParams[key])}, ` +
        `Timeline: ${JSON.stringify(nestedParams[key])}`
      )
    }
  }
}

/**
 * Known commands with custom parameters that require special handling.
 * Used for documentation and testing purposes.
 *
 * Format: commandType → array of custom param names
 */
export const COMMANDS_WITH_CUSTOM_PARAMS: Readonly<Record<string, readonly string[]>> = {
  // High risk (Tier 3 - snapshot-based undo)
  'transform:split_column': ['splitMode', 'delimiter', 'position', 'length'],
  'transform:combine_columns': ['delimiter', 'newColumnName', 'ignoreEmpty'],
  'match:merge': ['pairs'],

  // Medium risk
  'transform:replace': ['find', 'replace', 'caseSensitive', 'useRegex'],
  'transform:pad_zeros': ['length', 'fillChar', 'position'],
  'transform:cast_type': ['targetType', 'dateFormat'],
  'scrub:mask': ['preserveFirst', 'preserveLast', 'maskChar'],
  'scrub:hash': ['algorithm', 'salt'],
  'standardize:apply': ['mappings'],

  // Lower risk
  'transform:replace_empty': ['replacement'],
  'transform:custom_sql': ['sql', 'newColumnName'],
  'transform:calculate_age': ['referenceDate', 'dateFormat'],
  'transform:fill_down': ['limit'],
  'transform:standardize_date': ['inputFormat', 'outputFormat', 'format'],
  'transform:unformat_currency': ['currencySymbols', 'thousandsSeparator'],
  'transform:jitter': ['min', 'max', 'distribution'],
  'scrub:faker': ['fakerType', 'locale'],
  'scrub:year_only': ['outputFormat'],
} as const

/**
 * Get the expected custom param names for a command type.
 * Returns undefined if the command type is not in the known list.
 *
 * @param commandType - The command type to look up
 * @returns Array of expected param names, or undefined
 */
export function getExpectedCustomParams(commandType: string): readonly string[] | undefined {
  return COMMANDS_WITH_CUSTOM_PARAMS[commandType]
}
