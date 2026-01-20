export interface TableInfo {
  id: string
  name: string
  columns: ColumnInfo[]
  rowCount: number
  createdAt: Date
  updatedAt: Date
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
}

export interface AuditLogEntry {
  id: string
  timestamp: Date
  tableId: string
  tableName: string
  action: string
  details: string
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

export interface MatchPair {
  id: string
  rowA: Record<string, unknown>
  rowB: Record<string, unknown>
  score: number
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
