/**
 * Transform Preview Utility
 *
 * Generates preview data for transformations before they are applied.
 * Shows users how their data will transform with the selected parameters.
 */

import { query, getTableColumns } from '@/lib/duckdb'
import type { TransformationType } from '@/types'
import { buildDateParseExpression, buildAgeExpression, type AgePrecision } from '@/lib/commands/utils/date'
import { transpileFormula } from '@/lib/formula'

export interface PreviewRow {
  original: string | null
  result: string | null
}

export interface SplitPreviewRow {
  original: string | null
  parts: (string | null)[]
}

export interface CombinePreviewRow {
  /** Values from each source column */
  sourceValues: (string | null)[]
  /** Combined result */
  result: string | null
}

export interface PreviewResult {
  rows: PreviewRow[]
  totalMatching: number
  error?: string
  /** Number of rows where the formula result is NULL (e.g., division by zero) */
  nullCount?: number
  /** For split_column: shows parts in structured format */
  splitRows?: SplitPreviewRow[]
  /** Column name being split (for header display) */
  splitColumn?: string
  /** For combine_columns: shows source values and result */
  combineRows?: CombinePreviewRow[]
  /** Column names being combined (for header display) */
  combineColumns?: string[]
}

/**
 * Transformations that support live preview
 */
export const PREVIEW_SUPPORTED_TRANSFORMS: TransformationType[] = [
  'replace',
  'split_column',
  'combine_columns',
  'cast_type',
  'pad_zeros',
  'standardize_date',
  'calculate_age',
  'trim',
  'lowercase',
  'uppercase',
  'title_case',
  'sentence_case',
  'remove_accents',
  'collapse_spaces',
  'replace_empty',
  'excel_formula',
]

/**
 * Quote a column name for DuckDB SQL
 */
function quoteCol(col: string): string {
  return `"${col.replace(/"/g, '""')}"`
}

/**
 * Quote a table name for DuckDB SQL
 */
function quoteTable(table: string): string {
  return `"${table.replace(/"/g, '""')}"`
}

/**
 * Escape a string value for SQL
 */
function escapeValue(val: string): string {
  return val.replace(/'/g, "''")
}

interface PreviewSQLResult {
  sql: string
  countSql: string
  /** SQL to count rows where the result is NULL (for silent failure warnings) */
  nullCountSql?: string
  /** True for split_column - uses structured parts instead of single result */
  isSplit?: boolean
  /** True for combine_columns - uses structured source values */
  isCombine?: boolean
  /** Column names being combined (for combine preview) */
  combineColumns?: string[]
}

/**
 * Generate preview SQL for a specific transformation
 */
async function generatePreviewSQL(
  tableName: string,
  column: string | undefined,
  transformType: TransformationType,
  params: Record<string, string>,
  limit: number
): Promise<PreviewSQLResult | null> {
  const table = quoteTable(tableName)

  switch (transformType) {
    case 'trim': {
      if (!column) return null
      const col = quoteCol(column)
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, TRIM(${col}) as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND ${col} != TRIM(${col})
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND ${col} != TRIM(${col})`,
      }
    }

    case 'lowercase': {
      if (!column) return null
      const col = quoteCol(column)
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, LOWER(${col}) as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND ${col} != LOWER(${col})
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND ${col} != LOWER(${col})`,
      }
    }

    case 'uppercase': {
      if (!column) return null
      const col = quoteCol(column)
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, UPPER(${col}) as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND ${col} != UPPER(${col})
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND ${col} != UPPER(${col})`,
      }
    }

    case 'title_case': {
      if (!column) return null
      const col = quoteCol(column)
      const titleExpr = `CASE
        WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN ${col}
        ELSE list_reduce(
          list_transform(
            string_split(lower(${col}), ' '),
            w -> concat(upper(substring(w, 1, 1)), substring(w, 2))
          ),
          (x, y) -> concat(x, ' ', y)
        )
      END`
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, ${titleExpr} as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND TRIM(${col}) != ''
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND TRIM(${col}) != ''`,
      }
    }

    case 'sentence_case': {
      if (!column) return null
      const col = quoteCol(column)
      const sentenceExpr = `CASE
        WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN ${col}
        ELSE concat(upper(substring(${col}, 1, 1)), lower(substring(${col}, 2)))
      END`
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, ${sentenceExpr} as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND TRIM(${col}) != ''
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND TRIM(${col}) != ''`,
      }
    }

    case 'remove_accents': {
      if (!column) return null
      const col = quoteCol(column)
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, strip_accents(${col}) as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND ${col} != strip_accents(${col})
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND ${col} != strip_accents(${col})`,
      }
    }

    case 'collapse_spaces': {
      if (!column) return null
      const col = quoteCol(column)
      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original,
                     regexp_replace(${col}, '[ \\t\\n\\r]+', ' ', 'g') as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND ${col} != regexp_replace(${col}, '[ \\t\\n\\r]+', ' ', 'g')
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND ${col} != regexp_replace(${col}, '[ \\t\\n\\r]+', ' ', 'g')`,
      }
    }

    case 'replace': {
      if (!column) return null
      const col = quoteCol(column)
      const find = params.find || ''
      const replaceWith = params.replace || ''
      const caseSensitive = params.caseSensitive ?? 'false'
      const matchType = params.matchType ?? 'contains'

      if (!find) return null

      const escapedFind = escapeValue(find)
      const escapedReplace = escapeValue(replaceWith)

      let resultExpr: string
      let whereClause: string

      if (matchType === 'exact') {
        if (caseSensitive === 'false') {
          resultExpr = `CASE WHEN LOWER(${col}) = LOWER('${escapedFind}') THEN '${escapedReplace}' ELSE ${col} END`
          whereClause = `LOWER(${col}) = LOWER('${escapedFind}')`
        } else {
          resultExpr = `CASE WHEN ${col} = '${escapedFind}' THEN '${escapedReplace}' ELSE ${col} END`
          whereClause = `${col} = '${escapedFind}'`
        }
      } else {
        // contains
        if (caseSensitive === 'false') {
          const regexEscaped = escapedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          resultExpr = `REGEXP_REPLACE(${col}, '${regexEscaped}', '${escapedReplace}', 'gi')`
          whereClause = `LOWER(${col}) LIKE LOWER('%${escapedFind}%')`
        } else {
          resultExpr = `REPLACE(${col}, '${escapedFind}', '${escapedReplace}')`
          whereClause = `${col} LIKE '%${escapedFind}%'`
        }
      }

      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, ${resultExpr} as result
              FROM ${table}
              WHERE ${whereClause}
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClause}`,
      }
    }

    case 'replace_empty': {
      if (!column) return null
      const col = quoteCol(column)
      const replaceWith = params.replaceWith || ''
      const escapedReplace = escapeValue(replaceWith)

      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original, '${escapedReplace}' as result
              FROM ${table}
              WHERE ${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = ''
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = ''`,
      }
    }

    case 'split_column': {
      if (!column) return null
      const col = quoteCol(column)
      const splitMode = params.splitMode || 'delimiter'

      if (splitMode === 'delimiter') {
        const delimiter = params.delimiter || ' '
        const escapedDelim = escapeValue(delimiter)

        // Return structured result showing each part separately
        return {
          sql: `SELECT CAST(${col} AS VARCHAR) as original,
                       COALESCE(string_split(CAST(${col} AS VARCHAR), '${escapedDelim}')[1], '') as part1,
                       COALESCE(string_split(CAST(${col} AS VARCHAR), '${escapedDelim}')[2], '') as part2,
                       COALESCE(string_split(CAST(${col} AS VARCHAR), '${escapedDelim}')[3], '') as part3
                FROM ${table}
                WHERE ${col} IS NOT NULL AND ${col} LIKE '%${escapedDelim}%'
                LIMIT ${limit}`,
          countSql: `SELECT COUNT(*) as count FROM ${table}
                     WHERE ${col} IS NOT NULL AND ${col} LIKE '%${escapedDelim}%'`,
          isSplit: true,
        }
      } else if (splitMode === 'position') {
        const position = Number(params.position) || 3
        return {
          sql: `SELECT CAST(${col} AS VARCHAR) as original,
                       substring(CAST(${col} AS VARCHAR), 1, ${position}) as part1,
                       substring(CAST(${col} AS VARCHAR), ${position + 1}) as part2,
                       '' as part3
                FROM ${table}
                WHERE ${col} IS NOT NULL
                LIMIT ${limit}`,
          countSql: `SELECT COUNT(*) as count FROM ${table} WHERE ${col} IS NOT NULL`,
          isSplit: true,
        }
      } else if (splitMode === 'length') {
        const charLength = Number(params.length) || 2
        return {
          sql: `SELECT CAST(${col} AS VARCHAR) as original,
                       substring(CAST(${col} AS VARCHAR), 1, ${charLength}) as part1,
                       substring(CAST(${col} AS VARCHAR), ${charLength + 1}, ${charLength}) as part2,
                       substring(CAST(${col} AS VARCHAR), ${charLength * 2 + 1}, ${charLength}) as part3
                FROM ${table}
                WHERE ${col} IS NOT NULL
                LIMIT ${limit}`,
          countSql: `SELECT COUNT(*) as count FROM ${table} WHERE ${col} IS NOT NULL`,
          isSplit: true,
        }
      }
      return null
    }

    case 'combine_columns': {
      const columnList = (params.columns || '').split(',').map((c) => c.trim()).filter(Boolean)
      if (columnList.length < 2) return null

      const delimiter = params.delimiter ?? ''
      const escapedDelim = escapeValue(delimiter)
      const ignoreEmpty = params.ignoreEmpty !== 'false'

      // Select each source column individually for structured preview
      const sourceSelects = columnList.map((c, i) =>
        `CAST(${quoteCol(c)} AS VARCHAR) as col${i}`
      ).join(', ')

      // Build result expression
      let resultExpr: string
      if (ignoreEmpty) {
        const colRefs = columnList.map((c) => `NULLIF(TRIM(CAST(${quoteCol(c)} AS VARCHAR)), '')`).join(', ')
        resultExpr = `CONCAT_WS('${escapedDelim}', ${colRefs})`
      } else {
        const colRefs = columnList.map((c) => `COALESCE(TRIM(CAST(${quoteCol(c)} AS VARCHAR)), '')`).join(`, '${escapedDelim}', `)
        resultExpr = `CONCAT(${colRefs})`
      }

      return {
        sql: `SELECT ${sourceSelects}, ${resultExpr} as result
              FROM ${table}
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}`,
        isCombine: true,
        combineColumns: columnList,
      }
    }

    case 'cast_type': {
      if (!column) return null
      const col = quoteCol(column)
      const targetType = params.targetType || 'VARCHAR'

      // For DATE/TIMESTAMP, use date parsing that tries multiple string formats
      // Unix timestamp detection is handled separately in the command
      let castExpr: string
      if (targetType === 'DATE' || targetType === 'TIMESTAMP') {
        const dateParseExpr = buildDateParseExpression(column)
        if (targetType === 'DATE') {
          castExpr = `TRY_CAST(${dateParseExpr} AS DATE)`
        } else {
          castExpr = dateParseExpr
        }
      } else {
        castExpr = `TRY_CAST(${col} AS ${targetType})`
      }

      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original,
                     CAST(${castExpr} AS VARCHAR) as result
              FROM ${table}
              WHERE ${col} IS NOT NULL
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table} WHERE ${col} IS NOT NULL`,
      }
    }

    case 'pad_zeros': {
      if (!column) return null
      const col = quoteCol(column)
      const targetLength = Number(params.length) || 5

      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original,
                     CASE
                       WHEN LENGTH(CAST(${col} AS VARCHAR)) < ${targetLength}
                       THEN LPAD(CAST(${col} AS VARCHAR), ${targetLength}, '0')
                       ELSE CAST(${col} AS VARCHAR)
                     END as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND LENGTH(CAST(${col} AS VARCHAR)) < ${targetLength}
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND LENGTH(CAST(${col} AS VARCHAR)) < ${targetLength}`,
      }
    }

    case 'standardize_date': {
      if (!column) return null
      const col = quoteCol(column)
      const format = params.format || 'YYYY-MM-DD'
      const formatMap: Record<string, string> = {
        'YYYY-MM-DD': '%Y-%m-%d',
        'MM/DD/YYYY': '%m/%d/%Y',
        'DD/MM/YYYY': '%d/%m/%Y',
      }
      const strftimeFormat = formatMap[format] || '%Y-%m-%d'

      const parseExpr = buildDateParseExpression(column)

      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original,
                     strftime(${parseExpr}, '${strftimeFormat}') as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) != ''
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) != ''`,
      }
    }

    case 'calculate_age': {
      if (!column) return null
      const col = quoteCol(column)
      const precision = (params.precision as AgePrecision) || 'years'
      const ageExpr = buildAgeExpression(column, precision)

      return {
        sql: `SELECT CAST(${col} AS VARCHAR) as original,
                     CAST(${ageExpr} AS VARCHAR) as result
              FROM ${table}
              WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) != ''
              LIMIT ${limit}`,
        countSql: `SELECT COUNT(*) as count FROM ${table}
                   WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) != ''`,
      }
    }

    case 'excel_formula': {
      const formula = params.formula || ''
      const outputMode = params.outputMode || 'new'
      const targetColumn = params.targetColumn || ''

      if (!formula.trim()) return null

      // Get available columns for transpilation
      let availableColumns: string[]
      try {
        const columns = await getTableColumns(tableName, true)
        availableColumns = columns.map((c) => c.name).filter((n) => n !== '_cs_id')
      } catch {
        return null
      }

      // Transpile formula to SQL
      const transpileResult = transpileFormula(formula, availableColumns)

      if (!transpileResult.success || !transpileResult.sql) {
        // Return null to signal preview not available (error shown in UI)
        return null
      }

      const sqlExpr = transpileResult.sql

      const nullCountSql = `SELECT COUNT(*) as count FROM ${table} WHERE (${sqlExpr}) IS NULL`

      if (outputMode === 'new') {
        // Preview: show formula result as new column
        return {
          sql: `SELECT 'Formula result' as original,
                       CAST((${sqlExpr}) AS VARCHAR) as result
                FROM ${table}
                LIMIT ${limit}`,
          countSql: `SELECT COUNT(*) as count FROM ${table}`,
          nullCountSql,
        }
      } else {
        // Preview: show before (target column) and after (formula result)
        const targetCol = quoteCol(targetColumn)
        return {
          sql: `SELECT CAST(${targetCol} AS VARCHAR) as original,
                       CAST((${sqlExpr}) AS VARCHAR) as result
                FROM ${table}
                WHERE ${targetCol} IS DISTINCT FROM (${sqlExpr})
                LIMIT ${limit}`,
          countSql: `SELECT COUNT(*) as count FROM ${table}
                     WHERE ${targetCol} IS DISTINCT FROM (${sqlExpr})`,
          nullCountSql,
        }
      }
    }

    default:
      return null
  }
}

/**
 * Generate preview data for a transformation
 *
 * @param tableName - The table to preview
 * @param column - The target column (optional for some transforms)
 * @param transformType - The transformation type
 * @param params - Transformation parameters
 * @param limit - Maximum number of sample rows (default: 10)
 * @returns Preview result with sample rows and total matching count
 */
export async function generatePreview(
  tableName: string,
  column: string | undefined,
  transformType: TransformationType,
  params: Record<string, string>,
  limit: number = 10
): Promise<PreviewResult> {
  try {
    const sqlResult = await generatePreviewSQL(tableName, column, transformType, params, limit)

    if (!sqlResult) {
      return { rows: [], totalMatching: 0 }
    }

    // Handle split_column specially - returns structured parts
    if ('isSplit' in sqlResult && sqlResult.isSplit) {
      const [rows, countResult] = await Promise.all([
        query<{ original: string | null; part1: string | null; part2: string | null; part3: string | null }>(sqlResult.sql),
        query<{ count: number }>(sqlResult.countSql),
      ])

      return {
        rows: [], // Empty for split - use splitRows instead
        totalMatching: Number(countResult[0]?.count ?? 0),
        splitRows: rows.map((r) => ({
          original: r.original,
          parts: [r.part1, r.part2, r.part3].filter((p) => p !== null && p !== ''),
        })),
        splitColumn: column,
      }
    }

    // Handle combine_columns specially - returns structured source values
    if ('isCombine' in sqlResult && sqlResult.isCombine && sqlResult.combineColumns) {
      const colCount = sqlResult.combineColumns.length
      const [rows, countResult] = await Promise.all([
        query<Record<string, string | null>>(sqlResult.sql),
        query<{ count: number }>(sqlResult.countSql),
      ])

      return {
        rows: [], // Empty for combine - use combineRows instead
        totalMatching: Number(countResult[0]?.count ?? 0),
        combineRows: rows.map((r) => ({
          sourceValues: Array.from({ length: colCount }, (_, i) => r[`col${i}`] ?? null),
          result: r.result ?? null,
        })),
        combineColumns: sqlResult.combineColumns,
      }
    }

    // Standard preview - run queries in parallel
    const queries: Promise<unknown[]>[] = [
      query<{ original: string | null; result: string | null }>(sqlResult.sql),
      query<{ count: number }>(sqlResult.countSql),
    ]
    if (sqlResult.nullCountSql) {
      queries.push(query<{ count: number }>(sqlResult.nullCountSql))
    }

    const results = await Promise.all(queries)
    const rows = results[0] as { original: string | null; result: string | null }[]
    const countResult = results[1] as { count: number }[]
    const nullCountResult = results[2] as { count: number }[] | undefined

    return {
      rows: rows.map((r) => ({
        original: r.original,
        result: r.result,
      })),
      totalMatching: Number(countResult[0]?.count ?? 0),
      nullCount: nullCountResult
        ? Number(nullCountResult[0]?.count ?? 0)
        : undefined,
    }
  } catch (error) {
    console.error('Preview generation failed:', error)
    const rawMessage = error instanceof Error ? error.message : 'Preview failed'
    return {
      rows: [],
      totalMatching: 0,
      error: humanizePreviewError(rawMessage),
    }
  }
}

/**
 * Humanize DuckDB error messages for user-friendly display
 */
export function humanizePreviewError(message: string): string {
  if (/Referenced column.*not found/i.test(message)) {
    const match = message.match(/Referenced column\s+"([^"]+)"/i)
    const colName = match?.[1] ?? 'unknown'
    return `Column "${colName}" not found. Check your @column references.`
  }
  if (/Conversion Error|Could not convert/i.test(message)) {
    return 'Type mismatch: formula result incompatible with column type.'
  }
  if (/division by zero/i.test(message)) {
    return 'Division by zero in some rows. Consider wrapping with IFERROR().'
  }
  if (/Binder Error/i.test(message)) {
    return 'Formula error. Check function names and column references.'
  }
  // Truncate long messages
  if (message.length > 120) {
    return message.slice(0, 117) + '...'
  }
  return message
}

/**
 * Check if preview requirements are met for a transformation
 */
export function isPreviewReady(
  transformType: TransformationType,
  column: string | undefined,
  params: Record<string, string>
): boolean {
  // Check if transform type supports preview
  if (!PREVIEW_SUPPORTED_TRANSFORMS.includes(transformType)) {
    return false
  }

  // Column-based transforms need a column
  const requiresColumn = ![
    'combine_columns',
    'excel_formula', // Uses @column syntax in formula
  ].includes(transformType)

  if (requiresColumn && !column) {
    return false
  }

  // Special checks for specific transforms
  switch (transformType) {
    case 'replace':
      return Boolean(params.find)
    case 'split_column': {
      const mode = params.splitMode || 'delimiter'
      if (mode === 'delimiter') return Boolean(params.delimiter)
      if (mode === 'position') return Boolean(params.position)
      if (mode === 'length') return Boolean(params.length)
      return true
    }
    case 'combine_columns': {
      const cols = (params.columns || '').split(',').filter((c) => c.trim())
      return cols.length >= 2
    }
    case 'cast_type':
      return Boolean(params.targetType)
    case 'pad_zeros':
      return Boolean(params.length)
    case 'standardize_date':
      return Boolean(params.format)
    case 'calculate_age':
      return true // Only needs column
    case 'excel_formula': {
      // Need formula and either outputColumn (new mode) or targetColumn (replace mode)
      const hasFormula = Boolean(params.formula?.trim())
      const outputMode = params.outputMode || 'new'
      if (outputMode === 'new') {
        return hasFormula && Boolean(params.outputColumn?.trim())
      } else {
        return hasFormula && Boolean(params.targetColumn?.trim())
      }
    }
    default:
      return true // Most transforms just need column
  }
}
