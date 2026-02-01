import type { ColumnInfo } from '@/types'

/**
 * Check if a column name is an internal column that should be excluded from user-facing columnOrder
 * Internal columns: _cs_id, columns ending with __base or __base_N (versioned backup columns)
 */
export function isInternalColumn(columnName: string): boolean {
  return columnName === '_cs_id' || /__base(_\d+)?$/.test(columnName)
}

/**
 * Reorder columns fetched from DuckDB to match the original user-defined order.
 * This is the main function used during context refresh to preserve column order.
 *
 * @param fetchedColumns - Columns fetched from DuckDB (potentially reordered)
 * @param originalOrder - User-defined column order from tableStore
 * @param renameMappings - Mapping of old column names to new names (for rename operations)
 * @param newColumns - New columns to append at end (for operations like split_column)
 * @returns Reordered columns preserving original order
 */
export function reorderColumns(
  fetchedColumns: ColumnInfo[],
  originalOrder: string[] | undefined,
  renameMappings?: Record<string, string>,
  newColumns?: string[]
): ColumnInfo[] {
  // If no original order, return fetched as-is (first load or legacy table)
  if (!originalOrder) {
    return fetchedColumns
  }

  // Apply rename mappings to original order
  const adjustedOrder = originalOrder.map(
    colName => renameMappings?.[colName] || colName
  )

  // Create a map of fetched columns for quick lookup
  const columnMap = new Map<string, ColumnInfo>()
  fetchedColumns.forEach(col => {
    columnMap.set(col.name, col)
  })

  // Build result: reorder existing columns, then append new columns, then phantom columns
  const result: ColumnInfo[] = []
  const usedColumns = new Set<string>()

  // 1. Preserve original order for existing columns
  for (const colName of adjustedOrder) {
    // Skip internal columns in original order (shouldn't happen, but defensive)
    if (isInternalColumn(colName)) {
      continue
    }

    const col = columnMap.get(colName)
    if (col) {
      result.push(col)
      usedColumns.add(colName)
    }
    // If column not in fetched, it was dropped - skip it
  }

  // 2. Append new columns (explicitly added by operations like split_column)
  if (newColumns) {
    for (const colName of newColumns) {
      if (isInternalColumn(colName)) {
        continue
      }

      const col = columnMap.get(colName)
      if (col && !usedColumns.has(colName)) {
        result.push(col)
        usedColumns.add(colName)
      }
    }
  }

  // 3. Safety valve: append phantom columns (unexpected columns not in originalOrder or newColumns)
  // This prevents data loss if DuckDB returns columns we didn't expect
  for (const col of fetchedColumns) {
    if (!isInternalColumn(col.name) && !usedColumns.has(col.name)) {
      if (import.meta.env.DEV) {
        console.warn(
          `[Column Ordering] Phantom column detected: "${col.name}" - appending at end`
        )
      }
      result.push(col)
    }
  }

  return result
}

/**
 * Calculate new columnOrder after a transformation operation.
 * This is called by the executor BEFORE refreshing context to prevent race conditions.
 *
 * @param currentOrder - Current column order from tableStore
 * @param newColumnNames - New columns added by this operation
 * @param droppedColumnNames - Columns removed by this operation
 * @param renameMappings - Mapping of old column names to new names
 * @param insertAfter - Column to insert new columns after (null = beginning, undefined = end)
 * @returns Updated column order
 */
export function updateColumnOrder(
  currentOrder: string[] | undefined,
  newColumnNames: string[],
  droppedColumnNames: string[],
  renameMappings?: Record<string, string>,
  insertAfter?: string | null
): string[] {
  // If no current order, initialize with new columns
  if (!currentOrder) {
    return newColumnNames.filter(name => !isInternalColumn(name))
  }

  // Start with current order
  let result = [...currentOrder]

  // 1. Apply renames
  if (renameMappings) {
    result = result.map(colName => renameMappings[colName] || colName)
  }

  // 2. Remove dropped columns
  if (droppedColumnNames.length > 0) {
    const droppedSet = new Set(droppedColumnNames)
    result = result.filter(colName => !droppedSet.has(colName))
  }

  // 3. Insert new columns at specified position
  const newUserColumns = newColumnNames.filter(name => !isInternalColumn(name))

  if (newUserColumns.length === 0) {
    return result
  }

  if (insertAfter === null) {
    // Insert at beginning
    result = [...newUserColumns, ...result]
  } else if (insertAfter !== undefined) {
    // Insert after specified column
    const insertIndex = result.indexOf(insertAfter)
    if (insertIndex !== -1) {
      result.splice(insertIndex + 1, 0, ...newUserColumns)
    } else {
      // Column not found, append at end (fallback)
      result.push(...newUserColumns)
    }
  } else {
    // undefined = append at end (default behavior)
    result.push(...newUserColumns)
  }

  return result
}
