import { readFileSync } from 'fs'
import { parse } from 'csv-parse/sync'
import { StoreInspector } from './store-inspector'

/**
 * Create table directly via SQL (bypasses UI wizard)
 *
 * Use for non-wizard-specific tests to reduce overhead.
 * Provides 10x speedup over UI-based uploadFile() + wizard import.
 *
 * @param inspector - StoreInspector for SQL execution
 * @param csvPath - Path to CSV fixture file
 * @param tableName - Name for the created table
 *
 * @example
 * ```typescript
 * await createTableFromCSV(
 *   inspector,
 *   getFixturePath('fr_e2_orders.csv'),
 *   'fr_e2_orders'
 * )
 * await inspector.waitForTableLoaded('fr_e2_orders', 6)
 * ```
 */
export async function createTableFromCSV(
  inspector: StoreInspector,
  csvPath: string,
  tableName: string
): Promise<void> {
  // Read CSV file
  const csvContent = readFileSync(csvPath, 'utf-8')
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  })

  if (records.length === 0) {
    throw new Error(`CSV file is empty: ${csvPath}`)
  }

  // Infer column types from first row (all TEXT for simplicity)
  const firstRow = records[0]
  const columns = Object.keys(firstRow)
  const columnDefs = columns.map((col) => `"${col}" TEXT`).join(', ')

  // Create table
  await inspector.runQuery(`DROP TABLE IF EXISTS "${tableName}"`)
  await inspector.runQuery(`CREATE TABLE "${tableName}" (${columnDefs})`)

  // Insert data in batches (DuckDB supports multi-row inserts)
  const batchSize = 100
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize)
    const values = batch
      .map((row) => {
        const vals = columns.map((col) => {
          const val = row[col]
          // SQL escape: NULL for empty values, single-quote escape for strings
          return val === null || val === undefined || val === ''
            ? 'NULL'
            : `'${String(val).replace(/'/g, "''")}'`
        })
        return `(${vals.join(', ')})`
      })
      .join(', ')

    await inspector.runQuery(`INSERT INTO "${tableName}" VALUES ${values}`)
  }
}
