/**
 * Command Pattern Types
 *
 * Core type definitions for the unified command system that handles:
 * - Audit logging
 * - Undo/Redo (3-tier strategy)
 * - Row/cell highlighting
 * - Diff views
 */

import type { ColumnInfo } from '@/types'

// ===== COMMAND TYPES =====

export type CommandType =
  // Transform (Tier 1 - Column Versioning)
  | 'transform:trim'
  | 'transform:lowercase'
  | 'transform:uppercase'
  | 'transform:title_case'
  | 'transform:remove_accents'
  | 'transform:replace'
  | 'transform:replace_empty'
  | 'transform:sentence_case'
  | 'transform:collapse_spaces'
  | 'transform:remove_non_printable'
  // Transform (Tier 2 - Invertible SQL)
  | 'transform:rename_column'
  // Transform (Tier 3 - Snapshot Required)
  | 'transform:remove_duplicates'
  | 'transform:cast_type'
  | 'transform:split_column'
  | 'transform:combine_columns'
  | 'transform:standardize_date'
  | 'transform:calculate_age'
  | 'transform:unformat_currency'
  | 'transform:fix_negatives'
  | 'transform:pad_zeros'
  | 'transform:fill_down'
  | 'transform:custom_sql'
  // Standardize (Tier 3)
  | 'standardize:apply'
  // Match (Tier 3)
  | 'match:merge'
  // Combine (Tier 3)
  | 'combine:stack'
  | 'combine:join'
  // Scrub (Tier 1 for hash/mask, Tier 3 for redact)
  | 'scrub:hash'
  | 'scrub:redact'
  | 'scrub:mask'
  | 'scrub:year_only'
  // Edit (Tier 2)
  | 'edit:cell'
  | 'edit:batch'
  // Schema (Tier 3 - Column operations)
  | 'schema:add_column'
  | 'schema:delete_column'
  // Data (Tier 3 - Row operations)
  | 'data:insert_row'
  | 'data:delete_row'

// ===== CONTEXT =====

export interface CommandContext {
  db: {
    query: <T>(sql: string) => Promise<T[]>
    execute: (sql: string) => Promise<void>
    getTableColumns: (tableName: string) => Promise<ColumnInfo[]>
    tableExists: (tableName: string) => Promise<boolean>
  }
  table: {
    id: string
    name: string
    columns: ColumnInfo[]
    rowCount: number
  }
  project?: {
    secret: string
  } // For hash operations (FR-D1)
  /** Column version metadata for undo (Tier 1) */
  columnVersions: Map<string, ColumnVersionInfo>
  /** Timeline ID for this table */
  timelineId?: string

  // Batching support (optional - injected by executor for large operations)
  /** If true, command should use batching for large operations */
  batchMode?: boolean
  /** Batch size (default: 50000) */
  batchSize?: number
  /** Progress callback for batched operations */
  onBatchProgress?: (current: number, total: number, percent: number) => void
}

/**
 * Column version info for expression chaining (Tier 1 undo)
 *
 * Instead of creating multiple backup columns, we chain expressions on a single base column.
 * This allows chained transforms (trim → lowercase) on the same column.
 *
 * Example:
 *   Step 1 (trim):     Email__base created, Email = TRIM("Email__base")
 *   Step 2 (lower):    Email = LOWER(TRIM("Email__base"))
 *   Undo lowercase:    Email = TRIM("Email__base")
 *   Undo trim:         Email__base renamed back to Email
 *
 * Materialization:
 *   After COLUMN_MATERIALIZATION_THRESHOLD transforms, the current value is
 *   copied back to base, resetting the expression stack. A snapshot is kept
 *   to support undo past the materialization point.
 */
export interface ColumnVersionInfo {
  /** The original column name (e.g., "Email") */
  originalColumn: string
  /** Single backup column (e.g., "Email__base") */
  baseColumn: string
  /** Stack of transform expressions, applied in order */
  expressionStack: ExpressionEntry[]
  /** Snapshot table name for undo past materialization (Phase 6.3) */
  materializationSnapshot?: string
  /** Position in expression stack when materialization occurred */
  materializationPosition?: number
}

export interface ExpressionEntry {
  /** SQL expression with {{COL}} placeholder (e.g., "TRIM({{COL}})") */
  expression: string
  /** ID of the command that added this expression */
  commandId: string
}

// ===== VALIDATION =====

export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface ValidationError {
  code: string
  message: string
  field?: string
  /** Optional: Command that can fix this error automatically */
  fixAction?: {
    label: string // "Cast to string first"
    commandType: CommandType
    params: unknown // Params to create fix command
  }
}

export interface ValidationWarning {
  code: string
  message: string
  requiresConfirmation: boolean
  confirmationData?: Record<string, unknown>
}

// ===== EXECUTION =====

export interface ExecutionResult {
  success: boolean
  rowCount: number
  columns: ColumnInfo[]
  affected: number
  error?: string
  /** Columns added by this command (e.g., split_column) */
  newColumnNames: string[]
  /** Columns removed by this command (e.g., combine_columns, match:merge) */
  droppedColumnNames: string[]
  /** Mapping of old column names to new names (for rename_column) */
  renameMappings?: Record<string, string>
  /** Column to insert new columns after (null = beginning, undefined = end) */
  insertAfter?: string | null
  /** For Tier 1 commands: the versioned column created */
  versionedColumn?: {
    original: string
    backup: string
    version: number
  }
  /** Sample before/after values for audit drill-down (batched operations only, max 1000 rows) */
  sampleChanges?: { before: string; after: string }[]
}

// ===== AUDIT =====

export interface AuditInfo {
  action: string
  /** Structured details (JSON-serializable) for rich drill-down */
  details: AuditDetails
  affectedColumns: string[]
  rowsAffected: number
  hasRowDetails: boolean
  auditEntryId: string
  isCapped: boolean
}

/** Structured audit details - type varies by command */
export type AuditDetails =
  | TransformAuditDetails
  | StandardizeAuditDetails
  | MergeAuditDetails
  | CombineAuditDetails
  | EditAuditDetails

export interface TransformAuditDetails {
  type: 'transform'
  transformationType: string
  column?: string
  params?: Record<string, unknown>
  sampleChanges?: { before: string; after: string }[]
}

export interface StandardizeAuditDetails {
  type: 'standardize'
  column: string
  algorithm: 'fingerprint' | 'metaphone'
  clusterCount: number
  /** Cluster mappings: clusterId -> { masterValue, memberValues[] } */
  clusters: Record<string, { master: string; members: string[] }>
}

export interface MergeAuditDetails {
  type: 'merge'
  matchColumns: string[]
  pairsMerged: number
  rowsDeleted: number
  survivorStrategy: 'first' | 'most_complete'
}

export interface CombineAuditDetails {
  type: 'combine'
  operation: 'stack' | 'join'
  sourceTableA: string
  sourceTableB: string
  joinKey?: string
  joinType?: 'inner' | 'left' | 'right' | 'full'
}

export interface EditAuditDetails {
  type: 'edit'
  cellCount: number
  changes: {
    rowId: string
    column: string
    before: unknown
    after: unknown
  }[]
}

// ===== INVERTIBILITY (3-tier strategy) =====

export type UndoTier = 1 | 2 | 3

export interface InvertibilityInfo {
  /** Undo tier: 1=column versioning, 2=inverse SQL, 3=snapshot */
  tier: UndoTier
  /** For Tier 2: SQL to undo */
  inverseSql?: string
  /** For Tier 1: column versioning metadata */
  columnVersion?: {
    original: string
    backup: string
  }
  /** Human-readable explanation */
  undoStrategy: string
}

// ===== HIGHLIGHTING =====

export interface HighlightInfo {
  /** SQL WHERE clause identifying affected rows (for grid injection) */
  rowPredicate: string | null
  /** Columns to highlight headers */
  columns: string[]
  /** Highlight mode for UI */
  mode: 'row' | 'cell' | 'column' | 'full'
}

// ===== COMMAND INTERFACE =====

export interface Command<TParams = unknown> {
  readonly id: string
  readonly type: CommandType
  readonly label: string
  readonly params: TParams

  /** Validate params and preconditions. May suggest auto-fix actions. */
  validate(ctx: CommandContext): Promise<ValidationResult>

  /** Execute the command. Returns schema changes for immediate UI update. */
  execute(ctx: CommandContext): Promise<ExecutionResult>

  /** Get structured audit info for logging and drill-down. */
  getAuditInfo(ctx: CommandContext, result: ExecutionResult): AuditInfo

  /** Determine undo strategy (Tier 1/2/3). */
  getInvertibility(): InvertibilityInfo

  /**
   * Get SQL WHERE clause for affected rows (row/cell highlighting).
   * Returns null if highlighting not applicable (e.g., remove_duplicates).
   */
  getAffectedRowsPredicate(ctx: CommandContext): Promise<string | null>

  /**
   * Generate SQL for diff view creation.
   * Used by CommandExecutor to create v_diff_step_X view.
   */
  getDiffViewSql?(ctx: CommandContext, stepIndex: number): string

  /**
   * Get SQL to undo this command (Tier 2 only).
   * Returns the inverse SQL after execution for undo purposes.
   */
  getInverseSql?(ctx: CommandContext): string
}

// ===== EXECUTOR TYPES =====

export interface ExecutorProgress {
  phase:
    | 'validating'
    | 'snapshotting'
    | 'executing'
    | 'auditing'
    | 'diffing'
    | 'complete'
  progress: number // 0-100
  message: string
}

export interface ExecuteOptions {
  skipValidation?: boolean
  skipDiffView?: boolean
  skipTimeline?: boolean
  skipAudit?: boolean
  onProgress?: (progress: ExecutorProgress) => void
}

export interface ExecutorResult {
  success: boolean
  executionResult?: ExecutionResult
  validationResult?: ValidationResult
  auditInfo?: AuditInfo
  highlightInfo?: HighlightInfo
  diffViewName?: string // v_diff_step_X
  error?: string
}

export interface ICommandExecutor {
  /** Execute with full lifecycle including diff view creation */
  execute(command: Command, options?: ExecuteOptions): Promise<ExecutorResult>

  /** Undo using appropriate tier strategy */
  undo(tableId: string): Promise<ExecutorResult>

  /** Redo command */
  redo(tableId: string): Promise<ExecutorResult>

  canUndo(tableId: string): boolean
  canRedo(tableId: string): boolean

  /** Get highlight predicate for current step (for grid injection) */
  getHighlightPredicate(tableId: string, stepIndex: number): string | null
}

// ===== TIMELINE COMMAND (internal) =====

/**
 * Represents a single cell change for tracking dirty cells
 */
export interface CellChange {
  /** Row identifier (_cs_id) */
  csId: string
  /** Column name */
  columnName: string
  /** Value before the change (for undo) */
  previousValue: unknown
  /** Value after the change (for redo) */
  newValue: unknown
}

/**
 * Snapshot storage types
 * - table: In-memory DuckDB table (fast undo, high RAM)
 * - parquet: OPFS Parquet file (slow undo, low RAM)
 */
export type SnapshotStorageType = 'table' | 'parquet'

/**
 * Metadata for a snapshot, tracking its storage location
 */
export interface SnapshotMetadata {
  id: string
  storageType: SnapshotStorageType
  tableName?: string  // For 'table' storage
  path?: string       // For 'parquet' storage
}

export interface TimelineCommandRecord {
  id: string
  commandType: CommandType
  label: string
  params: unknown
  timestamp: Date
  tier: UndoTier
  auditEntryId?: string
  /** For Tier 1: backup column name */
  backupColumn?: string
  /** For Tier 2: inverse SQL */
  inverseSql?: string
  /** For Tier 3: snapshot metadata (table or Parquet) */
  snapshotTable?: SnapshotMetadata
  /** Highlight predicate */
  rowPredicate?: string | null
  affectedColumns?: string[]
  rowsAffected?: number
  /** For edit:cell commands - tracks cell changes for dirty indicators */
  cellChanges?: CellChange[]
  /** Set to true when snapshot was pruned - undo no longer possible for Tier 3 commands */
  undoDisabled?: boolean
  /** Column order BEFORE this command executed (for undo) */
  columnOrderBefore?: string[]
  /** Column order AFTER this command executed (for redo) */
  columnOrderAfter?: string[]
}
