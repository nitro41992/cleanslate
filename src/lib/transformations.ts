import { execute, query } from '@/lib/duckdb'
import type { TransformationStep, TransformationType } from '@/types'

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
]

export async function applyTransformation(
  tableName: string,
  step: TransformationStep
): Promise<{ rowCount: number; affected: number }> {
  const tempTable = `${tableName}_temp_${Date.now()}`

  let sql: string

  // Get count before
  const beforeResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const countBefore = Number(beforeResult[0].count)

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

    case 'remove_duplicates':
      sql = `
        CREATE OR REPLACE TABLE "${tempTable}" AS
        SELECT DISTINCT * FROM "${tableName}"
      `
      await execute(sql)
      await execute(`DROP TABLE "${tableName}"`)
      await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
      break

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
            REGEXP_REPLACE("${step.column}", '(?i)${regexEscaped}', '${escapedReplace}', 'g')
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

    default:
      throw new Error(`Unknown transformation: ${step.type}`)
  }

  // Get count after
  const afterResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const countAfter = Number(afterResult[0].count)

  return {
    rowCount: countAfter,
    affected: Math.abs(countBefore - countAfter),
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
