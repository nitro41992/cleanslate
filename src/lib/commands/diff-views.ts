/**
 * Diff View Manager
 *
 * Creates and manages diff views (v_diff_step_X) for command highlighting.
 *
 * Standardized View Schema (every diff view must include):
 * - _row_id: VARCHAR - Stable row identifier (from _cs_id)
 * - _change_type: VARCHAR - 'added' | 'removed' | 'modified' | 'unchanged'
 * - _affected_column: VARCHAR - Which column was modified (for cell highlighting)
 * - All data columns from the source table
 */

import { quoteTable, quoteColumn } from './utils/sql'
import type { CommandContext, HighlightInfo } from './types'
import { CS_ID_COLUMN } from '@/lib/duckdb'

/**
 * Diff view configuration
 */
export interface DiffViewConfig {
  tableName: string
  tableId: string
  stepIndex: number
  rowPredicate: string | null
  affectedColumn: string | null
  changeType: 'modified' | 'added' | 'removed' | 'unchanged'
}

/**
 * Get the diff view name for a specific step
 */
export function getDiffViewName(tableId: string, stepIndex: number): string {
  return `v_diff_step_${tableId}_${stepIndex}`
}

/**
 * Create a diff view for Tier 1 (modifications) commands
 *
 * For Tier 1 operations that modify existing rows, we create a simple
 * CASE WHEN view that identifies affected rows using the predicate.
 */
export async function createTier1DiffView(
  ctx: CommandContext,
  config: DiffViewConfig
): Promise<string> {
  const viewName = getDiffViewName(config.tableId, config.stepIndex)
  const tableName = quoteTable(config.tableName)
  const csId = quoteColumn(CS_ID_COLUMN)

  // Build the change type expression
  let changeTypeExpr: string
  if (config.rowPredicate && config.rowPredicate !== 'TRUE') {
    changeTypeExpr = `CASE WHEN ${config.rowPredicate} THEN 'modified' ELSE 'unchanged' END`
  } else if (config.rowPredicate === 'TRUE') {
    // All rows affected
    changeTypeExpr = `'modified'`
  } else {
    // No predicate - column-level change only
    changeTypeExpr = `'unchanged'`
  }

  // Build the affected column expression
  const affectedColExpr = config.affectedColumn
    ? `'${config.affectedColumn.replace(/'/g, "''")}'`
    : 'NULL'

  const sql = `
    CREATE OR REPLACE VIEW "${viewName}" AS
    SELECT
      ${csId} as _row_id,
      ${changeTypeExpr} as _change_type,
      ${affectedColExpr} as _affected_column,
      *
    FROM ${tableName}
  `

  await ctx.db.execute(sql)
  return viewName
}

/**
 * Create a diff view for Tier 3 (deletion) commands
 *
 * For Tier 3 operations that delete rows (like remove_duplicates),
 * we need to LEFT JOIN the snapshot to show deleted rows.
 */
export async function createTier3DiffView(
  ctx: CommandContext,
  config: DiffViewConfig & { snapshotTable: string }
): Promise<string> {
  const viewName = getDiffViewName(config.tableId, config.stepIndex)
  const currentTable = quoteTable(config.tableName)
  const snapshotTable = quoteTable(config.snapshotTable)
  const csId = quoteColumn(CS_ID_COLUMN)

  // Get columns (excluding internal ones)
  const columns = ctx.table.columns.filter((c) => c.name !== CS_ID_COLUMN)
  const columnList = columns
    .map((c) => {
      const qc = quoteColumn(c.name)
      return `COALESCE(c.${qc}, s.${qc}) as ${qc}`
    })
    .join(',\n      ')

  const sql = `
    CREATE OR REPLACE VIEW "${viewName}" AS
    SELECT
      COALESCE(c.${csId}, s.${csId}) as _row_id,
      CASE
        WHEN c.${csId} IS NULL THEN 'removed'
        WHEN s.${csId} IS NULL THEN 'added'
        ELSE 'unchanged'
      END as _change_type,
      NULL as _affected_column,
      ${columnList}
    FROM ${snapshotTable} s
    LEFT JOIN ${currentTable} c ON s.${csId} = c.${csId}
  `

  await ctx.db.execute(sql)
  return viewName
}

/**
 * Drop a diff view
 */
export async function dropDiffView(
  ctx: CommandContext,
  tableId: string,
  stepIndex: number
): Promise<void> {
  const viewName = getDiffViewName(tableId, stepIndex)
  await ctx.db.execute(`DROP VIEW IF EXISTS "${viewName}"`)
}

/**
 * Drop all diff views for a table
 */
export async function dropAllDiffViews(
  ctx: CommandContext,
  tableId: string,
  maxStepIndex: number
): Promise<void> {
  for (let i = 0; i <= maxStepIndex; i++) {
    await dropDiffView(ctx, tableId, i)
  }
}

/**
 * Query a diff view with pagination (for virtualized grid)
 */
export async function queryDiffView(
  ctx: CommandContext,
  tableId: string,
  stepIndex: number,
  offset: number,
  limit: number
): Promise<{
  rows: Array<Record<string, unknown> & {
    _row_id: string
    _change_type: string
    _affected_column: string | null
  }>
  total: number
}> {
  const viewName = getDiffViewName(tableId, stepIndex)

  // Check if view exists
  const exists = await ctx.db.tableExists(viewName)
  if (!exists) {
    return { rows: [], total: 0 }
  }

  // Get total count
  const countResult = await ctx.db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${viewName}"`
  )
  const total = Number(countResult[0]?.count ?? 0)

  // Get paginated rows
  const rows = await ctx.db.query<
    Record<string, unknown> & {
      _row_id: string
      _change_type: string
      _affected_column: string | null
    }
  >(`SELECT * FROM "${viewName}" LIMIT ${limit} OFFSET ${offset}`)

  return { rows, total }
}

/**
 * Get highlight info from a diff view
 */
export async function getHighlightInfoFromDiffView(
  ctx: CommandContext,
  tableId: string,
  stepIndex: number
): Promise<HighlightInfo | null> {
  const viewName = getDiffViewName(tableId, stepIndex)

  // Check if view exists
  const exists = await ctx.db.tableExists(viewName)
  if (!exists) {
    return null
  }

  // Get distinct affected columns
  const colResult = await ctx.db.query<{ col: string | null }>(
    `SELECT DISTINCT _affected_column as col FROM "${viewName}" WHERE _affected_column IS NOT NULL`
  )
  const columns = colResult.map((r) => r.col).filter((c): c is string => c !== null)

  // Get count of modified rows to determine mode
  const modifiedResult = await ctx.db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${viewName}" WHERE _change_type != 'unchanged'`
  )
  const modifiedCount = Number(modifiedResult[0]?.count ?? 0)

  // Determine mode based on what changed
  let mode: HighlightInfo['mode'] = 'column'
  if (modifiedCount > 0) {
    mode = columns.length === 1 ? 'cell' : 'row'
  }

  // Build row predicate from _change_type
  const rowPredicate = modifiedCount > 0 ? `_change_type = 'modified'` : null

  return {
    rowPredicate,
    columns,
    mode,
  }
}

/**
 * Inject highlight predicate into a SELECT query for virtualized grids
 *
 * This adds a _highlight column to the query that indicates whether
 * each row is affected by the current command.
 */
export function injectHighlightPredicate(
  selectSql: string,
  rowPredicate: string | null
): string {
  if (!rowPredicate) {
    // No predicate - add a constant 0 highlight column
    return selectSql.replace(
      /SELECT\s+/i,
      'SELECT 0 as _highlight, '
    )
  }

  // Inject CASE WHEN expression for highlight
  const highlightExpr = `CASE WHEN ${rowPredicate} THEN 1 ELSE 0 END as _highlight`
  return selectSql.replace(
    /SELECT\s+/i,
    `SELECT ${highlightExpr}, `
  )
}
