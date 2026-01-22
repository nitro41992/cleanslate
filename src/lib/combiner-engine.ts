import { query, execute, getTableColumns } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { JoinType, StackValidation, JoinValidation } from '@/types'

/**
 * Validate whether two tables can be stacked (UNION ALL)
 * Checks for column alignment and reports mismatches
 */
export async function validateStack(
  tableA: string,
  tableB: string
): Promise<StackValidation> {
  const colsA = await getTableColumns(tableA)
  const colsB = await getTableColumns(tableB)

  const namesA = new Set(colsA.map((c) => c.name))
  const namesB = new Set(colsB.map((c) => c.name))

  const missingInA = colsB.filter((c) => !namesA.has(c.name)).map((c) => c.name)
  const missingInB = colsA.filter((c) => !namesB.has(c.name)).map((c) => c.name)

  const warnings: string[] = []

  if (missingInA.length > 0) {
    warnings.push(`Columns missing in ${tableA}: ${missingInA.join(', ')}`)
  }
  if (missingInB.length > 0) {
    warnings.push(`Columns missing in ${tableB}: ${missingInB.join(', ')}`)
  }

  // Check for type mismatches on common columns
  const commonCols = colsA.filter((c) => namesB.has(c.name))
  for (const colA of commonCols) {
    const colB = colsB.find((c) => c.name === colA.name)
    if (colB && colA.type !== colB.type) {
      warnings.push(
        `Type mismatch for "${colA.name}": ${tableA} has ${colA.type}, ${tableB} has ${colB.type}`
      )
    }
  }

  return {
    isValid: true, // Stack is always possible with NULL padding
    missingInA,
    missingInB,
    warnings,
  }
}

/**
 * Stack two tables using UNION ALL
 * Missing columns are filled with NULL
 */
export async function stackTables(
  tableA: string,
  tableB: string,
  resultName: string
): Promise<{ rowCount: number }> {
  return withDuckDBLock(async () => {
    const colsA = await getTableColumns(tableA)
  const colsB = await getTableColumns(tableB)

  // Get all unique column names
  const allColNames = [
    ...new Set([...colsA.map((c) => c.name), ...colsB.map((c) => c.name)]),
  ]

  const namesA = new Set(colsA.map((c) => c.name))
  const namesB = new Set(colsB.map((c) => c.name))

  // Build SELECT for table A
  const selectA = allColNames
    .map((col) => (namesA.has(col) ? `"${col}"` : `NULL as "${col}"`))
    .join(', ')

  // Build SELECT for table B
  const selectB = allColNames
    .map((col) => (namesB.has(col) ? `"${col}"` : `NULL as "${col}"`))
    .join(', ')

  // Execute UNION ALL
  await execute(`
    CREATE OR REPLACE TABLE "${resultName}" AS
    SELECT ${selectA} FROM "${tableA}"
    UNION ALL
    SELECT ${selectB} FROM "${tableB}"
  `)

    // Get row count
    const countResult = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${resultName}"`
    )
    const rowCount = Number(countResult[0].count)

    return { rowCount }
  })
}

/**
 * Validate whether two tables can be joined on a key column
 * FR-E3: Check if keys need cleaning before joining
 */
export async function validateJoin(
  tableA: string,
  tableB: string,
  keyColumn: string
): Promise<JoinValidation> {
  const colsA = await getTableColumns(tableA)
  const colsB = await getTableColumns(tableB)

  const warnings: string[] = []

  // Check if key column exists in both tables
  const hasKeyA = colsA.some((c) => c.name === keyColumn)
  const hasKeyB = colsB.some((c) => c.name === keyColumn)

  if (!hasKeyA || !hasKeyB) {
    return {
      isValid: false,
      keyColumnMismatch: true,
      warnings: [
        `Key column "${keyColumn}" not found in ${!hasKeyA ? tableA : tableB}`,
      ],
    }
  }

  // Check for type mismatch
  const typeA = colsA.find((c) => c.name === keyColumn)?.type
  const typeB = colsB.find((c) => c.name === keyColumn)?.type
  if (typeA !== typeB) {
    warnings.push(
      `Type mismatch for key column: ${tableA}.${keyColumn} is ${typeA}, ${tableB}.${keyColumn} is ${typeB}`
    )
  }

  // FR-E3: Check if key columns have leading/trailing whitespace
  const wsCheckA = await query<{ has_whitespace: boolean }>(`
    SELECT COUNT(*) > 0 as has_whitespace
    FROM "${tableA}"
    WHERE "${keyColumn}" != TRIM("${keyColumn}")
  `)
  const wsCheckB = await query<{ has_whitespace: boolean }>(`
    SELECT COUNT(*) > 0 as has_whitespace
    FROM "${tableB}"
    WHERE "${keyColumn}" != TRIM("${keyColumn}")
  `)

  if (wsCheckA[0].has_whitespace || wsCheckB[0].has_whitespace) {
    warnings.push(
      'Key column has leading/trailing whitespace. Consider using "Auto-Clean Keys" before joining.'
    )
  }

  return {
    isValid: true,
    keyColumnMismatch: false,
    warnings,
  }
}

/**
 * Auto-clean key columns by trimming whitespace
 * FR-E3: Clean-first guardrail
 */
export async function autoCleanKeys(
  tableA: string,
  tableB: string,
  keyColumn: string
): Promise<{ cleanedA: number; cleanedB: number }> {
  // Count and trim in table A
  const countA = await query<{ count: number }>(`
    SELECT COUNT(*) as count FROM "${tableA}"
    WHERE "${keyColumn}" != TRIM("${keyColumn}")
  `)
  await execute(`
    UPDATE "${tableA}"
    SET "${keyColumn}" = TRIM("${keyColumn}")
  `)

  // Count and trim in table B
  const countB = await query<{ count: number }>(`
    SELECT COUNT(*) as count FROM "${tableB}"
    WHERE "${keyColumn}" != TRIM("${keyColumn}")
  `)
  await execute(`
    UPDATE "${tableB}"
    SET "${keyColumn}" = TRIM("${keyColumn}")
  `)

  return {
    cleanedA: Number(countA[0].count),
    cleanedB: Number(countB[0].count),
  }
}

/**
 * Join two tables on a key column
 */
export async function joinTables(
  leftTable: string,
  rightTable: string,
  keyColumn: string,
  joinType: JoinType,
  resultName: string
): Promise<{ rowCount: number }> {
  return withDuckDBLock(async () => {
    const colsL = await getTableColumns(leftTable)
  const colsR = await getTableColumns(rightTable)

  // Get non-key columns from right table (avoid duplicates)
  const leftColNames = new Set(colsL.map((c) => c.name))
  const rightOnlyCols = colsR.filter(
    (c) => c.name !== keyColumn && !leftColNames.has(c.name)
  )

  // Build SELECT clause
  const leftSelect = colsL.map((c) => `l."${c.name}"`).join(', ')
  const rightSelect = rightOnlyCols.map((c) => `r."${c.name}"`).join(', ')
  const selectClause =
    rightSelect.length > 0 ? `${leftSelect}, ${rightSelect}` : leftSelect

  // Map join type to SQL
  const joinTypeMap: Record<JoinType, string> = {
    left: 'LEFT JOIN',
    inner: 'INNER JOIN',
    full_outer: 'FULL OUTER JOIN',
  }
  const sqlJoinType = joinTypeMap[joinType]

  // Execute join
  await execute(`
    CREATE OR REPLACE TABLE "${resultName}" AS
    SELECT ${selectClause}
    FROM "${leftTable}" l
    ${sqlJoinType} "${rightTable}" r ON l."${keyColumn}" = r."${keyColumn}"
  `)

    // Get row count
    const countResult = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${resultName}"`
    )
    const rowCount = Number(countResult[0].count)

    return { rowCount }
  })
}
