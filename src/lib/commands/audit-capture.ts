/**
 * Audit Row Capture Utility
 *
 * Shared logic for capturing row-level audit details.
 * Used by both legacy transformations.ts and new CommandExecutor.
 *
 * Design Principles:
 * - Dependency injection: Database connection passed as argument (no global imports)
 * - Pure functions: No closures, all inputs passed explicitly
 * - Tier-agnostic: Handles both Tier 1 (versioned columns) and Tier 2/3 transforms
 */

/**
 * Database connection interface (matches CommandContext.db)
 * Supports dependency injection for testability
 */
export interface DbConnection {
  query: <T>(sql: string) => Promise<T[]>
  execute: (sql: string) => Promise<void>
}

// Max rows for which we capture row-level details (performance threshold)
// 10k reduces WASM heap expansion during audit capture by 80%
// Export modal already limits to 10k rows, so no functional loss
export const ROW_DETAIL_THRESHOLD = 10_000

/**
 * Ensure _audit_details table exists
 */
export async function ensureAuditDetailsTable(db: DbConnection): Promise<void> {
  await db.execute(`
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
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_audit_entry ON _audit_details(audit_entry_id)
  `)
}

export interface Tier23CaptureParams {
  tableName: string
  column: string
  transformationType: string
  auditEntryId: string
  params?: Record<string, unknown>
}

/**
 * Capture row-level audit details for Tier 2/3 commands.
 * Each transform type has its own capture logic based on how it modifies data.
 *
 * @returns true if any row details were captured
 */
export async function captureTier23RowDetails(
  db: DbConnection,
  params: Tier23CaptureParams
): Promise<boolean> {
  await ensureAuditDetailsTable(db)

  const { tableName, column, transformationType, auditEntryId, params: transformParams } = params

  // Dispatch to specific capture function based on transform type
  switch (transformationType) {
    case 'standardize_date':
      return await captureStandardizeDateDetails(db, tableName, column, auditEntryId, transformParams)

    case 'calculate_age':
      return await captureCalculateAgeDetails(db, tableName, column, auditEntryId, transformParams)

    case 'fill_down':
      return await captureFillDownDetails(db, tableName, column, auditEntryId)

    case 'cast_type':
      return await captureCastTypeDetails(db, tableName, column, auditEntryId, transformParams)

    case 'split_column':
      return await captureSplitColumnDetails(db, tableName, column, auditEntryId, transformParams)

    case 'combine_columns':
      return await captureCombineColumnsDetails(db, tableName, auditEntryId, transformParams)

    case 'unformat_currency':
      return await captureUnformatCurrencyDetails(db, tableName, column, auditEntryId)

    case 'fix_negatives':
      return await captureFixNegativesDetails(db, tableName, column, auditEntryId)

    case 'pad_zeros':
      return await capturePadZerosDetails(db, tableName, column, auditEntryId, transformParams)

    case 'filter_empty':
      // filter_empty removes rows, so we capture deleted rows
      return await captureFilterEmptyDetails(db, tableName, column, auditEntryId)

    case 'replace':
      return await captureReplaceDetails(db, tableName, column, auditEntryId, transformParams)

    default:
      console.warn(`[AUDIT] No row capture implementation for Tier 2/3 transform: ${transformationType}`)
      return false
  }
}

/**
 * Capture details for standardize_date transformation.
 * Uses COALESCE pattern to try multiple date formats.
 */
async function captureStandardizeDateDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const format = (params?.format as string) || 'YYYY-MM-DD'
  const formatMap: Record<string, string> = {
    'YYYY-MM-DD': '%Y-%m-%d',
    'MM/DD/YYYY': '%m/%d/%Y',
    'DD/MM/YYYY': '%d/%m/%Y',
  }
  const strftimeFormat = formatMap[format] || '%Y-%m-%d'
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  const whereClause = `${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS VARCHAR)) != ''`

  // Use same COALESCE pattern as actual transformation to handle all date formats
  const newValueExpression = `strftime(
    COALESCE(
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y-%m-%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y%m%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%m/%d/%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%d/%m/%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y/%m/%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%d-%m-%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%m-%d-%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y.%m.%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%d.%m.%Y'),
      TRY_CAST(${quotedCol} AS DATE)
    ),
    '${strftimeFormat}'
  )`

  // Use CTE to compute both values and filter out no-change rows
  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    WITH computed AS (
      SELECT
        rowid as rid,
        CAST(${quotedCol} AS VARCHAR) AS prev_val,
        ${newValueExpression} AS new_val
      FROM "${tableName}"
      WHERE ${whereClause}
    )
    SELECT
      uuid(),
      '${auditEntryId}',
      rid,
      '${escapedColumn}',
      prev_val,
      new_val,
      CURRENT_TIMESTAMP
    FROM computed
    WHERE prev_val IS DISTINCT FROM new_val
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for calculate_age transformation.
 * Creates age column from DOB, uses same date parsing as standardize_date.
 *
 * NOTE: Calculate Age CREATES a new column (like Combine Columns), so:
 * - column_name = the NEW column name (e.g., 'age')
 * - previous_value = '<new column>' (column didn't exist before)
 * - new_value = the calculated age
 */
async function captureCalculateAgeDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  // Use new column name with robust fallback (matches backend default)
  const newColName = (params?.newColumnName as string) || 'age'
  const escapedNewCol = newColName.replace(/'/g, "''")
  const quotedCol = `"${column}"`

  const whereClause = `${quotedCol} IS NOT NULL`

  // Use same COALESCE pattern for date parsing
  const newValueExpression = `CAST(DATE_DIFF('year',
    COALESCE(
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y-%m-%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y%m%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%m/%d/%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%d/%m/%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y/%m/%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%d-%m-%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%m-%d-%Y'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%Y.%m.%d'),
      TRY_STRPTIME(CAST(${quotedCol} AS VARCHAR), '%d.%m.%Y'),
      TRY_CAST(${quotedCol} AS DATE)
    ),
    CURRENT_DATE
  ) AS VARCHAR)`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedNewCol}',
      '<new column>',
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for fill_down transformation.
 * Shows rows that were null/empty and will get filled with value from above.
 */
async function captureFillDownDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string
): Promise<boolean> {
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  const whereClause = `${quotedCol} IS NULL OR TRIM(CAST(${quotedCol} AS VARCHAR)) = ''`
  const newValueExpression = `LAST_VALUE(NULLIF(TRIM(CAST(${quotedCol} AS VARCHAR)), '') IGNORE NULLS) OVER (
    ORDER BY rowid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  )`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedCol} AS VARCHAR),
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for cast_type transformation.
 */
async function captureCastTypeDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const targetType = (params?.targetType as string) || 'VARCHAR'
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  const whereClause = `${quotedCol} IS NOT NULL`
  const newValueExpression = `CAST(TRY_CAST(${quotedCol} AS ${targetType}) AS VARCHAR)`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedCol} AS VARCHAR),
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for split_column transformation.
 */
async function captureSplitColumnDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const splitMode = (params?.splitMode as string) || 'delimiter'
  const escapedColumn = column.replace(/'/g, "''")

  // Previous value: the original column value
  const prevExpr = `CAST("${column}" AS VARCHAR)`

  // New value: shows actual split result for better audit fidelity
  let newExpr: string
  if (splitMode === 'delimiter') {
    let delimiter = (params?.delimiter as string) || ' '
    if (delimiter.trim().length > 0) {
      delimiter = delimiter.trim()
    }
    const escapedDelim = delimiter.replace(/'/g, "''")
    newExpr = `'Split by "' || '${escapedDelim}' || '": ' || CAST(string_split(CAST("${column}" AS VARCHAR), '${escapedDelim}') AS VARCHAR)`
  } else if (splitMode === 'position') {
    const pos = Number(params?.position) || 3
    newExpr = `'Split at ${pos}: "' || substring(CAST("${column}" AS VARCHAR), 1, ${pos}) || '", "' || substring(CAST("${column}" AS VARCHAR), ${pos + 1}) || '"'`
  } else {
    const len = Number(params?.length) || 2
    newExpr = `'Split every ${len} chars'`
  }

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      ${prevExpr},
      ${newExpr},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE "${column}" IS NOT NULL AND TRIM(CAST("${column}" AS VARCHAR)) != ''
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for combine_columns transformation.
 */
async function captureCombineColumnsDetails(
  db: DbConnection,
  tableName: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const columnList = ((params?.columns as string) || '').split(',').map(c => c.trim()).filter(Boolean)
  let delimiter = (params?.delimiter as string) ?? ' '
  if (delimiter.trim().length > 0) {
    delimiter = delimiter.trim()
  }
  const newColName = (params?.newColumnName as string) || 'combined'
  const ignoreEmpty = (params?.ignoreEmpty as string) !== 'false'
  const escapedDelim = delimiter.replace(/'/g, "''")
  const escapedNewCol = newColName.replace(/'/g, "''")

  if (columnList.length < 2) return false

  // Previous value: show source columns joined with ' + ' for readability
  const prevExpr = columnList.map(c => `COALESCE(TRIM(CAST("${c}" AS VARCHAR)), '<empty>')`).join(` || ' + ' || `)

  // New value: the combined result
  let combineNewExpr: string
  if (ignoreEmpty) {
    const colRefs = columnList.map(c => `NULLIF(TRIM(CAST("${c}" AS VARCHAR)), '')`).join(', ')
    combineNewExpr = `CONCAT_WS('${escapedDelim}', ${colRefs})`
  } else {
    const colRefs = columnList.map(c => `COALESCE(TRIM(CAST("${c}" AS VARCHAR)), '')`).join(`, '${escapedDelim}', `)
    combineNewExpr = `CONCAT(${colRefs})`
  }

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT uuid(), '${auditEntryId}', rowid, '${escapedNewCol}', ${prevExpr}, ${combineNewExpr}, CURRENT_TIMESTAMP
    FROM "${tableName}"
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for unformat_currency transformation.
 */
async function captureUnformatCurrencyDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string
): Promise<boolean> {
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  const whereClause = `${quotedCol} IS NOT NULL AND (${quotedCol} LIKE '%$%' OR ${quotedCol} LIKE '%,%')`
  const newValueExpression = `CAST(TRY_CAST(REPLACE(REPLACE(REPLACE(${quotedCol}, '$', ''), ',', ''), ' ', '') AS DOUBLE) AS VARCHAR)`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedCol} AS VARCHAR),
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for fix_negatives transformation.
 */
async function captureFixNegativesDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string
): Promise<boolean> {
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  const whereClause = `${quotedCol} IS NOT NULL AND ${quotedCol} LIKE '%(%' AND ${quotedCol} LIKE '%)'`
  const newValueExpression = `CAST(
    CASE WHEN ${quotedCol} LIKE '%(%' AND ${quotedCol} LIKE '%)'
    THEN -TRY_CAST(REPLACE(REPLACE(REPLACE(REPLACE(${quotedCol}, '(', ''), ')', ''), '$', ''), ',', '') AS DOUBLE)
    ELSE TRY_CAST(REPLACE(REPLACE(${quotedCol}, '$', ''), ',', '') AS DOUBLE)
    END AS VARCHAR)`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedCol} AS VARCHAR),
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for pad_zeros transformation.
 */
async function capturePadZerosDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const padLength = Number(params?.length) || 5
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  const whereClause = `${quotedCol} IS NOT NULL AND LENGTH(CAST(${quotedCol} AS VARCHAR)) < ${padLength}`
  const newValueExpression = `LPAD(CAST(${quotedCol} AS VARCHAR), ${padLength}, '0')`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedCol} AS VARCHAR),
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for filter_empty transformation.
 * Shows deleted rows with <deleted> indicator.
 */
async function captureFilterEmptyDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string
): Promise<boolean> {
  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")

  // filter_empty removes rows where column is null/empty
  // We capture these as "before = value, after = <deleted>"
  const whereClause = `${quotedCol} IS NULL OR TRIM(CAST(${quotedCol} AS VARCHAR)) = ''`

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      COALESCE(CAST(${quotedCol} AS VARCHAR), '<null>'),
      '<deleted>',
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Capture details for find & replace transformation.
 * Shows rows where the find pattern was matched and replaced.
 */
async function captureReplaceDetails(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const find = (params?.find as string) || ''
  const replace = (params?.replace as string) ?? ''
  const caseSensitive = params?.caseSensitive !== false && params?.caseSensitive !== 'false'
  const matchType = (params?.matchType as string) || 'contains'

  if (!find) return false

  const quotedCol = `"${column}"`
  const escapedColumn = column.replace(/'/g, "''")
  const escapedFind = find.replace(/'/g, "''")
  const escapedReplace = replace.replace(/'/g, "''")

  // Build WHERE clause based on match type and case sensitivity
  let whereClause: string
  let newValueExpression: string

  if (matchType === 'exact') {
    if (caseSensitive) {
      whereClause = `${quotedCol} = '${escapedFind}'`
      newValueExpression = `'${escapedReplace}'`
    } else {
      whereClause = `LOWER(${quotedCol}) = LOWER('${escapedFind}')`
      newValueExpression = `'${escapedReplace}'`
    }
  } else {
    // contains
    if (caseSensitive) {
      whereClause = `${quotedCol} LIKE '%${escapedFind}%'`
      newValueExpression = `REPLACE(${quotedCol}, '${escapedFind}', '${escapedReplace}')`
    } else {
      whereClause = `LOWER(${quotedCol}) LIKE LOWER('%${escapedFind}%')`
      // For case-insensitive, use REGEXP_REPLACE with character class pattern
      // Build pattern that matches each letter case-insensitively
      let pattern = escapedFind.replace(/[[\]\\^$.|?*+(){}]/g, '\\$&') // Escape regex chars
      pattern = pattern.replace(/[a-z]/gi, (letter) => {
        const lower = letter.toLowerCase()
        const upper = letter.toUpperCase()
        return lower !== upper ? `[${lower}${upper}]` : letter
      })
      newValueExpression = `REGEXP_REPLACE(${quotedCol}, '${pattern}', '${escapedReplace}', 'g')`
    }
  }

  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedCol} AS VARCHAR),
      CAST(${newValueExpression} AS VARCHAR),
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${quotedCol} IS NOT NULL AND (${whereClause})
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `

  await db.execute(insertSql)
  return await checkRowDetailsInserted(db, auditEntryId)
}

/**
 * Helper to check if any row details were inserted for an audit entry.
 */
async function checkRowDetailsInserted(db: DbConnection, auditEntryId: string): Promise<boolean> {
  const countResult = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM _audit_details WHERE audit_entry_id = '${auditEntryId}'`
  )
  return Number(countResult[0].count) > 0
}
