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
}

export interface CSVIngestionSettings {
  headerRow?: number    // 1-based row number for headers
  encoding?: 'utf-8' | 'latin-1'
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
  | 'filter_empty'
  | 'replace'
  | 'split'
  | 'merge_columns'
  | 'rename_column'
  | 'cast_type'
  | 'custom_sql'

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
