export interface TableInfo {
  id: string
  name: string
  columns: ColumnInfo[]
  rowCount: number
  createdAt: Date
  updatedAt: Date
  parentTableId?: string        // Source table ID (for checkpoints)
  isCheckpoint?: boolean        // Flag for checkpoint tables
  lineage?: TableLineage        // Full transformation history
  dataVersion?: number          // Increments on any data change to trigger grid refresh
  columnOrder?: string[]        // User-visible column names only (excludes _cs_id, __base)
  columnPreferences?: ColumnPreferences  // User column width/wrap settings
  viewState?: TableViewState    // Filter/sort configuration (view operation, not data mutation)
}

/**
 * User preferences for column display in the data grid.
 * Persisted to app-state.json for restoration across sessions.
 */
export interface ColumnPreferences {
  /** Column name -> pixel width (user-resized widths) */
  widths: Record<string, number>
  /** Column name -> word wrap enabled (per-column override) */
  wordWrap?: Record<string, boolean>
  /** Global word wrap toggle for all columns */
  wordWrapEnabled?: boolean
}

export interface TableLineage {
  sourceTableId: string
  sourceTableName: string
  transformations: LineageTransformation[]
  checkpointedAt: Date
}

export interface LineageTransformation {
  action: string
  details: string
  timestamp: Date
  rowsAffected?: number
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
}

export type AuditEntryType = 'A' | 'B'  // A = Transformation, B = Manual Edit

export interface AuditLogEntry {
  id: string
  timestamp: Date
  tableId: string
  tableName: string
  action: string
  details: string
  // Type B (Manual Edit) specific fields
  entryType?: AuditEntryType
  previousValue?: unknown
  newValue?: unknown
  rowIndex?: number
  columnName?: string
  csId?: string              // Stable cell identifier for manual edits (replaces rowIndex)
  // Enhanced audit fields
  rowsAffected?: number      // Actual count of modified rows
  hasRowDetails?: boolean    // Flag: row-level data exists in _audit_details
  auditEntryId?: string      // ID for looking up row details
  isCapped?: boolean         // Flag: audit details capped at threshold (50k)
}

// Serialized version for persistence
export interface SerializedAuditLogEntry {
  id: string
  timestamp: string  // ISO string
  tableId: string
  tableName: string
  action: string
  details: string
  entryType?: AuditEntryType
  previousValue?: unknown
  newValue?: unknown
  rowIndex?: number
  columnName?: string
  csId?: string
  rowsAffected?: number
  hasRowDetails?: boolean
  auditEntryId?: string
  isCapped?: boolean
}

export interface CSVIngestionSettings {
  headerRow?: number    // 1-based row number for headers
  encoding?: 'utf-8' | 'iso-8859-1'
  delimiter?: ',' | '\t' | '|' | ';'
}

export interface TransformationStep {
  id: string
  type: TransformationType
  column?: string
  params?: Record<string, unknown>
  label: string
}

export type TransformationType =
  | 'trim'
  | 'lowercase'
  | 'uppercase'
  | 'remove_duplicates'
  | 'replace_empty'
  | 'replace'
  | 'split'
  | 'merge_columns'
  | 'rename_column'
  | 'cast_type'
  | 'custom_sql'
  // FR-A3 Text Transformations
  | 'title_case'
  | 'remove_accents'
  | 'remove_non_printable'
  | 'collapse_spaces'
  | 'sentence_case'
  // FR-A3 Finance Transformations
  | 'unformat_currency'
  | 'fix_negatives'
  | 'pad_zeros'
  // FR-A3 Date/Structure Transformations
  | 'standardize_date'
  | 'calculate_age'
  | 'split_column'
  | 'combine_columns'
  | 'fill_down'

export interface DiffResult {
  status: 'added' | 'removed' | 'modified' | 'unchanged'
  rowA?: Record<string, unknown>
  rowB?: Record<string, unknown>
  modifiedColumns?: string[]
}

export type BlockingStrategy =
  // Fast SQL-only strategies (no JS preprocessing)
  | 'first_letter'           // Groups by first letter - fastest
  | 'first_2_chars'          // Groups by first 2 letters - fast
  // Accurate phonetic strategies (requires JS preprocessing)
  | 'fingerprint_block'      // Word-order independent: normalize + sort tokens
  | 'metaphone_block'        // True phonetic: full Double Metaphone codes
  | 'token_phonetic_block'   // Best for names: metaphone per word, sorted
  // Small datasets only
  | 'none'                   // Compare all pairs (only for ≤1000 rows)

export type FieldSimilarityStatus = 'exact' | 'similar' | 'different'

export interface FieldSimilarity {
  column: string
  valueA: unknown
  valueB: unknown
  similarity: number
  status: FieldSimilarityStatus
}

export interface MatchPair {
  id: string
  rowA: Record<string, unknown>
  rowB: Record<string, unknown>
  score: number
  similarity: number // 0-100 percentage (higher = more similar)
  fieldSimilarities: FieldSimilarity[]
  status: 'pending' | 'merged' | 'kept_separate'
  keepRow: 'A' | 'B' // Which row to keep when merging (default 'A')
}

export interface ObfuscationRule {
  column: string
  method: ObfuscationMethod
  params?: Record<string, unknown>
}

export type ObfuscationMethod =
  | 'redact'
  | 'mask'
  | 'hash'
  | 'faker'
  | 'scramble'
  | 'last4'
  | 'zero'
  | 'year_only'
  | 'jitter'

export type PersistenceStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** Tracks the most recent manual edit location for gutter indicators */
export interface LastEditLocation {
  tableId: string
  csId: string              // Row identifier (stable across transforms)
  columnName: string        // Column name ('*' for row insert/delete = entire row)
  editType: 'cell' | 'row_insert' | 'row_delete'
  timestamp: number         // For debugging/display
  // For row_delete only: preserve deleted row for phantom display
  deletedRowData?: Record<string, unknown>  // The row's values before deletion
  deletedRowIndex?: number                  // Original row index for phantom placement
}

// Filter & Sort types (View Operations)

/**
 * Filter operators for different column types.
 * Text operators: contains, equals, starts_with, ends_with, is_empty, is_not_empty
 * Numeric operators: eq, gt, lt, gte, lte, between
 * Date operators: date_eq, date_before, date_after, date_between, last_n_days
 * Boolean operators: is_true, is_false
 */
export type FilterOperator =
  // Text
  | 'contains'
  | 'equals'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  // Numeric
  | 'eq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'between'
  // Date
  | 'date_eq'
  | 'date_before'
  | 'date_after'
  | 'date_between'
  | 'last_n_days'
  // Boolean
  | 'is_true'
  | 'is_false'

/**
 * A single column filter configuration.
 * Filters are view operations - they modify SQL queries, not underlying data.
 */
export interface ColumnFilter {
  column: string
  operator: FilterOperator
  value: string | number | boolean | null
  value2?: string | number  // For "between" operators
}

/**
 * View state for a table - controls filtering and sorting without modifying data.
 * Similar to columnPreferences, this is a UI concern persisted for user convenience.
 */
export interface TableViewState {
  filters: ColumnFilter[]
  sortColumn: string | null
  sortDirection: 'asc' | 'desc'
}

// Combiner types (FR-E)
export type JoinType = 'left' | 'inner' | 'full_outer'

export interface StackValidation {
  isValid: boolean
  missingInA: string[]
  missingInB: string[]
  warnings: string[]
}

export interface JoinValidation {
  isValid: boolean
  keyColumnMismatch: boolean
  warnings: string[]
}

// Value Standardization types (FR-F)
export type ClusteringAlgorithm = 'fingerprint' | 'metaphone' | 'token_phonetic'

export interface ValueCluster {
  id: string
  clusterKey: string              // Computed key (fingerprint or metaphone)
  values: ClusterValue[]
  masterValue: string             // Most frequent (auto-suggested)
  selectedCount: number           // Number of selected values to standardize
}

export interface ClusterValue {
  id: string
  value: string
  count: number                   // Frequency in dataset
  isSelected: boolean
  isMaster: boolean
  customReplacement?: string      // User-defined replacement for unique values
}

export interface StandardizationMapping {
  fromValue: string
  toValue: string
  rowCount: number
}

// Timeline types for unified undo/redo and audit history

export type TimelineCommandType =
  | 'transform'
  | 'manual_edit'
  | 'merge'
  | 'standardize'
  | 'stack'
  | 'join'
  | 'scrub'
  | 'batch_edit'
  | 'data'  // for insert_row, delete_row

/**
 * A single command in the timeline history
 */
export interface TimelineCommand {
  id: string
  commandType: TimelineCommandType
  label: string                      // Human-readable description
  params: TimelineParams             // Command-specific parameters for replay
  timestamp: Date
  isExpensive: boolean               // If true, triggers snapshot creation BEFORE this command
  auditEntryId?: string              // Link to audit log entry
  // Affected rows/cells (for highlighting)
  affectedRowIds?: string[]          // _cs_id values of affected rows
  affectedColumns?: string[]         // Column names affected
  // For manual edits
  cellChanges?: CellChange[]         // Individual cell changes
  // Metadata
  rowsAffected?: number
  hasRowDetails?: boolean
  // Column order preservation for undo/redo
  columnOrderBefore?: string[]       // Column order before this command
  columnOrderAfter?: string[]        // Column order after this command
}

/**
 * Cell-level change record for manual edits
 */
export interface CellChange {
  csId: string                       // _cs_id of the row
  columnName: string
  previousValue: unknown
  newValue: unknown
}

/**
 * Parameters for replaying different command types
 */
export type TimelineParams =
  | TransformParams
  | ManualEditParams
  | MergeParams
  | StandardizeParams
  | StackParams
  | JoinParams
  | ScrubParams
  | BatchEditParams
  | DataParams

export interface TransformParams {
  type: 'transform'
  transformationType: TransformationType
  column?: string
  params?: Record<string, unknown>
}

export interface ManualEditParams {
  type: 'manual_edit'
  csId: string
  columnName: string
  previousValue: unknown
  newValue: unknown
}

export interface MergeParams {
  type: 'merge'
  matchColumn: string
  mergedPairs: { keepRowId: string; deleteRowId: string }[]
}

export interface StandardizeParams {
  type: 'standardize'
  columnName: string
  mappings: StandardizationMapping[]
}

export interface StackParams {
  type: 'stack'
  sourceTableNames: string[]
}

export interface JoinParams {
  type: 'join'
  rightTableName: string
  keyColumn: string
  joinType: JoinType
}

export interface ScrubParams {
  type: 'scrub'
  rules: ObfuscationRule[]
  secret?: string
}

export interface BatchEditParams {
  type: 'batch_edit'
  changes: CellChange[]
}

export interface DataParams {
  type: 'data'
  dataOperation: 'insert_row' | 'delete_row'
  insertAfterCsId?: string | null  // for insert_row
  newCsId?: string                  // for insert_row (captured after execution)
  csIds?: string[]                  // for delete_row
}

/**
 * Snapshot info for LRU undo cache (Phase 3)
 * - parquetId: Cold storage reference (e.g., "parquet:snapshot_abc_1")
 * - hotTableName: In-memory table name for instant undo (only for most recent snapshot)
 */
export interface SnapshotInfo {
  parquetId: string           // e.g., "parquet:snapshot_abc_1" or in-memory table name
  hotTableName?: string       // e.g., "_hot_abc_1" (only for most recent snapshot)
}

/**
 * Timeline for a single table
 */
export interface TableTimeline {
  id: string
  tableId: string
  tableName: string
  commands: TimelineCommand[]
  currentPosition: number            // Index in commands (-1 = original state)
  snapshots: Map<number, SnapshotInfo> // Step index → snapshot info with hot/cold status
  originalSnapshotName: string       // Original state snapshot table name
  createdAt: Date
  updatedAt: Date
}

/**
 * Serialized snapshot info for persistence
 * Note: hotTableName is NOT persisted since hot snapshots are lost on refresh
 */
export interface SerializedSnapshotInfo {
  parquetId: string
  // hotTableName is intentionally omitted - hot snapshots don't survive page refresh
}

/**
 * Serialized timeline for persistence
 */
export interface SerializedTableTimeline {
  id: string
  tableId: string
  tableName: string
  commands: SerializedTimelineCommand[]
  currentPosition: number
  snapshots: [number, SerializedSnapshotInfo][]  // Array of [index, SnapshotInfo] pairs
  originalSnapshotName: string
  createdAt: string
  updatedAt: string
}

export interface SerializedTimelineCommand {
  id: string
  commandType: TimelineCommandType
  label: string
  params: TimelineParams
  timestamp: string                  // ISO string
  isExpensive: boolean
  auditEntryId?: string
  affectedRowIds?: string[]
  affectedColumns?: string[]
  cellChanges?: CellChange[]
  rowsAffected?: number
  hasRowDetails?: boolean
  // Column order preservation for undo/redo
  columnOrderBefore?: string[]
  columnOrderAfter?: string[]
}

/**
 * Highlight state for drill-down view
 */
export interface TimelineHighlight {
  commandId: string | null
  rowIds: Set<string>                // _cs_id values to highlight
  cellKeys: Set<string>              // "csId:columnName" keys for cell highlights
  highlightedColumns: Set<string>    // Column names to highlight entirely
  ghostRows: Record<string, unknown>[] // Deleted rows to show as "ghosts"
  diffMode: 'cell' | 'row' | 'full' | 'column'
}
