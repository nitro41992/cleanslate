/**
 * Command Pattern System
 *
 * Unified command system for CleanSlate Pro that handles:
 * - Audit logging
 * - Undo/Redo (3-tier strategy)
 * - Row/cell highlighting
 * - Diff views
 *
 * @example
 * ```typescript
 * import { createCommand, getCommandExecutor } from '@/lib/commands'
 *
 * // Create a command
 * const command = createCommand('transform:trim', {
 *   tableId: 'my-table-id',
 *   column: 'email'
 * })
 *
 * // Execute with full lifecycle
 * const executor = getCommandExecutor()
 * const result = await executor.execute(command)
 *
 * if (result.success) {
 *   console.log('Affected rows:', result.executionResult?.affected)
 * }
 *
 * // Undo
 * if (executor.canUndo('my-table-id')) {
 *   await executor.undo('my-table-id')
 * }
 * ```
 */

// Types
export type {
  CommandType,
  Command,
  CommandContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ExecutionResult,
  AuditInfo,
  AuditDetails,
  TransformAuditDetails,
  StandardizeAuditDetails,
  MergeAuditDetails,
  CombineAuditDetails,
  EditAuditDetails,
  UndoTier,
  InvertibilityInfo,
  HighlightInfo,
  ExecutorProgress,
  ExecuteOptions,
  ExecutorResult,
  ICommandExecutor,
  ColumnVersionInfo,
  ExpressionEntry,
  TimelineCommandRecord,
  CellChange,
} from './types'

// Registry
export {
  registerCommand,
  createCommand,
  isCommandRegistered,
  getRegisteredCommandTypes,
  getCommandTypeFromTransform,
  getUndoTier,
  requiresSnapshot,
  getCommandLabel,
  TRANSFORM_TO_COMMAND,
  TIER_1_COMMANDS,
  TIER_2_COMMANDS,
  TIER_3_COMMANDS,
} from './registry'

// Executor
export {
  CommandExecutor,
  getCommandExecutor,
  resetCommandExecutor,
  clearCommandTimeline,
} from './executor'

// Context
export {
  buildCommandContext,
  getColumnVersionStore,
  setColumnVersionStore,
  clearColumnVersionStore,
  refreshTableContext,
  createTestContext,
} from './context'

// Column Versioning
export {
  createColumnVersionManager,
  scanForBaseColumns,
  getTier1UndoSQL,
  getTier1ExecuteSQL,
  buildNestedExpression,
  getBaseColumnName,
  isBaseColumn,
  getOriginalFromBase,
  COLUMN_PLACEHOLDER,
  // Deprecated but kept for backward compatibility
  scanForBackupColumns,
  getBackupColumnName,
  isBackupColumn,
  getOriginalFromBackup,
  type ColumnVersionManager,
  type VersionResult,
  type UndoResult,
  type ColumnVersionStore,
} from './column-versions'

// Diff Views
export {
  getDiffViewName,
  createTier1DiffView,
  createTier3DiffView,
  dropDiffView,
  dropAllDiffViews,
  queryDiffView,
  getHighlightInfoFromDiffView,
  injectHighlightPredicate,
  type DiffViewConfig,
} from './diff-views'

// Utils
export {
  escapeSqlString,
  quoteColumn,
  quoteTable,
  toSqlValue,
  escapeLikePattern,
  escapeRegexPattern,
  buildCaseWhen,
  buildColumnList,
  buildSetClause,
  buildInClause,
  buildAlterTable,
} from './utils/sql'

export {
  DATE_FORMATS,
  OUTPUT_FORMATS,
  buildDateParseExpression,
  buildDateFormatExpression,
  buildAgeExpression,
  buildDateNotNullPredicate,
  buildDateParseSuccessPredicate,
  type OutputFormat,
} from './utils/date'

// Transform Commands
export * from './transform'

// Standardize Commands
export * from './standardize'

// Match Commands
export * from './match'

// Combine Commands
export * from './combine'

// Scrub Commands
export * from './scrub'

// Edit Commands
export * from './edit'

// Schema Commands
export * from './schema'

// Data Commands
export * from './data'

// ===== COMMAND REGISTRATION =====

import { registerCommand } from './registry'
import {
  TrimCommand,
  LowercaseCommand,
  UppercaseCommand,
  TitleCaseCommand,
  RemoveAccentsCommand,
  SentenceCaseCommand,
  CollapseSpacesCommand,
  RemoveNonPrintableCommand,
  ReplaceCommand,
  ReplaceEmptyCommand,
} from './transform/tier1'
import { RenameColumnCommand } from './transform/tier2'
import {
  RemoveDuplicatesCommand,
  CastTypeCommand,
  CustomSqlCommand,
  SplitColumnCommand,
  CombineColumnsCommand,
  StandardizeDateCommand,
  CalculateAgeCommand,
  UnformatCurrencyCommand,
  FixNegativesCommand,
  PadZerosCommand,
  FillDownCommand,
} from './transform/tier3'
import { StandardizeApplyCommand } from './standardize'
import { MatchMergeCommand } from './match'
import { CombineStackCommand, CombineJoinCommand } from './combine'
import {
  ScrubHashCommand,
  ScrubMaskCommand,
  ScrubRedactCommand,
  ScrubYearOnlyCommand,
  ScrubLast4Command,
  ScrubZeroCommand,
  ScrubScrambleCommand,
  ScrubBatchCommand,
} from './scrub'
import { EditCellCommand, BatchEditCommand } from './edit'
import { AddColumnCommand, DeleteColumnCommand } from './schema'
import { InsertRowCommand, DeleteRowCommand } from './data'

// Register all commands
registerCommand('transform:trim', TrimCommand)
registerCommand('transform:lowercase', LowercaseCommand)
registerCommand('transform:uppercase', UppercaseCommand)
registerCommand('transform:title_case', TitleCaseCommand)
registerCommand('transform:remove_accents', RemoveAccentsCommand)
registerCommand('transform:sentence_case', SentenceCaseCommand)
registerCommand('transform:collapse_spaces', CollapseSpacesCommand)
registerCommand('transform:remove_non_printable', RemoveNonPrintableCommand)
registerCommand('transform:replace', ReplaceCommand)
registerCommand('transform:replace_empty', ReplaceEmptyCommand)
registerCommand('transform:rename_column', RenameColumnCommand)
registerCommand('transform:remove_duplicates', RemoveDuplicatesCommand)
registerCommand('transform:cast_type', CastTypeCommand)
registerCommand('transform:custom_sql', CustomSqlCommand)
registerCommand('transform:split_column', SplitColumnCommand)
registerCommand('transform:combine_columns', CombineColumnsCommand)
registerCommand('transform:standardize_date', StandardizeDateCommand)
registerCommand('transform:calculate_age', CalculateAgeCommand)
registerCommand('transform:unformat_currency', UnformatCurrencyCommand)
registerCommand('transform:fix_negatives', FixNegativesCommand)
registerCommand('transform:pad_zeros', PadZerosCommand)
registerCommand('transform:fill_down', FillDownCommand)

// Standardize commands
registerCommand('standardize:apply', StandardizeApplyCommand)

// Match commands
registerCommand('match:merge', MatchMergeCommand)

// Combine commands
registerCommand('combine:stack', CombineStackCommand)
registerCommand('combine:join', CombineJoinCommand)

// Scrub commands
registerCommand('scrub:hash', ScrubHashCommand)
registerCommand('scrub:mask', ScrubMaskCommand)
registerCommand('scrub:redact', ScrubRedactCommand)
registerCommand('scrub:year_only', ScrubYearOnlyCommand)
registerCommand('scrub:last4', ScrubLast4Command)
registerCommand('scrub:zero', ScrubZeroCommand)
registerCommand('scrub:scramble', ScrubScrambleCommand)
registerCommand('scrub:batch', ScrubBatchCommand)

// Edit commands
registerCommand('edit:cell', EditCellCommand)
registerCommand('edit:batch', BatchEditCommand)

// Schema commands
registerCommand('schema:add_column', AddColumnCommand)
registerCommand('schema:delete_column', DeleteColumnCommand)

// Data commands
registerCommand('data:insert_row', InsertRowCommand)
registerCommand('data:delete_row', DeleteRowCommand)
