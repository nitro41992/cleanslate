import { execute, query, CS_ID_COLUMN, getTableColumns } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { TransformationStep, TransformationType } from '@/types'
import { generateId } from '@/lib/utils'
import {
  ensureAuditDetailsTable,
  captureTier23RowDetails,
  ROW_DETAIL_THRESHOLD,
  type DbConnection,
} from '@/lib/commands/audit-capture'

// Adapter to use global DB functions with the new DbConnection interface
const globalDbConnection: DbConnection = {
  query: query,
  execute: execute,
}

// Re-export for backwards compatibility with existing imports
// Wrapped to use global DB connection
export async function ensureAuditDetailsTableCompat(): Promise<void> {
  return ensureAuditDetailsTable(globalDbConnection)
}

export interface TransformationResult {
  rowCount: number
  affected: number
  hasRowDetails: boolean
  auditEntryId?: string
  isCapped?: boolean  // true if affected > ROW_DETAIL_THRESHOLD
}

export interface RowDetail {
  rowIndex: number
  columnName: string
  previousValue: string | null
  newValue: string | null
}

export interface TransformationExample {
  before: string
  after: string
}

export interface TransformationDefinition {
  id: TransformationType
  label: string
  description: string
  icon: string
  requiresColumn: boolean
  params?: {
    name: string
    type: 'text' | 'number' | 'select'
    label: string
    options?: { value: string; label: string }[]
    default?: string
    required?: boolean
  }[]
  examples?: TransformationExample[]
  hints?: string[]
}

/**
 * Transforms that are expensive to replay (table recreation or full-table updates).
 * Snapshots are created AFTER these transforms for fast undo.
 *
 * Table Recreation (CREATE TABLE AS SELECT):
 * - calculate_age, standardize_date, cast_type, unformat_currency, fill_down, split_column
 *
 * Full-table Updates (UPDATE all rows):
 * - fix_negatives, pad_zeros
 *
 * Full-table Scans/Deduplication:
 * - remove_duplicates
 */
export const EXPENSIVE_TRANSFORMS = new Set([
  'remove_duplicates',
  'calculate_age',
  'standardize_date',
  'cast_type',
  'unformat_currency',
  'fix_negatives',
  'pad_zeros',
  'fill_down',
  'split_column',
  'combine_columns',
])

export const TRANSFORMATIONS: TransformationDefinition[] = [
  {
    id: 'trim',
    label: 'Trim Whitespace',
    description: 'Remove leading and trailing spaces',
    icon: '✂️',
    requiresColumn: true,
    examples: [
      { before: '"  hello  "', after: '"hello"' },
      { before: '"  data  "', after: '"data"' },
    ],
    hints: ['Does not affect spaces between words'],
  },
  {
    id: 'lowercase',
    label: 'Lowercase',
    description: 'Convert text to lowercase',
    icon: 'a',
    requiresColumn: true,
    examples: [
      { before: '"HELLO"', after: '"hello"' },
      { before: '"John DOE"', after: '"john doe"' },
    ],
    hints: ['Useful for case-insensitive matching'],
  },
  {
    id: 'uppercase',
    label: 'Uppercase',
    description: 'Convert text to UPPERCASE',
    icon: 'A',
    requiresColumn: true,
    examples: [
      { before: '"hello"', after: '"HELLO"' },
      { before: '"John Doe"', after: '"JOHN DOE"' },
    ],
    hints: ['Standard for codes like country/state'],
  },
  {
    id: 'remove_duplicates',
    label: 'Remove Duplicates',
    description: 'Remove duplicate rows',
    icon: '🔄',
    requiresColumn: false,
    examples: [
      { before: '100 rows', after: '95 rows' },
    ],
    hints: ['Compares all columns for uniqueness', 'Keeps first occurrence of each unique row'],
  },
  {
    id: 'replace_empty',
    label: 'Replace Empty',
    description: 'Replace empty/null values with a specified value',
    icon: '🔄',
    requiresColumn: true,
    params: [
      { name: 'replaceWith', type: 'text', label: 'Replace with', default: '' },
    ],
    examples: [
      { before: '""', after: '"N/A"' },
      { before: 'NULL', after: '"Unknown"' },
    ],
    hints: ['Also replaces NULL values', 'Useful for required field defaults'],
  },
  {
    id: 'replace',
    label: 'Find & Replace',
    description: 'Replace text values',
    icon: '🔍',
    requiresColumn: true,
    params: [
      { name: 'find', type: 'text', label: 'Find' },
      { name: 'replace', type: 'text', label: 'Replace with', required: false },
      {
        name: 'caseSensitive',
        type: 'select',
        label: 'Case Sensitive',
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ],
        default: 'false',
      },
      {
        name: 'matchType',
        type: 'select',
        label: 'Match Type',
        options: [
          { value: 'contains', label: 'Contains' },
          { value: 'exact', label: 'Exact Match' },
        ],
        default: 'contains',
      },
    ],
    examples: [
      { before: '"foo bar foo"', after: '"baz bar baz"' },
      { before: '"N/A"', after: '""' },
    ],
    hints: ['Case-insensitive option available', 'Exact Match replaces entire cell value'],
  },
  {
    id: 'rename_column',
    label: 'Rename Column',
    description: 'Change column name',
    icon: '📝',
    requiresColumn: true,
    params: [{ name: 'newName', type: 'text', label: 'New column name' }],
    examples: [
      { before: 'Column: "old_name"', after: 'Column: "new_name"' },
    ],
    hints: ['Does not affect data values', 'Use for clearer naming conventions'],
  },
  {
    id: 'cast_type',
    label: 'Cast Type',
    description: 'Convert column data type',
    icon: '🔢',
    requiresColumn: true,
    params: [
      {
        name: 'targetType',
        type: 'select',
        label: 'Target type',
        options: [
          { value: 'VARCHAR', label: 'Text' },
          { value: 'INTEGER', label: 'Integer' },
          { value: 'DOUBLE', label: 'Decimal' },
          { value: 'DATE', label: 'Date' },
          { value: 'TIMESTAMP', label: 'Datetime' },
          { value: 'BOOLEAN', label: 'Boolean' },
        ],
      },
    ],
    examples: [
      { before: '"123" (Text)', after: '123 (Integer)' },
      { before: '"2024-01-15"', after: '2024-01-15 (Date)' },
      { before: '1608422400000', after: '2020-12-20 00:00:00' },
    ],
    hints: ['Invalid values become NULL', 'Auto-detects Unix timestamps', 'Preview shows how many will fail'],
  },
  {
    id: 'custom_sql',
    label: 'Custom SQL',
    description: 'Run any DuckDB SQL command',
    icon: '💻',
    requiresColumn: false,
    params: [{ name: 'sql', type: 'text', label: 'SQL Query' }],
    examples: [
      { before: 'UPDATE "table" SET col = UPPER(col)', after: 'Uppercase all values' },
      { before: 'ALTER TABLE "table" DROP COLUMN temp', after: 'Remove a column' },
    ],
    hints: [
      'Column names must be double-quoted: "column_name"',
      "String values use single quotes: 'value'",
      'Use DuckDB SQL syntax (not MySQL/PostgreSQL)',
      'Click column badges below to copy names',
    ],
  },
  // FR-A3 Text Transformations
  {
    id: 'title_case',
    label: 'Title Case',
    description: 'Capitalize first letter of each word',
    icon: '🔤',
    requiresColumn: true,
    examples: [
      { before: '"john doe"', after: '"John Doe"' },
      { before: '"HELLO WORLD"', after: '"Hello World"' },
    ],
    hints: ['Capitalizes first letter of each word', 'Lowercases remaining letters'],
  },
  {
    id: 'remove_accents',
    label: 'Remove Accents',
    description: 'Remove diacritical marks (café → cafe)',
    icon: 'ê',
    requiresColumn: true,
    examples: [
      { before: '"café"', after: '"cafe"' },
      { before: '"naïve"', after: '"naive"' },
    ],
    hints: ['Normalizes international characters', 'Useful for matching/searching'],
  },
  {
    id: 'remove_non_printable',
    label: 'Remove Non-Printable',
    description: 'Remove tabs, newlines, control characters',
    icon: '🚫',
    requiresColumn: true,
    examples: [
      { before: '"hello\\t\\n"', after: '"hello"' },
      { before: '"data\\x00"', after: '"data"' },
    ],
    hints: ['Removes tabs, newlines, control chars', 'Cleans data from external systems'],
  },
  {
    id: 'collapse_spaces',
    label: 'Collapse Spaces',
    description: 'Replace multiple spaces with single space',
    icon: '⎵',
    requiresColumn: true,
    examples: [
      { before: '"hello    world"', after: '"hello world"' },
      { before: '"a   b   c"', after: '"a b c"' },
    ],
    hints: ['Also collapses tabs and newlines', 'Pair with Trim for complete cleanup'],
  },
  {
    id: 'sentence_case',
    label: 'Sentence Case',
    description: 'Capitalize first letter only',
    icon: 'Aa',
    requiresColumn: true,
    examples: [
      { before: '"HELLO WORLD"', after: '"Hello world"' },
      { before: '"john doe"', after: '"John doe"' },
    ],
    hints: ['Only first character capitalized', 'Rest of text is lowercased'],
  },
  // FR-A3 Finance Transformations
  {
    id: 'unformat_currency',
    label: 'Unformat Currency',
    description: 'Remove $ , and convert to number',
    icon: '💵',
    requiresColumn: true,
    examples: [
      { before: '"$1,234.56"', after: '1234.56' },
      { before: '"$ 999"', after: '999' },
    ],
    hints: ['Removes $, commas, and spaces', 'Converts to numeric type'],
  },
  {
    id: 'fix_negatives',
    label: 'Fix Negatives',
    description: 'Convert (500.00) to -500.00',
    icon: '−',
    requiresColumn: true,
    examples: [
      { before: '"(500.00)"', after: '-500' },
      { before: '"$(1,250.50)"', after: '-1250.5' },
    ],
    hints: ['Accounting format to standard', 'Also removes $ and commas'],
  },
  {
    id: 'pad_zeros',
    label: 'Pad Zeros',
    description: 'Left-pad numbers with zeros',
    icon: '0',
    requiresColumn: true,
    params: [
      { name: 'length', type: 'number', label: 'Target length', default: '5' },
    ],
    examples: [
      { before: '"42"', after: '"00042"' },
      { before: '"123"', after: '"00123"' },
    ],
    hints: ['Set target length (default: 5)', 'Good for IDs and codes', 'Longer values are not truncated'],
  },
  // FR-A3 Date/Structure Transformations
  {
    id: 'standardize_date',
    label: 'Standardize Date',
    description: 'Convert dates to a standard text format',
    icon: '📅',
    requiresColumn: true,
    params: [
      {
        name: 'format',
        type: 'select',
        label: 'Target format',
        options: [
          { value: 'YYYY-MM-DD', label: 'ISO (YYYY-MM-DD)' },
          { value: 'MM/DD/YYYY', label: 'US (MM/DD/YYYY)' },
          { value: 'DD/MM/YYYY', label: 'EU (DD/MM/YYYY)' },
        ],
        default: 'YYYY-MM-DD',
      },
    ],
    examples: [
      { before: '"01/15/2024"', after: '"2024-01-15"' },
      { before: '"20240115"', after: '"2024-01-15"' },
    ],
    hints: ['Supports 10+ input formats', 'Auto-detects YYYYMMDD, MM/DD/YYYY, etc.', 'Use Cast Type for native DATE/TIMESTAMP'],
  },
  {
    id: 'calculate_age',
    label: 'Calculate Age',
    description: 'Create age column from date of birth',
    icon: '🎂',
    requiresColumn: true,
    params: [
      {
        name: 'precision',
        type: 'select',
        label: 'Precision',
        options: [
          { value: 'years', label: 'Whole Years' },
          { value: 'decimal', label: 'Decimal' },
        ],
        default: 'years',
      },
    ],
    examples: [
      { before: '"1990-05-15"', after: 'age: 34' },
      { before: '"01/15/2000"', after: 'age: 24' },
    ],
    hints: ['Creates new "age" column', 'Supports multiple date formats', 'Decimal shows fractional years'],
  },
  {
    id: 'split_column',
    label: 'Split Column',
    description: 'Split by delimiter into multiple columns',
    icon: '✂️',
    requiresColumn: true,
    params: [
      {
        name: 'splitMode',
        type: 'select',
        label: 'Split Mode',
        options: [
          { value: 'delimiter', label: 'By Delimiter' },
          { value: 'position', label: 'At Position' },
          { value: 'length', label: 'Every N Characters' },
        ],
        default: 'delimiter',
      },
      { name: 'delimiter', type: 'text', label: 'Delimiter', default: '' },
      { name: 'position', type: 'number', label: 'Split Position', default: '3' },
      { name: 'length', type: 'number', label: 'Character Length', default: '2' },
    ],
    examples: [
      { before: '"John Doe"', after: '"John", "Doe"' },
      { before: '"a,b,c"', after: '"a", "b", "c"' },
    ],
    hints: ['Creates new columns for each part', 'Original column is preserved', 'Max 10 parts by delimiter'],
  },
  {
    id: 'combine_columns',
    label: 'Combine Columns',
    description: 'Merge multiple columns into one',
    icon: '🔗',
    requiresColumn: false,
    params: [
      { name: 'columns', type: 'text', label: 'Columns' },
      { name: 'delimiter', type: 'text', label: 'Separator', default: ' ' },
      { name: 'newColumnName', type: 'text', label: 'New column name', default: 'combined' },
      {
        name: 'ignoreEmpty',
        type: 'select',
        label: 'Ignore empty values',
        options: [
          { value: 'true', label: 'Yes (skip nulls)' },
          { value: 'false', label: 'No (include as empty)' },
        ],
        default: 'true',
      },
    ],
    examples: [
      { before: '"John" + "Doe"', after: '"John Doe"' },
      { before: '"A" + "B" + "C"', after: '"A-B-C"' },
    ],
    hints: ['Delimiter is customizable', 'Can skip empty/null values', 'Creates a new column'],
  },
  {
    id: 'fill_down',
    label: 'Fill Down',
    description: 'Fill empty cells with value from above',
    icon: '⬇️',
    requiresColumn: true,
    examples: [
      { before: 'NULL', after: '"value from above"' },
      { before: '""', after: '"previous value"' },
    ],
    hints: ['Copies value from row above if null', 'Useful for grouped/hierarchical data'],
  },
]

/**
 * Transformation groups for organized UI display
 */
export const TRANSFORMATION_GROUPS = [
  {
    id: 'text',
    label: 'Text Cleaning',
    icon: '✦',
    color: 'emerald' as const,
    transforms: [
      'trim', 'lowercase', 'uppercase', 'title_case', 'sentence_case',
      'remove_accents', 'remove_non_printable', 'collapse_spaces',
    ],
  },
  {
    id: 'replace',
    label: 'Find & Replace',
    icon: '⬡',
    color: 'blue' as const,
    transforms: ['replace', 'replace_empty'],
  },
  {
    id: 'structure',
    label: 'Structure',
    icon: '◫',
    color: 'violet' as const,
    transforms: [
      'rename_column', 'remove_duplicates', 'split_column',
      'combine_columns', 'cast_type',
    ],
  },
  {
    id: 'numeric',
    label: 'Numeric',
    icon: '▣',
    color: 'amber' as const,
    transforms: ['unformat_currency', 'fix_negatives', 'pad_zeros'],
  },
  {
    id: 'dates',
    label: 'Dates',
    icon: '◉',
    color: 'rose' as const,
    transforms: ['standardize_date', 'calculate_age', 'fill_down'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: '⌘',
    color: 'slate' as const,
    transforms: ['custom_sql'],
  },
] as const

export type TransformationGroupColor = typeof TRANSFORMATION_GROUPS[number]['color']

/**
 * Query count of rows that will be affected by a transformation BEFORE execution
 */
async function countAffectedRows(
  tableName: string,
  step: TransformationStep
): Promise<number> {
  const column = step.column ? `"${step.column}"` : null

  switch (step.type) {
    case 'trim': {
      if (!column) return 0
      const trimResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} != TRIM(${column})`
      )
      return Number(trimResult[0].count)
    }

    case 'lowercase': {
      if (!column) return 0
      const lowerResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} != LOWER(${column})`
      )
      return Number(lowerResult[0].count)
    }

    case 'uppercase': {
      if (!column) return 0
      const upperResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} != UPPER(${column})`
      )
      return Number(upperResult[0].count)
    }

    case 'replace': {
      if (!column) return 0
      const find = (step.params?.find as string) || ''
      const caseSensitive = (step.params?.caseSensitive as string) ?? 'true'
      const matchType = (step.params?.matchType as string) ?? 'contains'
      const escapedFind = find.replace(/'/g, "''")

      let whereClause: string
      if (matchType === 'exact') {
        if (caseSensitive === 'false') {
          whereClause = `LOWER(${column}) = LOWER('${escapedFind}')`
        } else {
          whereClause = `${column} = '${escapedFind}'`
        }
      } else {
        // contains
        if (caseSensitive === 'false') {
          whereClause = `LOWER(${column}) LIKE LOWER('%${escapedFind}%')`
        } else {
          whereClause = `${column} LIKE '%${escapedFind}%'`
        }
      }

      const replaceResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${whereClause}`
      )
      return Number(replaceResult[0].count)
    }

    case 'replace_empty': {
      if (!column) return 0
      const replaceEmptyResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NULL OR TRIM(CAST(${column} AS VARCHAR)) = ''`
      )
      return Number(replaceEmptyResult[0].count)
    }

    case 'rename_column':
      // Metadata-only change, no rows affected
      return 0

    case 'cast_type': {
      // All rows are affected by cast
      const castResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      return Number(castResult[0].count)
    }

    case 'remove_duplicates': {
      // Will be calculated after as row diff
      return -1 // Signal to use row count diff
    }

    case 'custom_sql':
      // Cannot predict affected rows for custom SQL
      return -1

    case 'title_case': {
      if (!column) return 0
      // Count rows where the value is not already in title case
      // We use a simplified check: if lower != upper (i.e., it has letters), it might need title case
      const titleResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND TRIM(${column}) != ''`
      )
      return Number(titleResult[0].count)
    }

    case 'remove_accents': {
      if (!column) return 0
      const accentResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} != strip_accents(${column})`
      )
      return Number(accentResult[0].count)
    }

    case 'remove_non_printable': {
      if (!column) return 0
      const nonPrintResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} != regexp_replace(${column}, '[\\x00-\\x1F\\x7F]', '', 'g')`
      )
      return Number(nonPrintResult[0].count)
    }

    case 'collapse_spaces': {
      if (!column) return 0
      const collapseResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} != regexp_replace(${column}, '[ \\t\\n\\r]+', ' ', 'g')`
      )
      return Number(collapseResult[0].count)
    }

    case 'sentence_case': {
      if (!column) return 0
      const sentenceResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND TRIM(${column}) != ''`
      )
      return Number(sentenceResult[0].count)
    }

    case 'combine_columns': {
      // All rows are affected when combining columns
      const combineResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      return Number(combineResult[0].count)
    }

    case 'unformat_currency': {
      if (!column) return 0
      const currencyResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND (${column} LIKE '%$%' OR ${column} LIKE '%,%')`
      )
      return Number(currencyResult[0].count)
    }

    case 'fix_negatives': {
      if (!column) return 0
      const negResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} LIKE '%(%' AND ${column} LIKE '%)'`
      )
      return Number(negResult[0].count)
    }

    case 'pad_zeros': {
      if (!column) return 0
      const targetLength = Number(step.params?.length) || 5
      const padResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND LENGTH(CAST(${column} AS VARCHAR)) < ${targetLength}`
      )
      return Number(padResult[0].count)
    }

    case 'standardize_date': {
      if (!column) return 0
      // Count all non-null dates (all will be reformatted)
      const dateResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND TRIM(CAST(${column} AS VARCHAR)) != ''`
      )
      return Number(dateResult[0].count)
    }

    case 'calculate_age': {
      // Creates new column, all rows affected
      const ageResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      return Number(ageResult[0].count)
    }

    case 'split_column': {
      if (!column) return 0
      const splitMode = (step.params?.splitMode as string) || 'delimiter'

      if (splitMode === 'delimiter') {
        // Apply same trimming logic as transformation execution
        // (handles case where delimiter field has default space that gets appended to user input)
        let delimiter = (step.params?.delimiter as string) || ' '
        if (delimiter.trim().length > 0) {
          delimiter = delimiter.trim()
        }
        const escapedDelim = delimiter.replace(/'/g, "''")
        const splitResult = await query<{ count: number }>(
          `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} LIKE '%${escapedDelim}%'`
        )
        return Number(splitResult[0].count)
      } else {
        // For position and length modes, all non-null rows are affected
        const splitResult = await query<{ count: number }>(
          `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL`
        )
        return Number(splitResult[0].count)
      }
    }

    case 'fill_down': {
      if (!column) return 0
      const fillResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NULL OR TRIM(CAST(${column} AS VARCHAR)) = ''`
      )
      return Number(fillResult[0].count)
    }

    default:
      return -1
  }
}

/**
 * Capture row-level details for a transformation.
 * Delegates to shared audit-capture.ts utility.
 *
 * @deprecated Use audit-capture.ts directly for new code
 */
async function captureRowDetails(
  tableName: string,
  step: TransformationStep,
  auditEntryId: string,
  affectedCount: number
): Promise<boolean> {
  // Skip if no rows affected
  if (affectedCount <= 0) {
    return false
  }

  // Structural transforms don't require a column
  const isStructuralTransform = step.type === 'combine_columns' || step.type === 'split_column'
  if (!step.column && !isStructuralTransform) {
    return false
  }

  // Delegate to shared utility for Tier 2/3 transforms
  return await captureTier23RowDetails(globalDbConnection, {
    tableName,
    column: step.column || '',
    transformationType: step.type,
    auditEntryId,
    params: step.params as Record<string, unknown>,
  })
}

/**
 * Capture row-level details for custom SQL using snapshot + diff
 * Uses bulk SQL insert instead of JS loops for performance
 */
async function captureCustomSqlDetails(
  tableName: string,
  beforeSnapshotName: string,
  auditEntryId: string
): Promise<{ hasRowDetails: boolean; affected: number; isCapped: boolean }> {
  const { runDiff, cleanupDiffTable } = await import('./diff-engine')
  const { CS_ID_COLUMN } = await import('./duckdb')

  // Run diff comparing current table to before snapshot
  let diffConfig
  try {
    diffConfig = await runDiff(tableName, beforeSnapshotName, [CS_ID_COLUMN])
  } catch (error) {
    // If diff fails (e.g., schema changed drastically), return no details
    console.warn('Custom SQL audit capture failed:', error)
    return { hasRowDetails: false, affected: 0, isCapped: false }
  }

  const { modified, added, removed } = diffConfig.summary
  const totalAffected = modified + added + removed

  // Skip if no changes
  if (totalAffected === 0) {
    await cleanupDiffTable(diffConfig.diffTableName)
    return { hasRowDetails: false, affected: 0, isCapped: false }
  }

  // Ensure audit details table exists
  await ensureAuditDetailsTable(globalDbConnection)

  // Get user columns (exclude _cs_id)
  const userCols = diffConfig.allColumns.filter(c => c !== CS_ID_COLUMN)

  // Chunk columns to avoid SQL parser limits (max ~20 per query)
  const chunkSize = 20
  const columnChunks: string[][] = []
  for (let i = 0; i < userCols.length; i += chunkSize) {
    columnChunks.push(userCols.slice(i, i + chunkSize))
  }

  // Track total inserted across chunks
  let totalInserted = 0

  // Bulk insert for each column chunk
  for (const chunkCols of columnChunks) {
    // Stop if we've already hit the cap
    if (totalInserted >= ROW_DETAIL_THRESHOLD) break

    const unionParts = chunkCols.map(col => {
      const safeCol = col.replace(/'/g, "''")
      // Select changed rows for this specific column
      return `
        SELECT
          uuid() as id,
          '${auditEntryId}' as audit_entry_id,
          row_number() OVER () as row_index,
          '${safeCol}' as column_name,
          CAST("b_${col}" AS VARCHAR) as previous_value,
          CAST("a_${col}" AS VARCHAR) as new_value,
          CURRENT_TIMESTAMP as created_at
        FROM "${diffConfig.diffTableName}"
        WHERE diff_status != 'unchanged'
          AND CAST("a_${col}" AS VARCHAR) IS DISTINCT FROM CAST("b_${col}" AS VARCHAR)
      `
    })

    const remainingCapacity = ROW_DETAIL_THRESHOLD - totalInserted
    const bulkSql = `
      INSERT INTO _audit_details
      (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
      ${unionParts.join(' UNION ALL ')}
      LIMIT ${remainingCapacity}
    `

    try {
      await execute(bulkSql)
    } catch (error) {
      console.warn('Custom SQL audit bulk insert failed for chunk:', error)
      // Continue with other chunks
    }

    // Update count
    const chunkCountResult = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM _audit_details WHERE audit_entry_id = '${auditEntryId}'`
    )
    totalInserted = Number(chunkCountResult[0].count)
  }

  // Cleanup diff table
  await cleanupDiffTable(diffConfig.diffTableName)

  return {
    hasRowDetails: totalInserted > 0,
    affected: totalAffected,
    isCapped: totalAffected > ROW_DETAIL_THRESHOLD,
  }
}

/**
 * Get row details for an audit entry
 */
export async function getAuditRowDetails(
  auditEntryId: string,
  limit: number = 500,
  offset: number = 0
): Promise<{ rows: RowDetail[]; total: number }> {
  // Ensure table exists before querying
  await ensureAuditDetailsTable(globalDbConnection)

  // Get total count
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM _audit_details WHERE audit_entry_id = '${auditEntryId}'`
  )
  const total = Number(countResult[0].count)

  // Get paginated rows
  const rows = await query<{ row_index: number; column_name: string; previous_value: string | null; new_value: string | null }>(
    `SELECT row_index, column_name, previous_value, new_value
     FROM _audit_details
     WHERE audit_entry_id = '${auditEntryId}'
     ORDER BY row_index
     LIMIT ${limit} OFFSET ${offset}`
  )

  return {
    rows: rows.map(r => ({
      rowIndex: r.row_index,
      columnName: r.column_name,
      previousValue: r.previous_value,
      newValue: r.new_value,
    })),
    total,
  }
}

export async function applyTransformation(
  tableName: string,
  step: TransformationStep
): Promise<TransformationResult> {
  return withDuckDBLock(async () => {
    const tempTable = `${tableName}_temp_${Date.now()}`
    const auditEntryId = generateId()

  let sql: string

  // NOTE: Original snapshot creation is now handled by initializeTimeline() in CleanPanel.tsx
  // Timeline system creates _timeline_original_${timelineId} snapshots which are used
  // by the diff system for "Compare with Preview" functionality

  // Get count before
  const beforeResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const countBefore = Number(beforeResult[0].count)

  // Count affected rows BEFORE transformation
  const preCountAffected = await countAffectedRows(tableName, step)

  // Capture row-level details (Cap, Don't Skip - always capture up to threshold)
  let hasRowDetails = false
  // Track custom SQL result separately (will be set by snapshot+diff)
  let customSqlResult: { hasRowDetails: boolean; affected: number; isCapped: boolean } | undefined
  if (preCountAffected > 0 && step.type !== 'custom_sql') {
    hasRowDetails = await captureRowDetails(tableName, step, auditEntryId, preCountAffected)
  }

  switch (step.type) {
    case 'trim':
      sql = `
        CREATE OR REPLACE TABLE "${tableName}" AS
        SELECT *, TRIM("${step.column}") as "${step.column}_trimmed"
        FROM "${tableName}"
      `
      // Actually update in place
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = TRIM("${step.column}")
      `
      await execute(sql)
      break

    case 'lowercase':
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = LOWER("${step.column}")
      `
      await execute(sql)
      break

    case 'uppercase':
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = UPPER("${step.column}")
      `
      await execute(sql)
      break

    case 'remove_duplicates': {
      // Get user columns (exclude internal _cs_id column to properly detect duplicates)
      const allCols = await getTableColumns(tableName, true)
      const userCols = allCols.filter(c => c.name !== CS_ID_COLUMN).map(c => `"${c.name}"`)

      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT gen_random_uuid() as "${CS_ID_COLUMN}", ${userCols.join(', ')}
        FROM (SELECT DISTINCT ${userCols.join(', ')} FROM "${tableName}")
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'replace_empty': {
      const replaceWith = (step.params?.replaceWith as string) ?? ''
      const escapedReplacement = replaceWith.replace(/'/g, "''")
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = '${escapedReplacement}'
        WHERE "${step.column}" IS NULL OR TRIM(CAST("${step.column}" AS VARCHAR)) = ''
      `
      await execute(sql)
      break
    }

    case 'replace': {
      const find = (step.params?.find as string) || ''
      const replaceWith = (step.params?.replace as string) || ''
      const caseSensitive = (step.params?.caseSensitive as string) ?? 'true'
      const matchType = (step.params?.matchType as string) ?? 'contains'

      const escapedFind = find.replace(/'/g, "''")
      const escapedReplace = replaceWith.replace(/'/g, "''")

      if (matchType === 'exact') {
        // Exact match: replace entire cell value only if it matches
        if (caseSensitive === 'false') {
          sql = `
            UPDATE "${tableName}" SET "${step.column}" =
            CASE WHEN LOWER("${step.column}") = LOWER('${escapedFind}')
            THEN '${escapedReplace}'
            ELSE "${step.column}" END
          `
        } else {
          sql = `
            UPDATE "${tableName}" SET "${step.column}" =
            CASE WHEN "${step.column}" = '${escapedFind}'
            THEN '${escapedReplace}'
            ELSE "${step.column}" END
          `
        }
      } else {
        // Contains: replace all occurrences of substring
        if (caseSensitive === 'false') {
          // Case-insensitive substring replacement using REGEXP_REPLACE
          // Escape special regex characters in the find string
          const regexEscaped = escapedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          sql = `
            UPDATE "${tableName}" SET "${step.column}" =
            REGEXP_REPLACE("${step.column}", '${regexEscaped}', '${escapedReplace}', 'gi')
          `
        } else {
          // Default: case-sensitive substring replacement
          sql = `
            UPDATE "${tableName}"
            SET "${step.column}" = REPLACE("${step.column}", '${escapedFind}', '${escapedReplace}')
          `
        }
      }
      await execute(sql)
      break
    }

    case 'rename_column': {
      const newName = (step.params?.newName as string) || step.column
      sql = `
        ALTER TABLE "${tableName}" RENAME COLUMN "${step.column}" TO "${newName}"
      `
      await execute(sql)
      break
    }

    case 'cast_type': {
      const targetType = (step.params?.targetType as string) || 'VARCHAR'
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               TRY_CAST("${step.column}" AS ${targetType}) as "${step.column}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'custom_sql': {
      const customSql = (step.params?.sql as string) || ''
      if (!customSql.trim()) break

      // Skip audit capture during replay (command pattern handles it during normal execution)
      const isReplay = step.id === 'replay'

      if (!isReplay) {
        // Create before-snapshot for diff tracking (only during normal execution)
        const beforeSnapshotName = `_custom_sql_before_${Date.now()}`
        const { duplicateTable, dropTable } = await import('./duckdb')
        await duplicateTable(tableName, beforeSnapshotName, true)

        try {
          // Execute the custom SQL
          await execute(customSql)

          // Capture changes using diff engine (bulk insert)
          customSqlResult = await captureCustomSqlDetails(
            tableName,
            beforeSnapshotName,
            auditEntryId
          )
          hasRowDetails = customSqlResult.hasRowDetails
        } finally {
          // Always cleanup snapshot - even if captureCustomSqlDetails throws
          try {
            await dropTable(beforeSnapshotName)
          } catch (cleanupError) {
            console.warn(`Failed to cleanup snapshot: ${beforeSnapshotName}`, cleanupError)
          }
        }
      } else {
        // During replay, just execute the SQL without audit capture
        await execute(customSql)
      }
      break
    }

    case 'title_case':
      // initcap is not available in DuckDB-WASM, use list_transform + list_reduce approach
      // Each word: capitalize first char + rest of string in lowercase
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = CASE
          WHEN "${step.column}" IS NULL OR TRIM("${step.column}") = '' THEN "${step.column}"
          ELSE list_reduce(
            list_transform(
              string_split(lower("${step.column}"), ' '),
              w -> concat(upper(substring(w, 1, 1)), substring(w, 2))
            ),
            (x, y) -> concat(x, ' ', y)
          )
        END
      `
      await execute(sql)
      break

    case 'remove_accents':
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = strip_accents("${step.column}")
      `
      await execute(sql)
      break

    case 'remove_non_printable':
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = regexp_replace("${step.column}", '[\\x00-\\x1F\\x7F]', '', 'g')
      `
      await execute(sql)
      break

    case 'collapse_spaces':
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = regexp_replace("${step.column}", '[ \\t\\n\\r]+', ' ', 'g')
      `
      await execute(sql)
      break

    case 'sentence_case':
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = CASE
          WHEN "${step.column}" IS NULL OR TRIM("${step.column}") = '' THEN "${step.column}"
          ELSE concat(upper(substring("${step.column}", 1, 1)), lower(substring("${step.column}", 2)))
        END
      `
      await execute(sql)
      break

    case 'unformat_currency':
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               TRY_CAST(REPLACE(REPLACE(REPLACE("${step.column}", '$', ''), ',', ''), ' ', '') AS DOUBLE) as "${step.column}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break

    case 'fix_negatives':
      // Handle patterns like (500), $(750.00), (1,250.50)
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               CASE
                 WHEN "${step.column}" LIKE '%(%' AND "${step.column}" LIKE '%)'
                 THEN -TRY_CAST(REPLACE(REPLACE(REPLACE(REPLACE("${step.column}", '(', ''), ')', ''), '$', ''), ',', '') AS DOUBLE)
                 ELSE TRY_CAST(REPLACE(REPLACE("${step.column}", '$', ''), ',', '') AS DOUBLE)
               END as "${step.column}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break

    case 'pad_zeros': {
      const padLength = Number(step.params?.length) || 5
      // Use CREATE OR REPLACE TABLE to ensure column type is VARCHAR (preserves leading zeros)
      // Use CASE WHEN to only pad strings shorter than target length (don't truncate longer strings)
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               CASE
                 WHEN LENGTH(CAST("${step.column}" AS VARCHAR)) < ${padLength}
                 THEN LPAD(CAST("${step.column}" AS VARCHAR), ${padLength}, '0')
                 ELSE CAST("${step.column}" AS VARCHAR)
               END as "${step.column}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'standardize_date': {
      const format = (step.params?.format as string) || 'YYYY-MM-DD'
      const formatMap: Record<string, string> = {
        'YYYY-MM-DD': '%Y-%m-%d',
        'MM/DD/YYYY': '%m/%d/%Y',
        'DD/MM/YYYY': '%d/%m/%Y',
      }
      const strftimeFormat = formatMap[format] || '%Y-%m-%d'

      // Try multiple date formats with COALESCE + TRY_STRPTIME
      // Includes common formats: ISO, US, EU, compact (YYYYMMDD), and various separators
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               strftime(
                 COALESCE(
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y-%m-%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y%m%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%m/%d/%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d/%m/%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y/%m/%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d-%m-%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%m-%d-%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y.%m.%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d.%m.%Y'),
                   TRY_CAST("${step.column}" AS DATE)
                 ),
                 '${strftimeFormat}'
               ) as "${step.column}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'calculate_age': {
      // Use same COALESCE pattern as captureRowDetails for consistent date parsing
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT *,
               DATE_DIFF('year',
                 COALESCE(
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y-%m-%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y%m%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%m/%d/%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d/%m/%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y/%m/%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d-%m-%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%m-%d-%Y'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y.%m.%d'),
                   TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d.%m.%Y'),
                   TRY_CAST("${step.column}" AS DATE)
                 ),
                 CURRENT_DATE
               ) as age
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'split_column': {
      const splitMode = (step.params?.splitMode as string) || 'delimiter'
      const baseColName = step.column!

      // Check for name collisions and determine prefix
      const existingCols = await getTableColumns(tableName, true)
      const colNames = existingCols.map(c => c.name)
      let prefix = baseColName
      if (colNames.some(c => c.startsWith(`${baseColName}_1`))) {
        prefix = `${baseColName}_split`
      }

      if (splitMode === 'position') {
        // Split at fixed position
        const position = Number(step.params?.position) || 3

        sql = `
          CREATE OR REPLACE TABLE "${tempTable}" AS
          SELECT *,
            substring(CAST("${baseColName}" AS VARCHAR), 1, ${position}) as "${prefix}_1",
            substring(CAST("${baseColName}" AS VARCHAR), ${position + 1}) as "${prefix}_2"
          FROM "${tableName}"
        `
      } else if (splitMode === 'length') {
        // Split every N characters
        const charLength = Number(step.params?.length) || 2

        // Calculate max parts needed
        const maxLen = await query<{ max_len: number }>(
          `SELECT MAX(LENGTH(CAST("${baseColName}" AS VARCHAR))) as max_len FROM "${tableName}"`
        )
        const maxLenResult = Number(maxLen[0]?.max_len) || 0
        const numParts = maxLenResult > 0
          ? Math.min(Math.ceil(maxLenResult / charLength), 50)  // Cap at 50 columns
          : 2

        const partColumns = Array.from({ length: numParts }, (_, i) =>
          `substring(CAST("${baseColName}" AS VARCHAR), ${i * charLength + 1}, ${charLength}) as "${prefix}_${i + 1}"`
        ).join(', ')

        sql = `
          CREATE OR REPLACE TABLE "${tempTable}" AS
          SELECT *, ${partColumns}
          FROM "${tableName}"
        `
      } else {
        // Default: delimiter mode
        // If delimiter contains non-whitespace chars, trim it (fixes " -" becoming the delimiter when user types "-")
        // But if it's only whitespace (e.g., just a space), keep it as-is for splitting by space
        let delimiter = (step.params?.delimiter as string) || ' '
        if (delimiter.trim().length > 0) {
          delimiter = delimiter.trim()
        }
        const escapedDelim = delimiter.replace(/'/g, "''")

        // Find max number of parts
        const maxParts = await query<{ max_parts: number }>(
          `SELECT MAX(len(string_split(CAST("${baseColName}" AS VARCHAR), '${escapedDelim}'))) as max_parts FROM "${tableName}"`
        )
        const numParts = Math.min(Number(maxParts[0].max_parts) || 2, 10)

        const partColumns = Array.from({ length: numParts }, (_, i) =>
          `string_split(CAST("${baseColName}" AS VARCHAR), '${escapedDelim}')[${i + 1}] as "${prefix}_${i + 1}"`
        ).join(', ')

        sql = `
          CREATE OR REPLACE TABLE "${tempTable}" AS
          SELECT *, ${partColumns}
          FROM "${tableName}"
        `
      }

      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'fill_down': {
      // Use window function to fill nulls/empty with last non-null value
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               COALESCE(
                 NULLIF(TRIM(CAST("${step.column}" AS VARCHAR)), ''),
                 LAST_VALUE(NULLIF(TRIM(CAST("${step.column}" AS VARCHAR)), '') IGNORE NULLS) OVER (
                   ORDER BY rowid
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                 )
               ) as "${step.column}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'combine_columns': {
      const columnList = (step.params?.columns as string || '').split(',').map(c => c.trim()).filter(Boolean)
      // If delimiter contains non-whitespace chars, trim it (fixes " |" issue when user types "|")
      // But if it's only whitespace (e.g., just a space), keep it as-is
      let delimiter = (step.params?.delimiter as string) ?? ' '
      if (delimiter.trim().length > 0) {
        delimiter = delimiter.trim()
      }
      const newColName = (step.params?.newColumnName as string) || 'combined'
      const ignoreEmpty = (step.params?.ignoreEmpty as string) !== 'false'
      const escapedDelim = delimiter.replace(/'/g, "''")

      if (columnList.length < 2) {
        throw new Error('Combine columns requires at least 2 columns')
      }

      // Build CONCAT_WS or COALESCE expression based on ignoreEmpty
      let concatExpr: string
      if (ignoreEmpty) {
        // Use CONCAT_WS which automatically skips NULLs
        const colRefs = columnList.map(c => `NULLIF(TRIM(CAST("${c}" AS VARCHAR)), '')`).join(', ')
        concatExpr = `CONCAT_WS('${escapedDelim}', ${colRefs})`
      } else {
        // Manual concat with COALESCE for empty string fallback
        // Add TRIM to match ignoreEmpty=true behavior (data hygiene)
        const colRefs = columnList.map(c => `COALESCE(TRIM(CAST("${c}" AS VARCHAR)), '')`).join(`, '${escapedDelim}', `)
        concatExpr = `CONCAT(${colRefs})`
      }

      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT *, ${concatExpr} as "${newColName}"
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    default:
      throw new Error(`Unknown transformation: ${step.type}`)
  }

  // Get count after
  const afterResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const countAfter = Number(afterResult[0].count)

  // Calculate affected rows:
  // - For custom_sql: use diff-based count from captureCustomSqlDetails
  // - If preCountAffected >= 0, use that (precise count)
  // - Otherwise fall back to row count diff (for remove_duplicates, etc.)
  let affected: number
  if (step.type === 'custom_sql' && customSqlResult !== undefined) {
    affected = customSqlResult.affected
  } else if (preCountAffected >= 0) {
    affected = preCountAffected
  } else {
    affected = Math.abs(countBefore - countAfter)
  }

  // Determine if audit was capped (for custom SQL we have precise flag, otherwise compare)
  const isCapped = customSqlResult?.isCapped ?? (affected > ROW_DETAIL_THRESHOLD)

    return {
      rowCount: countAfter,
      affected,
      hasRowDetails,
      auditEntryId: hasRowDetails ? auditEntryId : undefined,
      isCapped: hasRowDetails ? isCapped : undefined,
    }
  })
}

export function getTransformationLabel(step: TransformationStep): string {
  const def = TRANSFORMATIONS.find((t) => t.id === step.type)
  if (!def) return step.type

  let label = def.label
  if (step.column) {
    label += ` on "${step.column}"`
  }
  if (step.params) {
    const paramStr = Object.entries(step.params)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')
    if (paramStr) {
      label += ` (${paramStr})`
    }
  }
  return label
}

export interface CastTypeValidation {
  totalRows: number
  successCount: number
  failCount: number
  failurePercentage: number
  sampleFailures: string[]
}

/**
 * Validate a cast_type transformation before applying.
 * Returns statistics on how many values would become NULL after the cast.
 *
 * @param tableName - The table to validate
 * @param column - The column to cast
 * @param targetType - The target DuckDB type (e.g., 'INTEGER', 'DOUBLE', 'DATE')
 * @returns Validation result with counts and sample failures
 */
export async function validateCastType(
  tableName: string,
  column: string,
  targetType: string
): Promise<CastTypeValidation> {
  const quotedCol = `"${column}"`

  // Count total non-null rows and successful casts
  const result = await query<{
    total: number
    success_count: number
    fail_count: number
  }>(`
    SELECT
      COUNT(*) as total,
      COUNT(TRY_CAST(${quotedCol} AS ${targetType})) as success_count,
      COUNT(*) - COUNT(TRY_CAST(${quotedCol} AS ${targetType})) as fail_count
    FROM "${tableName}"
    WHERE ${quotedCol} IS NOT NULL
  `)

  const { total, success_count, fail_count } = result[0]

  // Get sample values that would fail the cast
  const samples = await query<{ val: string }>(`
    SELECT CAST(${quotedCol} AS VARCHAR) as val
    FROM "${tableName}"
    WHERE ${quotedCol} IS NOT NULL
      AND TRY_CAST(${quotedCol} AS ${targetType}) IS NULL
    LIMIT 5
  `)

  return {
    totalRows: Number(total),
    successCount: Number(success_count),
    failCount: Number(fail_count),
    failurePercentage: Number(total) > 0 ? (Number(fail_count) / Number(total)) * 100 : 0,
    sampleFailures: samples.map(s => s.val),
  }
}
