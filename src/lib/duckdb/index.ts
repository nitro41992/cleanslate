import * as duckdb from '@duckdb/duckdb-wasm'
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdb_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdb_wasm,
    mainWorker: duckdb_worker,
  },
  eh: {
    mainModule: duckdb_wasm,
    mainWorker: duckdb_worker,
  },
}

export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (db) return db

  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES)
  const worker = new Worker(bundle.mainWorker!)
  const logger = new duckdb.ConsoleLogger()

  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule)

  console.log('DuckDB WASM initialized')
  return db
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!db) {
    await initDuckDB()
  }
  if (!conn) {
    conn = await db!.connect()
  }
  return conn
}

export async function query<T = Record<string, unknown>>(
  sql: string
): Promise<T[]> {
  const connection = await getConnection()
  const result = await connection.query(sql)
  return result.toArray().map((row) => row.toJSON() as T)
}

export async function queryArrow(sql: string) {
  const connection = await getConnection()
  return await connection.query(sql)
}

export async function execute(sql: string): Promise<void> {
  const connection = await getConnection()
  await connection.query(sql)
}

export async function loadCSV(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  const db = await initDuckDB()
  const connection = await getConnection()

  // Register the file with DuckDB
  await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)

  // Create table from CSV
  await connection.query(`
    CREATE OR REPLACE TABLE "${tableName}" AS
    SELECT * FROM read_csv_auto('${file.name}')
  `)

  // Get column info
  const columnsResult = await connection.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `)
  const columns = columnsResult.toArray().map((row) => row.toJSON().column_name as string)

  // Get row count
  const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
  const rowCount = Number(countResult.toArray()[0].toJSON().count)

  return { columns, rowCount }
}

export async function loadJSON(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  const db = await initDuckDB()
  const connection = await getConnection()

  await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)

  await connection.query(`
    CREATE OR REPLACE TABLE "${tableName}" AS
    SELECT * FROM read_json_auto('${file.name}')
  `)

  const columnsResult = await connection.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `)
  const columns = columnsResult.toArray().map((row) => row.toJSON().column_name as string)

  const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
  const rowCount = Number(countResult.toArray()[0].toJSON().count)

  return { columns, rowCount }
}

export async function loadParquet(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  const db = await initDuckDB()
  const connection = await getConnection()

  await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)

  await connection.query(`
    CREATE OR REPLACE TABLE "${tableName}" AS
    SELECT * FROM read_parquet('${file.name}')
  `)

  const columnsResult = await connection.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `)
  const columns = columnsResult.toArray().map((row) => row.toJSON().column_name as string)

  const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
  const rowCount = Number(countResult.toArray()[0].toJSON().count)

  return { columns, rowCount }
}

export async function loadXLSX(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  // Use SheetJS (xlsx) to parse the Excel file
  const { read, utils } = await import('xlsx')

  const arrayBuffer = await file.arrayBuffer()
  const workbook = read(arrayBuffer, { type: 'array' })

  // Get the first sheet
  const firstSheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[firstSheetName]

  // Convert to JSON
  const jsonData = utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' })

  if (jsonData.length === 0) {
    throw new Error('Excel file is empty or has no data rows')
  }

  // Get column names from the first row
  const columns = Object.keys(jsonData[0])

  const connection = await getConnection()

  // Create table with proper column definitions
  const columnDefs = columns.map((col) => `"${col}" VARCHAR`).join(', ')
  await connection.query(`CREATE OR REPLACE TABLE "${tableName}" (${columnDefs})`)

  // Insert data in batches
  const batchSize = 500
  for (let i = 0; i < jsonData.length; i += batchSize) {
    const batch = jsonData.slice(i, i + batchSize)
    const values = batch
      .map((row) => {
        const vals = columns.map((col) => {
          const val = row[col]
          if (val === null || val === undefined || val === '') return 'NULL'
          const str = String(val).replace(/'/g, "''")
          return `'${str}'`
        })
        return `(${vals.join(', ')})`
      })
      .join(', ')

    await connection.query(`INSERT INTO "${tableName}" VALUES ${values}`)
  }

  const rowCount = jsonData.length

  return { columns, rowCount }
}

export async function getTableData(
  tableName: string,
  offset = 0,
  limit = 1000
): Promise<Record<string, unknown>[]> {
  const connection = await getConnection()
  const result = await connection.query(
    `SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset}`
  )
  return result.toArray().map((row) => row.toJSON())
}

export async function getTableColumns(
  tableName: string
): Promise<{ name: string; type: string }[]> {
  const connection = await getConnection()
  const result = await connection.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `)
  return result.toArray().map((row) => {
    const json = row.toJSON()
    return {
      name: json.column_name as string,
      type: json.data_type as string,
    }
  })
}

export async function exportToCSV(tableName: string): Promise<Blob> {
  const connection = await getConnection()
  const result = await connection.query(`SELECT * FROM "${tableName}"`)

  const columns = result.schema.fields.map(f => f.name)
  const rows = result.toArray().map(row => row.toJSON())

  const csvLines = [
    columns.join(','),
    ...rows.map(row =>
      columns.map(col => {
        const val = row[col]
        if (val === null || val === undefined) return ''
        const str = String(val)
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }).join(',')
    )
  ]

  return new Blob([csvLines.join('\n')], { type: 'text/csv' })
}

export async function dropTable(tableName: string): Promise<void> {
  const connection = await getConnection()
  await connection.query(`DROP TABLE IF EXISTS "${tableName}"`)
}

export async function tableExists(tableName: string): Promise<boolean> {
  const connection = await getConnection()
  const result = await connection.query(`
    SELECT COUNT(*) as count
    FROM information_schema.tables
    WHERE table_name = '${tableName}'
  `)
  return Number(result.toArray()[0].toJSON().count) > 0
}

export { db, conn }
