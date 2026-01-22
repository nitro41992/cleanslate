import { execute, query, CS_ID_COLUMN, getTableColumns } from '@/lib/duckdb'
import type { TransformationStep, TransformationType } from '@/types'
import { generateId } from '@/lib/utils'

// Max rows for which we capture row-level details (performance threshold)
const ROW_DETAIL_THRESHOLD = 10_000
// Batch size for inserting row details
const BATCH_SIZE = 500

export interface TransformationResult {
  rowCount: number
  affected: number
  hasRowDetails: boolean
  auditEntryId?: string
}

export interface RowDetail {
  rowIndex: number
  columnName: string
  previousValue: string | null
  newValue: string | null
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
  }[]
}

export const TRANSFORMATIONS: TransformationDefinition[] = [
  {
    id: 'trim',
    label: 'Trim Whitespace',
    description: 'Remove leading and trailing spaces',
    icon: '✂️',
    requiresColumn: true,
  },
  {
    id: 'lowercase',
    label: 'Lowercase',
    description: 'Convert text to lowercase',
    icon: 'a',
    requiresColumn: true,
  },
  {
    id: 'uppercase',
    label: 'Uppercase',
    description: 'Convert text to UPPERCASE',
    icon: 'A',
    requiresColumn: true,
  },
  {
    id: 'remove_duplicates',
    label: 'Remove Duplicates',
    description: 'Remove duplicate rows',
    icon: '🔄',
    requiresColumn: false,
  },
  {
    id: 'filter_empty',
    label: 'Filter Empty',
    description: 'Remove rows where column is empty',
    icon: '🚫',
    requiresColumn: true,
  },
  {
    id: 'replace',
    label: 'Find & Replace',
    description: 'Replace text values',
    icon: '🔍',
    requiresColumn: true,
    params: [
      { name: 'find', type: 'text', label: 'Find' },
      { name: 'replace', type: 'text', label: 'Replace with' },
      {
        name: 'caseSensitive',
        type: 'select',
        label: 'Case Sensitive',
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ],
        default: 'true',
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
  },
  {
    id: 'rename_column',
    label: 'Rename Column',
    description: 'Change column name',
    icon: '📝',
    requiresColumn: true,
    params: [{ name: 'newName', type: 'text', label: 'New column name' }],
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
          { value: 'BOOLEAN', label: 'Boolean' },
        ],
      },
    ],
  },
  {
    id: 'custom_sql',
    label: 'Custom SQL',
    description: 'Run custom SQL transformation',
    icon: '💻',
    requiresColumn: false,
    params: [{ name: 'sql', type: 'text', label: 'SQL Query' }],
  },
  // FR-A3 Text Transformations
  {
    id: 'title_case',
    label: 'Title Case',
    description: 'Capitalize first letter of each word',
    icon: '🔤',
    requiresColumn: true,
  },
  {
    id: 'remove_accents',
    label: 'Remove Accents',
    description: 'Remove diacritical marks (café → cafe)',
    icon: 'ê',
    requiresColumn: true,
  },
  {
    id: 'remove_non_printable',
    label: 'Remove Non-Printable',
    description: 'Remove tabs, newlines, control characters',
    icon: '🚫',
    requiresColumn: true,
  },
  // FR-A3 Finance Transformations
  {
    id: 'unformat_currency',
    label: 'Unformat Currency',
    description: 'Remove $ , and convert to number',
    icon: '💵',
    requiresColumn: true,
  },
  {
    id: 'fix_negatives',
    label: 'Fix Negatives',
    description: 'Convert (500.00) to -500.00',
    icon: '−',
    requiresColumn: true,
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
  },
  // FR-A3 Date/Structure Transformations
  {
    id: 'standardize_date',
    label: 'Standardize Date',
    description: 'Convert to ISO format (YYYY-MM-DD)',
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
  },
  {
    id: 'calculate_age',
    label: 'Calculate Age',
    description: 'Create age column from date of birth',
    icon: '🎂',
    requiresColumn: true,
  },
  {
    id: 'split_column',
    label: 'Split Column',
    description: 'Split by delimiter into multiple columns',
    icon: '✂️',
    requiresColumn: true,
    params: [
      { name: 'delimiter', type: 'text', label: 'Delimiter', default: ' ' },
    ],
  },
  {
    id: 'fill_down',
    label: 'Fill Down',
    description: 'Fill empty cells with value from above',
    icon: '⬇️',
    requiresColumn: true,
  },
]

/**
 * Ensure _audit_details table exists
 */
export async function ensureAuditDetailsTable(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS _audit_details (
      id VARCHAR PRIMARY KEY,
      audit_entry_id VARCHAR NOT NULL,
      row_index INTEGER NOT NULL,
      column_name VARCHAR NOT NULL,
      previous_value VARCHAR,
      new_value VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  // Create index if not exists
  await execute(`
    CREATE INDEX IF NOT EXISTS idx_audit_entry ON _audit_details(audit_entry_id)
  `)
}

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

    case 'filter_empty': {
      if (!column) return 0
      const filterResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NULL OR TRIM(${column}) = ''`
      )
      return Number(filterResult[0].count)
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
      const delimiter = (step.params?.delimiter as string) || ' '
      const escapedDelim = delimiter.replace(/'/g, "''")
      const splitResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NOT NULL AND ${column} LIKE '%${escapedDelim}%'`
      )
      return Number(splitResult[0].count)
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
 * Capture row-level details for a transformation
 * Returns the rows that will be changed with their before/after values
 */
async function captureRowDetails(
  tableName: string,
  step: TransformationStep,
  auditEntryId: string,
  affectedCount: number
): Promise<boolean> {
  // Skip if too many rows or no column involved
  if (affectedCount > ROW_DETAIL_THRESHOLD || affectedCount <= 0 || !step.column) {
    return false
  }

  const column = `"${step.column}"`

  // Build query to get affected rows with their rowid and current value
  let whereClause: string
  let newValueExpression: string

  switch (step.type) {
    case 'trim':
      whereClause = `${column} IS NOT NULL AND ${column} != TRIM(${column})`
      newValueExpression = `TRIM(${column})`
      break

    case 'lowercase':
      whereClause = `${column} IS NOT NULL AND ${column} != LOWER(${column})`
      newValueExpression = `LOWER(${column})`
      break

    case 'uppercase':
      whereClause = `${column} IS NOT NULL AND ${column} != UPPER(${column})`
      newValueExpression = `UPPER(${column})`
      break

    case 'replace': {
      const find = (step.params?.find as string) || ''
      const replaceWith = (step.params?.replace as string) || ''
      const caseSensitive = (step.params?.caseSensitive as string) ?? 'true'
      const matchType = (step.params?.matchType as string) ?? 'contains'
      const escapedFind = find.replace(/'/g, "''")
      const escapedReplace = replaceWith.replace(/'/g, "''")

      if (matchType === 'exact') {
        if (caseSensitive === 'false') {
          whereClause = `LOWER(${column}) = LOWER('${escapedFind}')`
          newValueExpression = `CASE WHEN LOWER(${column}) = LOWER('${escapedFind}') THEN '${escapedReplace}' ELSE ${column} END`
        } else {
          whereClause = `${column} = '${escapedFind}'`
          newValueExpression = `'${escapedReplace}'`
        }
      } else {
        // contains
        if (caseSensitive === 'false') {
          const regexEscaped = escapedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          whereClause = `LOWER(${column}) LIKE LOWER('%${escapedFind}%')`
          newValueExpression = `REGEXP_REPLACE(${column}, '${regexEscaped}', '${escapedReplace}', 'gi')`
        } else {
          whereClause = `${column} LIKE '%${escapedFind}%'`
          newValueExpression = `REPLACE(${column}, '${escapedFind}', '${escapedReplace}')`
        }
      }
      break
    }

    default:
      // Cannot capture details for other transformation types
      return false
  }

  // Ensure audit details table exists
  await ensureAuditDetailsTable()

  // Query affected rows with before/after values
  const rows = await query<{ row_index: number; prev_val: string | null; new_val: string | null }>(
    `SELECT rowid as row_index, ${column} as prev_val, ${newValueExpression} as new_val
     FROM "${tableName}"
     WHERE ${whereClause}
     LIMIT ${ROW_DETAIL_THRESHOLD}`
  )

  if (rows.length === 0) return false

  // Batch insert into _audit_details
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const values = batch.map((row) => {
      const id = generateId()
      const prevEscaped = row.prev_val !== null ? `'${String(row.prev_val).replace(/'/g, "''")}'` : 'NULL'
      const newEscaped = row.new_val !== null ? `'${String(row.new_val).replace(/'/g, "''")}'` : 'NULL'
      return `('${id}', '${auditEntryId}', ${row.row_index}, '${step.column}', ${prevEscaped}, ${newEscaped}, CURRENT_TIMESTAMP)`
    }).join(', ')

    await execute(`INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at) VALUES ${values}`)
  }

  return true
}

/**
 * Get row details for an audit entry
 */
export async function getAuditRowDetails(
  auditEntryId: string,
  limit: number = 500,
  offset: number = 0
): Promise<{ rows: RowDetail[]; total: number }> {
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

  // Capture row-level details if within threshold
  let hasRowDetails = false
  if (preCountAffected > 0 && preCountAffected <= ROW_DETAIL_THRESHOLD) {
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

    case 'filter_empty':
      sql = `
        DELETE FROM "${tableName}"
        WHERE "${step.column}" IS NULL OR TRIM("${step.column}") = ''
      `
      await execute(sql)
      break

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
      if (customSql.trim()) {
        await execute(customSql)
      }
      break
    }

    case 'title_case':
      // initcap is not available in DuckDB-WASM, use list_transform approach
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = array_to_string(
          list_transform(
            string_split(lower("${step.column}"), ' '),
            x -> upper(x[1]) || x[2:]
          ),
          ' '
        )
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
      sql = `
        UPDATE "${tableName}"
        SET "${step.column}" = LPAD(CAST("${step.column}" AS VARCHAR), ${padLength}, '0')
      `
      await execute(sql)
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

      // Try multiple input formats to parse the date, then output in target format
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT * EXCLUDE ("${step.column}"),
               strftime(
                 COALESCE(
                   TRY_CAST("${step.column}" AS DATE),
                   TRY_STRPTIME("${step.column}", '%m/%d/%Y'),
                   TRY_STRPTIME("${step.column}", '%d/%m/%Y'),
                   TRY_STRPTIME("${step.column}", '%Y-%m-%d'),
                   TRY_STRPTIME("${step.column}", '%Y/%m/%d')
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
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT *,
               DATE_DIFF('year', TRY_CAST("${step.column}" AS DATE), CURRENT_DATE) as age
        FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break
    }

    case 'split_column': {
      const delimiter = (step.params?.delimiter as string) || ' '
      const escapedDelim = delimiter.replace(/'/g, "''")
      const baseColName = step.column!

      // 1. Find max number of parts
      const maxParts = await query<{ max_parts: number }>(
        `SELECT MAX(len(string_split("${baseColName}", '${escapedDelim}'))) as max_parts
         FROM "${tableName}"`
      )
      const numParts = Math.min(Number(maxParts[0].max_parts) || 2, 10)

      // 2. Check for name collisions and determine prefix
      const existingCols = await getTableColumns(tableName, true)
      const colNames = existingCols.map(c => c.name)
      let prefix = baseColName
      if (colNames.some(c => c.startsWith(`${baseColName}_1`))) {
        prefix = `${baseColName}_split`
      }

      // 3. Build column expressions
      const partColumns = Array.from({ length: numParts }, (_, i) =>
        `string_split("${baseColName}", '${escapedDelim}')[${i + 1}] as "${prefix}_${i + 1}"`
      ).join(', ')

      // 4. Create new table with split columns
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT *, ${partColumns}
        FROM "${tableName}"
      `
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

    default:
      throw new Error(`Unknown transformation: ${step.type}`)
  }

  // Get count after
  const afterResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const countAfter = Number(afterResult[0].count)

  // Calculate affected rows:
  // - If preCountAffected >= 0, use that (precise count)
  // - Otherwise fall back to row count diff (for remove_duplicates, custom_sql, etc.)
  const affected = preCountAffected >= 0
    ? preCountAffected
    : Math.abs(countBefore - countAfter)

  return {
    rowCount: countAfter,
    affected,
    hasRowDetails,
    auditEntryId: hasRowDetails ? auditEntryId : undefined,
  }
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
