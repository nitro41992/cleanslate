/**
 * Column Matcher for Recipe Execution
 *
 * Handles case-insensitive matching between recipe column names
 * and actual table column names, with fuzzy matching fallback.
 */

import type { ColumnMapping } from '@/stores/recipeStore'

export interface MatchResult {
  /** Columns that were successfully matched */
  mapping: ColumnMapping
  /** Columns that could not be auto-matched */
  unmapped: string[]
  /** Columns with exact matches */
  exactMatches: string[]
  /** Columns with case-insensitive matches */
  caseInsensitiveMatches: string[]
}

/**
 * Match recipe columns to table columns.
 * Uses a multi-pass strategy:
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Normalized match (underscores/spaces/hyphens treated as equivalent)
 *
 * @param recipeColumns - Column names expected by the recipe
 * @param tableColumns - Available column names in the target table
 * @returns Match result with mapping and unmapped columns
 */
export function matchColumns(
  recipeColumns: string[],
  tableColumns: string[]
): MatchResult {
  const mapping: ColumnMapping = {}
  const unmapped: string[] = []
  const exactMatches: string[] = []
  const caseInsensitiveMatches: string[] = []

  // Build lookup maps for table columns
  const exactMap = new Map<string, string>()
  const lowerMap = new Map<string, string>()
  const normalizedMap = new Map<string, string>()

  for (const col of tableColumns) {
    exactMap.set(col, col)
    lowerMap.set(col.toLowerCase(), col)
    normalizedMap.set(normalizeColumnName(col), col)
  }

  // Track which table columns have been used (prevent double-mapping)
  const usedTableColumns = new Set<string>()

  for (const recipeCol of recipeColumns) {
    let matched = false

    // Pass 1: Exact match
    if (exactMap.has(recipeCol) && !usedTableColumns.has(recipeCol)) {
      mapping[recipeCol] = recipeCol
      usedTableColumns.add(recipeCol)
      exactMatches.push(recipeCol)
      matched = true
    }

    // Pass 2: Case-insensitive match
    if (!matched) {
      const lowerKey = recipeCol.toLowerCase()
      const tableCol = lowerMap.get(lowerKey)
      if (tableCol && !usedTableColumns.has(tableCol)) {
        mapping[recipeCol] = tableCol
        usedTableColumns.add(tableCol)
        caseInsensitiveMatches.push(recipeCol)
        matched = true
      }
    }

    // Pass 3: Normalized match (underscores/spaces/hyphens equivalent)
    if (!matched) {
      const normalizedKey = normalizeColumnName(recipeCol)
      const tableCol = normalizedMap.get(normalizedKey)
      if (tableCol && !usedTableColumns.has(tableCol)) {
        mapping[recipeCol] = tableCol
        usedTableColumns.add(tableCol)
        caseInsensitiveMatches.push(recipeCol) // Count as case-insensitive for simplicity
        matched = true
      }
    }

    if (!matched) {
      unmapped.push(recipeCol)
    }
  }

  return {
    mapping,
    unmapped,
    exactMatches,
    caseInsensitiveMatches,
  }
}

/**
 * Normalize column name for fuzzy matching.
 * - Lowercase
 * - Replace spaces, hyphens, underscores with single underscore
 * - Remove consecutive underscores
 *
 * Examples:
 *   "First Name" -> "first_name"
 *   "first-name" -> "first_name"
 *   "FIRST_NAME" -> "first_name"
 */
function normalizeColumnName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Perform auto-matching and return a partial mapping.
 * Used when user wants to auto-fill the mapping dialog.
 *
 * @param recipeColumns - Column names expected by the recipe
 * @param tableColumns - Available column names in the target table
 * @returns Partial mapping with only matched columns
 */
export function performAutoMatch(
  recipeColumns: string[],
  tableColumns: string[]
): ColumnMapping {
  const result = matchColumns(recipeColumns, tableColumns)
  return result.mapping
}

/**
 * Check if all required columns can be matched.
 *
 * @param recipeColumns - Column names expected by the recipe
 * @param tableColumns - Available column names in the target table
 * @returns True if all columns can be matched
 */
export function canMatchAllColumns(
  recipeColumns: string[],
  tableColumns: string[]
): boolean {
  const result = matchColumns(recipeColumns, tableColumns)
  return result.unmapped.length === 0
}

/**
 * Apply column mapping to formula text.
 * Replaces @column and @[Column Name] references with mapped names.
 *
 * @param formula - The formula string
 * @param mapping - Column mapping
 * @returns Formula with mapped column names
 */
function applyMappingToFormula(formula: string, mapping: ColumnMapping): string {
  let result = formula

  // Replace @[Column Name] references (must be done first to avoid partial matches)
  result = result.replace(/@\[([^\]]+)\]/g, (_, colName: string) => {
    const mapped = mapping[colName] || colName
    // If mapped name has spaces, keep bracket syntax
    return mapped.includes(' ') ? `@[${mapped}]` : `@${mapped}`
  })

  // Replace @columnName references (simple names without spaces)
  result = result.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, colName: string) => {
    const mapped = mapping[colName]
    if (!mapped) return match
    // If mapped name has spaces, use bracket syntax
    return mapped.includes(' ') ? `@[${mapped}]` : `@${mapped}`
  })

  return result
}

/**
 * Apply column mapping to a recipe step's params.
 * Replaces column references with actual table column names.
 *
 * @param params - Original step params
 * @param mapping - Column mapping
 * @returns New params with mapped column names
 */
export function applyMappingToParams(
  params: Record<string, unknown>,
  mapping: ColumnMapping
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (key === 'column' && typeof value === 'string') {
      result[key] = mapping[value] || value
    } else if (key === 'targetColumn' && typeof value === 'string') {
      // For excel_formula replace mode
      result[key] = mapping[value] || value
    } else if (key === 'columns' && Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === 'string' ? mapping[v] || v : v))
    } else if (key === 'sourceColumns' && Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === 'string' ? mapping[v] || v : v))
    } else if (key === 'referencedColumns' && Array.isArray(value)) {
      // Map referencedColumns array for excel_formula
      result[key] = value.map((v) => (typeof v === 'string' ? mapping[v] || v : v))
    } else if (key === 'formula' && typeof value === 'string') {
      // Map column references within formula text
      result[key] = applyMappingToFormula(value, mapping)
    } else if (key === 'rules' && Array.isArray(value)) {
      // Map columns inside scrub:batch rules
      result[key] = value.map((rule) => {
        if (rule && typeof rule === 'object' && 'column' in rule && typeof rule.column === 'string') {
          return { ...rule, column: mapping[rule.column] || rule.column }
        }
        return rule
      })
    } else {
      result[key] = value
    }
  }

  return result
}
