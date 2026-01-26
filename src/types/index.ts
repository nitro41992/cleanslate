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

export type BlockingStrategy = 'first_letter' | 'double_metaphone' | 'ngram' | 'none'

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

export type PersistenceStatus = 'idle' | 'saving' | 'saved' | 'error'

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

/**
 * Timeline for a single table
 */
export interface TableTimeline {
  id: string
  tableId: string
  tableName: string
  commands: TimelineCommand[]
  currentPosition: number            // Index in commands (-1 = original state)
  snapshots: Map<number, string>     // Step index → snapshot table name
  originalSnapshotName: string       // Original state snapshot table name
  createdAt: Date
  updatedAt: Date
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
  snapshots: [number, string][]      // Array of [index, tableName] pairs
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
