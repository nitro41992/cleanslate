import { query, execute, getTableColumns } from '@/lib/duckdb'
import type { SerializedAuditLogEntry } from '@/types'

interface TableMetadata {
  id: string
  name: string
  columns: { name: string; type: string }[]
  rowCount: number
  createdAt: string
  updatedAt: string
}

interface StorageMetadata {
  version: number
  tables: TableMetadata[]
  lastUpdated: string
  auditEntries?: SerializedAuditLogEntry[]
}

const STORAGE_DIR = 'cleanslate'
const METADATA_FILE = 'metadata.json'

async function getStorageRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(STORAGE_DIR, { create: true })
  } catch (error) {
    console.warn('OPFS not available:', error)
    return null
  }
}

export async function isOPFSAvailable(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.getDirectoryHandle('test', { create: true })
    await root.removeEntry('test')
    return true
  } catch {
    return false
  }
}

export async function saveMetadata(
  tables: TableMetadata[],
  auditEntries?: SerializedAuditLogEntry[]
): Promise<void> {
  const root = await getStorageRoot()
  if (!root) return

  const metadata: StorageMetadata = {
    version: 1,
    tables,
    lastUpdated: new Date().toISOString(),
    auditEntries,
  }

  const fileHandle = await root.getFileHandle(METADATA_FILE, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(metadata, null, 2))
  await writable.close()
}

export async function loadMetadata(): Promise<StorageMetadata | null> {
  const root = await getStorageRoot()
  if (!root) return null

  try {
    const fileHandle = await root.getFileHandle(METADATA_FILE)
    const file = await fileHandle.getFile()
    const text = await file.text()
    return JSON.parse(text) as StorageMetadata
  } catch {
    return null
  }
}

export async function saveTableToOPFS(
  tableId: string,
  tableName: string
): Promise<void> {
  const root = await getStorageRoot()
  if (!root) return

  const tablesDir = await root.getDirectoryHandle('tables', { create: true })

  // Export table as Parquet for efficient storage
  try {
    await execute(`
      COPY "${tableName}" TO '/tmp/${tableId}.parquet' (FORMAT 'parquet')
    `)

    // Read the parquet file and save to OPFS
    // Note: DuckDB-WASM doesn't directly write to OPFS, so we export as CSV for now
    const csvData = await query<Record<string, unknown>>(`SELECT * FROM "${tableName}"`)

    const columns = await getTableColumns(tableName)
    const csvHeader = columns.map((c) => c.name).join(',')
    const csvRows = csvData.map((row) =>
      columns
        .map((c) => {
          const val = row[c.name]
          if (val === null || val === undefined) return ''
          const str = String(val)
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`
          }
          return str
        })
        .join(',')
    )
    const csvContent = [csvHeader, ...csvRows].join('\n')

    const fileHandle = await tablesDir.getFileHandle(`${tableId}.csv`, {
      create: true,
    })
    const writable = await fileHandle.createWritable()
    await writable.write(csvContent)
    await writable.close()
  } catch (error) {
    console.error('Error saving table to OPFS:', error)
    throw error
  }
}

export async function loadTableFromOPFS(
  tableId: string,
  tableName: string
): Promise<boolean> {
  const root = await getStorageRoot()
  if (!root) return false

  try {
    const tablesDir = await root.getDirectoryHandle('tables')
    const fileHandle = await tablesDir.getFileHandle(`${tableId}.csv`)
    const file = await fileHandle.getFile()

    // Load CSV directly into DuckDB
    const text = await file.text()
    const lines = text.split('\n')
    const headers = lines[0].split(',')

    // Create table
    const columnDefs = headers.map((h) => `"${h}" VARCHAR`).join(', ')
    await execute(`CREATE OR REPLACE TABLE "${tableName}" (${columnDefs})`)

    // Insert data in batches
    const batchSize = 1000
    for (let i = 1; i < lines.length; i += batchSize) {
      const batch = lines.slice(i, i + batchSize).filter((line) => line.trim())
      if (batch.length === 0) continue

      const values = batch
        .map((line) => {
          const vals = parseCSVLine(line)
          return `(${vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`
        })
        .join(', ')

      await execute(`INSERT INTO "${tableName}" VALUES ${values}`)
    }

    return true
  } catch (error) {
    console.warn('Could not load table from OPFS:', error)
    return false
  }
}

export async function removeTableFromOPFS(tableId: string): Promise<void> {
  const root = await getStorageRoot()
  if (!root) return

  try {
    const tablesDir = await root.getDirectoryHandle('tables')
    await tablesDir.removeEntry(`${tableId}.csv`)
  } catch {
    // File may not exist
  }
}

export async function clearAllOPFS(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(STORAGE_DIR, { recursive: true })
  } catch {
    // Directory may not exist
  }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }

  result.push(current)
  return result
}

/**
 * Save _audit_details table to OPFS
 */
export async function saveAuditDetailsToOPFS(): Promise<void> {
  const root = await getStorageRoot()
  if (!root) return

  try {
    // Check if _audit_details table exists
    const tableCheck = await query<{ count: number }>(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = '_audit_details'"
    )
    if (Number(tableCheck[0].count) === 0) return

    // Get all audit details
    const data = await query<Record<string, unknown>>('SELECT * FROM _audit_details')
    if (data.length === 0) return

    const columns = ['id', 'audit_entry_id', 'row_index', 'column_name', 'previous_value', 'new_value', 'created_at']
    const csvHeader = columns.join(',')
    const csvRows = data.map((row) =>
      columns
        .map((c) => {
          const val = row[c]
          if (val === null || val === undefined) return ''
          const str = String(val)
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`
          }
          return str
        })
        .join(',')
    )
    const csvContent = [csvHeader, ...csvRows].join('\n')

    const fileHandle = await root.getFileHandle('audit_details.csv', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(csvContent)
    await writable.close()
  } catch (error) {
    console.error('Error saving audit details to OPFS:', error)
  }
}

/**
 * Load _audit_details table from OPFS
 */
export async function loadAuditDetailsFromOPFS(): Promise<boolean> {
  const root = await getStorageRoot()
  if (!root) return false

  try {
    const fileHandle = await root.getFileHandle('audit_details.csv')
    const file = await fileHandle.getFile()
    const text = await file.text()
    const lines = text.split('\n')

    if (lines.length <= 1) return false

    // Create table
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
    await execute('CREATE INDEX IF NOT EXISTS idx_audit_entry ON _audit_details(audit_entry_id)')

    // Clear existing data
    await execute('DELETE FROM _audit_details')

    // Insert data in batches
    const batchSize = 500
    for (let i = 1; i < lines.length; i += batchSize) {
      const batch = lines.slice(i, i + batchSize).filter((line) => line.trim())
      if (batch.length === 0) continue

      const values = batch
        .map((line) => {
          const vals = parseCSVLine(line)
          // id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at
          const id = vals[0] ? `'${vals[0].replace(/'/g, "''")}'` : 'NULL'
          const auditEntryId = vals[1] ? `'${vals[1].replace(/'/g, "''")}'` : 'NULL'
          const rowIndex = vals[2] || '0'
          const columnName = vals[3] ? `'${vals[3].replace(/'/g, "''")}'` : 'NULL'
          const previousValue = vals[4] ? `'${vals[4].replace(/'/g, "''")}'` : 'NULL'
          const newValue = vals[5] ? `'${vals[5].replace(/'/g, "''")}'` : 'NULL'
          const createdAt = vals[6] ? `'${vals[6].replace(/'/g, "''")}'` : 'CURRENT_TIMESTAMP'
          return `(${id}, ${auditEntryId}, ${rowIndex}, ${columnName}, ${previousValue}, ${newValue}, ${createdAt})`
        })
        .join(', ')

      await execute(`INSERT INTO _audit_details VALUES ${values}`)
    }

    return true
  } catch (error) {
    console.warn('Could not load audit details from OPFS:', error)
    return false
  }
}

export type { TableMetadata, StorageMetadata }
