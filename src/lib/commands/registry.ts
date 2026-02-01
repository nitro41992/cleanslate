/**
 * Command Registry
 *
 * Factory pattern for creating typed Command instances from UI params.
 * Centralizes command creation and provides type safety.
 */

import type { Command, CommandType } from './types'
import { generateId } from '@/lib/utils'

// Command class imports (will be added as commands are implemented)
// import { TrimCommand } from './transform/tier1/trim'
// import { LowercaseCommand } from './transform/tier1/lowercase'
// etc.

/**
 * Command constructor type
 */
export type CommandConstructor<TParams = unknown> = new (
  id: string,
  params: TParams
) => Command<TParams>

/**
 * Registry of command constructors
 */
const commandRegistry = new Map<CommandType, CommandConstructor<unknown>>()

/**
 * Register a command class
 */
export function registerCommand<TParams>(
  type: CommandType,
  constructor: CommandConstructor<TParams>
): void {
  commandRegistry.set(type, constructor as CommandConstructor<unknown>)
}

/**
 * Create a command instance from type and params
 */
export function createCommand<TParams>(
  type: CommandType,
  params: TParams
): Command<TParams> {
  const Constructor = commandRegistry.get(type)
  if (!Constructor) {
    throw new Error(`Unknown command type: ${type}`)
  }

  const id = generateId()
  return new Constructor(id, params) as Command<TParams>
}

/**
 * Check if a command type is registered
 */
export function isCommandRegistered(type: CommandType): boolean {
  return commandRegistry.has(type)
}

/**
 * Get all registered command types
 */
export function getRegisteredCommandTypes(): CommandType[] {
  return Array.from(commandRegistry.keys())
}

// ===== TRANSFORMATION TYPE MAPPING =====

/**
 * Map from TransformationType to CommandType
 */
export const TRANSFORM_TO_COMMAND: Record<string, CommandType> = {
  // Tier 1 (Column Versioning)
  trim: 'transform:trim',
  lowercase: 'transform:lowercase',
  uppercase: 'transform:uppercase',
  title_case: 'transform:title_case',
  remove_accents: 'transform:remove_accents',
  replace: 'transform:replace',
  replace_empty: 'transform:replace_empty',
  sentence_case: 'transform:sentence_case',
  collapse_spaces: 'transform:collapse_spaces',
  remove_non_printable: 'transform:remove_non_printable',

  // Tier 2 (Invertible SQL)
  rename_column: 'transform:rename_column',

  // Tier 3 (Snapshot Required)
  remove_duplicates: 'transform:remove_duplicates',
  cast_type: 'transform:cast_type',
  split_column: 'transform:split_column',
  combine_columns: 'transform:combine_columns',
  standardize_date: 'transform:standardize_date',
  calculate_age: 'transform:calculate_age',
  unformat_currency: 'transform:unformat_currency',
  fix_negatives: 'transform:fix_negatives',
  pad_zeros: 'transform:pad_zeros',
  fill_down: 'transform:fill_down',
  custom_sql: 'transform:custom_sql',
}

/**
 * Get CommandType from TransformationType
 */
export function getCommandTypeFromTransform(
  transformationType: string
): CommandType | undefined {
  return TRANSFORM_TO_COMMAND[transformationType]
}

// ===== TIER CLASSIFICATION =====

/**
 * Tier 1 commands (Column Versioning - instant undo)
 */
export const TIER_1_COMMANDS: Set<CommandType> = new Set([
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
  'scrub:hash',
  'scrub:mask',
])

/**
 * Tier 2 commands (Invertible SQL - no snapshot needed)
 */
export const TIER_2_COMMANDS: Set<CommandType> = new Set([
  'transform:rename_column',
  'edit:cell',
  'edit:batch',
  'combine:stack',
  'combine:join',
])

/**
 * Tier 3 commands (Snapshot Required - expensive undo)
 */
export const TIER_3_COMMANDS: Set<CommandType> = new Set([
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
  'standardize:apply',
  'match:merge',
  'scrub:redact',
  'scrub:year_only',
  // Schema commands (column operations)
  'schema:add_column',
  'schema:delete_column',
  // Data commands (row operations)
  'data:insert_row',
  'data:delete_row',
])

/**
 * Get the undo tier for a command type
 */
export function getUndoTier(type: CommandType): 1 | 2 | 3 {
  if (TIER_1_COMMANDS.has(type)) return 1
  if (TIER_2_COMMANDS.has(type)) return 2
  return 3
}

/**
 * Command execution metadata for optimization flags
 */
export interface CommandMetadata {
  /** Skip pre-snapshot for UPDATE-only operations (Phase 2.1) */
  requiresSnapshot?: boolean
  /** Skip pre-execution audit capture for mapping-based ops (Phase 2.2) */
  capturePreExecution?: boolean
  /** Skip diff view creation (Phase 2.3) */
  createDiffView?: boolean
}

/**
 * Command-specific metadata overrides
 */
const COMMAND_METADATA: Partial<Record<CommandType, CommandMetadata>> = {
  // Standardize is Tier 3 but doesn't need heavy instrumentation
  // It's a simple UPDATE that can be undone via inverse CASE-WHEN
  'standardize:apply': {
    requiresSnapshot: false,      // UPDATE is reversible, no pre-snapshot needed
    capturePreExecution: false,   // Value mappings stored in audit, not row-level changes
    createDiffView: false,         // Highlighting not essential for standardize
  },
}

/**
 * Get execution metadata for a command type
 */
export function getCommandMetadata(type: CommandType): CommandMetadata | undefined {
  return COMMAND_METADATA[type]
}

/**
 * Check if a command type requires a snapshot before execution
 */
export function requiresSnapshot(type: CommandType): boolean {
  const metadata = COMMAND_METADATA[type]
  if (metadata?.requiresSnapshot !== undefined) {
    return metadata.requiresSnapshot
  }
  return TIER_3_COMMANDS.has(type)
}

// ===== COMMAND LABELS =====

/**
 * Get human-readable label for a command type
 */
export function getCommandLabel(type: CommandType): string {
  const labels: Record<CommandType, string> = {
    'transform:trim': 'Trim Whitespace',
    'transform:lowercase': 'Lowercase',
    'transform:uppercase': 'Uppercase',
    'transform:title_case': 'Title Case',
    'transform:remove_accents': 'Remove Accents',
    'transform:replace': 'Find & Replace',
    'transform:replace_empty': 'Replace Empty',
    'transform:sentence_case': 'Sentence Case',
    'transform:collapse_spaces': 'Collapse Spaces',
    'transform:remove_non_printable': 'Remove Non-Printable',
    'transform:rename_column': 'Rename Column',
    'transform:remove_duplicates': 'Remove Duplicates',
    'transform:cast_type': 'Cast Type',
    'transform:split_column': 'Split Column',
    'transform:combine_columns': 'Combine Columns',
    'transform:standardize_date': 'Standardize Date',
    'transform:calculate_age': 'Calculate Age',
    'transform:unformat_currency': 'Unformat Currency',
    'transform:fix_negatives': 'Fix Negatives',
    'transform:pad_zeros': 'Pad Zeros',
    'transform:fill_down': 'Fill Down',
    'transform:custom_sql': 'Custom SQL',
    'standardize:apply': 'Apply Standardization',
    'match:merge': 'Merge Duplicates',
    'combine:stack': 'Stack Tables',
    'combine:join': 'Join Tables',
    'scrub:hash': 'Hash Column',
    'scrub:redact': 'Redact PII',
    'scrub:mask': 'Mask Values',
    'scrub:year_only': 'Year Only',
    'edit:cell': 'Edit Cell',
    'edit:batch': 'Batch Edit',
    'schema:add_column': 'Add Column',
    'schema:delete_column': 'Delete Column',
    'data:insert_row': 'Insert Row',
    'data:delete_row': 'Delete Row',
  }

  return labels[type] || type
}
