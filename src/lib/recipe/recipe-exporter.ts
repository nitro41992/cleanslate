/**
 * Recipe Exporter
 *
 * Exports transforms from the audit log/timeline as a recipe.
 * Filters out commands that are not schema-dependent (edit:cell, match:merge, etc.).
 */

import type { RecipeStep } from '@/types'
import type { TimelineCommand } from '@/types'

/**
 * Commands that are EXCLUDED from recipes.
 * These commands reference specific row IDs or external tables.
 */
const EXCLUDED_COMMANDS: Set<string> = new Set([
  'edit:cell',
  'edit:batch',
  'match:merge',
  'data:insert_row',
  'data:delete_row',
  'combine:stack',
  'combine:join',
])

/**
 * Commands that are INCLUDED in recipes (schema-dependent only).
 */
const INCLUDED_COMMANDS: Set<string> = new Set([
  // Tier 1 transforms
  'transform:trim',
  'transform:lowercase',
  'transform:uppercase',
  'transform:title_case',
  'transform:remove_accents',
  'transform:replace',
  'transform:replace_empty',
  'transform:sentence_case',
  'transform:collapse_spaces',
  'transform:remove_non_printable',
  // Tier 2 transforms
  'transform:rename_column',
  // Tier 3 transforms
  'transform:remove_duplicates',
  'transform:cast_type',
  'transform:split_column',
  'transform:combine_columns',
  'transform:standardize_date',
  'transform:calculate_age',
  'transform:unformat_currency',
  'transform:fix_negatives',
  'transform:pad_zeros',
  'transform:fill_down',
  'transform:custom_sql',
  // Scrub commands
  'scrub:hash',
  'scrub:mask',
  'scrub:redact',
  'scrub:year_only',
  // Schema commands
  'schema:add_column',
  'schema:delete_column',
  // Note: standardize:apply is NOT included because it relies on fuzzy matching
  // (fingerprint, metaphone, etc.) which is not reproducible across datasets.
  // Unique value replacements (All tab) emit transform:replace which IS recipe-compatible.
])

/**
 * Check if a command type can be included in a recipe.
 */
export function isRecipeCompatibleCommand(commandType: string): boolean {
  return INCLUDED_COMMANDS.has(commandType) && !EXCLUDED_COMMANDS.has(commandType)
}

/**
 * Extract recipe steps from timeline commands.
 *
 * @param commands - Timeline commands from a table's timeline
 * @returns Array of recipe steps (filtered to schema-dependent commands only)
 */
export function extractRecipeSteps(commands: TimelineCommand[]): RecipeStep[] {
  const steps: RecipeStep[] = []

  for (const cmd of commands) {
    // Extract params from timeline command
    const params = cmd.params as unknown as Record<string, unknown>

    // Reconstruct full command type BEFORE filtering
    const fullCommandType = getCommandType(cmd, params)

    // Skip non-recipe-compatible commands
    if (!isRecipeCompatibleCommand(fullCommandType)) {
      continue
    }

    // Build recipe step
    const step: RecipeStep = {
      id: generateId(),
      type: fullCommandType,
      label: cmd.label,
      column: extractColumn(params),
      params: extractCustomParams(cmd, params),
      enabled: true,
    }

    steps.push(step)
  }

  return steps
}

/**
 * Get the command type from a timeline command.
 */
function getCommandType(cmd: TimelineCommand, params: Record<string, unknown>): string {
  // For transform commands, reconstruct the full type
  if (cmd.commandType === 'transform' && params.transformationType) {
    return `transform:${params.transformationType}`
  }

  // For scrub commands
  if (cmd.commandType === 'scrub' && params.method) {
    return `scrub:${params.method}`
  }

  // Note: standardize commands are no longer included in recipes
  // Standardize panel now emits individual transform:replace commands

  // For data/schema commands
  if (cmd.commandType === 'data' && params.dataOperation) {
    return `data:${params.dataOperation}`
  }

  // For direct command types
  if (cmd.commandType.includes(':')) {
    return cmd.commandType
  }

  // Fallback - reconstruct from params if possible
  const type = params.type as string
  if (type === 'transform' && params.transformationType) {
    return `transform:${params.transformationType}`
  }

  return cmd.commandType
}

/**
 * Extract the target column from params.
 */
function extractColumn(params: Record<string, unknown>): string | undefined {
  return (params.column as string) || (params.columnName as string) || undefined
}

/**
 * Extract custom parameters (excluding standard fields).
 */
function extractCustomParams(
  _cmd: TimelineCommand,
  params: Record<string, unknown>
): Record<string, unknown> | undefined {
  // Fields to exclude from custom params
  const excludeFields = new Set([
    'type',
    'tableId',
    'column',
    'columnName',
    'transformationType',
    'dataOperation',
    'method',
  ])

  const customParams: Record<string, unknown> = {}

  // Get nested params if they exist
  const nestedParams = (params.params as Record<string, unknown>) || {}

  // Merge top-level and nested params
  for (const [key, value] of Object.entries({ ...params, ...nestedParams })) {
    if (!excludeFields.has(key) && value !== undefined && key !== 'params') {
      customParams[key] = value
    }
  }

  return Object.keys(customParams).length > 0 ? customParams : undefined
}

/**
 * Get required columns from recipe steps.
 */
export function extractRequiredColumns(steps: RecipeStep[]): string[] {
  const columns = new Set<string>()

  for (const step of steps) {
    // Add main column
    if (step.column) {
      columns.add(step.column)
    }

    // Check params for additional column references
    if (step.params) {
      const sourceColumns = step.params.sourceColumns as string[] | undefined
      if (sourceColumns) {
        sourceColumns.forEach((c) => columns.add(c))
      }

      const column = step.params.column as string | undefined
      if (column) {
        columns.add(column)
      }

      // For combine_columns
      const cols = step.params.columns as string[] | undefined
      if (cols) {
        cols.forEach((c) => columns.add(c))
      }
    }
  }

  return Array.from(columns).sort()
}

/**
 * Generate a unique ID for recipe steps.
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 11)
}

/**
 * Filter audit entries to only recipe-compatible commands.
 * Used by the AuditSidebar "Export as Recipe" button.
 */
export function filterRecipeCompatibleEntries<T extends { action: string }>(
  entries: T[]
): T[] {
  return entries.filter((entry) => {
    // Try to determine if this is a recipe-compatible action
    // The action string contains the human-readable transform name
    const action = entry.action.toLowerCase()

    // These are definitely NOT recipe-compatible
    const excludePatterns = [
      'cell edit',
      'manual edit',
      'merge',
      'stack',
      'join',
      'insert row',
      'delete row',
      'file loaded',
      'table created',
      'table persisted',
      'standardize',  // Actionable standardizations use fuzzy matching - not reproducible
    ]

    for (const pattern of excludePatterns) {
      if (action.includes(pattern)) {
        return false
      }
    }

    return true
  })
}
