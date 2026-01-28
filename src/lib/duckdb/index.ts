import * as duckdb from '@duckdb/duckdb-wasm'
// COI bundle (for Cross-Origin Isolated environments - supports OPFS + pthreads)
import duckdb_wasm_coi from '@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url'
import duckdb_worker_coi from '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url'
import duckdb_worker_coi_pthread from '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url'
// EH bundle (for non-COI environments - native WASM exceptions)
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import duckdb_worker_eh from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
// MVP bundle (fallback for older browsers without WASM exceptions)
import duckdb_wasm_mvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdb_worker_mvp from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import type { CSVIngestionSettings } from '@/types'
import { withMutex } from './mutex'
import { detectBrowserCapabilities } from './browser-detection'
import { migrateFromCSVStorage } from './opfs-migration'
import { pruneAuditLog } from '../audit-pruning'
import { toast } from '@/hooks/use-toast'
import { getStorageInfo, formatBytes } from './storage-info'
import { toast as sonnerToast } from 'sonner'

/**
 * Internal row ID column name for stable row identity across mutations.
 * This column is injected on table creation and used for UPDATE/DELETE operations.
 * It should be hidden from the UI.
 */
export const CS_ID_COLUMN = '_cs_id'

/**
 * Normalize a _cs_id value to a consistent string format.
 * DuckDB returns BIGINT for ROW_NUMBER(), which comes back as JavaScript BigInt.
 * This must be converted to string for:
 * 1. Consistent JSON serialization (BigInt throws in JSON.stringify)
 * 2. Consistent comparison in dirty cell tracking (cellChanges keys)
 * 3. Stable storage in OPFS app-state.json
 *
 * @param value - The raw _cs_id value from DuckDB (typically BigInt)
 * @returns String representation of the csId
 */
export function normalizeCsId(value: unknown): string {
  // BigInt, number, string all convert correctly with String()
  // null/undefined become "null"/"undefined" which is fine for error detection
  return String(value)
}

/**
 * Filter out internal columns (like _cs_id, __base backup columns) from column lists for UI display
 */
export function filterInternalColumns(columns: string[]): string[] {
  return columns.filter(col =>
    col !== CS_ID_COLUMN && !col.endsWith('__base')
  )
}

/**
 * Check if a column is an internal system column
 * Includes:
 * - _cs_id (CleanSlate row ID)
 * - __base backup columns (Tier 1 transforms)
 * - duckdb_* metadata columns (DuckDB internals)
 */
export function isInternalColumn(columnName: string): boolean {
  return columnName === CS_ID_COLUMN ||
         columnName.endsWith('__base') ||
         columnName.startsWith('duckdb_')
}

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null
let isPersistent = false
let isReadOnly = false
let flushTimer: NodeJS.Timeout | null = null
let hasShownStorageWarning = false // Reset on page reload
let initPromise: Promise<duckdb.AsyncDuckDB> | null = null // Prevent double-init from React StrictMode

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdb_wasm_mvp,
    mainWorker: duckdb_worker_mvp,
  },
  eh: {
    mainModule: duckdb_wasm_eh,
    mainWorker: duckdb_worker_eh,
  },
  coi: {
    mainModule: duckdb_wasm_coi,
    mainWorker: duckdb_worker_coi,
    pthreadWorker: duckdb_worker_coi_pthread,
  },
}

export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  // Return existing DB if already initialized
  if (db) return db

  // Return existing promise if initialization is in progress (React StrictMode protection)
  if (initPromise) {
    console.log('[DuckDB] Init already in progress, returning existing promise')
    return initPromise
  }

  // Create new initialization promise
  initPromise = (async () => {
    try {
      return await _initDuckDBInternal()
    } finally {
      initPromise = null
    }
  })()

  return initPromise
}

async function _initDuckDBInternal(): Promise<duckdb.AsyncDuckDB> {
  // 1. Detect browser capabilities
  const caps = await detectBrowserCapabilities()

  // 2. Select appropriate bundle based on environment
  // COI bundle is required for Cross-Origin Isolated environments (OPFS + pthreads support)
  const isCOI = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  let bundle: duckdb.DuckDBBundle
  let bundleType: string

  if (isCOI && MANUAL_BUNDLES.coi) {
    // Use COI bundle for cross-origin isolated environments
    bundle = MANUAL_BUNDLES.coi
    bundleType = 'COI'
    console.log('[DuckDB] Using COI bundle for cross-origin isolated environment')
  } else {
    // Fall back to selectBundle for non-COI environments
    bundle = await duckdb.selectBundle(MANUAL_BUNDLES)
    bundleType = bundle.mainModule.includes('-eh') ? 'EH' : 'MVP'
  }

  const worker = new Worker(bundle.mainWorker!)
  // Use VoidLogger to silence noisy query logs - our diagnostic logging is more useful
  const logger = new duckdb.VoidLogger()

  db = new duckdb.AsyncDuckDB(logger, worker)

  // COI bundle requires pthreadWorker for multi-threading support
  if (bundleType === 'COI' && bundle.pthreadWorker) {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  } else {
    await db.instantiate(bundle.mainModule)
  }

  // Expose DuckDB to window for console debugging
  if (typeof window !== 'undefined') {
    // @ts-ignore - Expose for console debugging
    window.__db = db
    console.log('🔧 DuckDB exposed as window.__db for debugging')
  }

  // 3. Open with OPFS or in-memory based on browser capabilities
  try {
    console.log('[DuckDB] Capabilities:', {
      hasOPFS: caps.hasOPFS,
      supportsAccessHandle: caps.supportsAccessHandle,
      crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined',
      browser: caps.browser
    })

    if (caps.hasOPFS && caps.supportsAccessHandle) {
      // Chrome/Edge/Safari: OPFS-backed persistent storage
      // Using EH bundle (single-threaded) which works with OPFS without the COI bundle bug
      try {
        console.log('[DuckDB] Opening OPFS with accessMode:', duckdb.DuckDBAccessMode.READ_WRITE, '(value:', duckdb.DuckDBAccessMode.READ_WRITE, ')')
        await db.open({
          path: 'opfs://cleanslate.db',
          accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
        })
        isPersistent = true
        isReadOnly = false

        // Verify write access by checking if we can run a simple write query
        const testConn = await db.connect()
        try {
          await testConn.query('CREATE TABLE IF NOT EXISTS _write_test (x INT)')
          await testConn.query('DROP TABLE IF EXISTS _write_test')
          console.log(`[DuckDB] OPFS persistence enabled (${caps.browser}), write access verified`)
        } catch (writeTestError) {
          console.error('[DuckDB] Write access test failed:', writeTestError)
          isReadOnly = true
          toast({
            title: 'Read-Only Mode',
            description: 'Database opened but write access failed. Check browser permissions.',
            variant: 'default',
          })
        } finally {
          await testConn.close()
        }
      } catch (openError) {
        // Check if error is due to database already open in another tab or stale file handle
        const errorMsg = openError instanceof Error ? openError.message : String(openError)
        if (errorMsg.includes('locked') || errorMsg.includes('busy') || errorMsg.includes('Access Handles cannot be created')) {
          // Database locked by another tab - open in read-only mode
          console.warn('[DuckDB] Database locked by another tab, opening read-only')
          await db.open({
            path: 'opfs://cleanslate.db',
            accessMode: duckdb.DuckDBAccessMode.READ_ONLY,
          })
          isPersistent = true
          isReadOnly = true

          toast({
            title: 'Read-Only Mode',
            description: 'CleanSlate is open in another tab. This tab is read-only.',
            variant: 'default',
          })
        } else if (errorMsg.includes('not a valid DuckDB database file')) {
          // Corrupted or stale database file - need to terminate worker, delete ALL related files, and create fresh instance
          console.warn('[DuckDB] Corrupted/stale OPFS file detected, attempting recovery...')
          try {
            // Terminate the current worker to release file handles
            await db.terminate()
            db = null
            console.log('[DuckDB] Terminated worker to release file handles')

            // Recursively delete all DuckDB-related files from OPFS
            // DuckDB-WASM may create: cleanslate.db, cleanslate.db.wal, cleanslate_temp.db, and directories
            const root = await navigator.storage.getDirectory()

            // Helper to recursively delete entries matching a pattern
            async function deleteMatchingEntries(dir: FileSystemDirectoryHandle, pattern: RegExp, prefix = '') {
              // Use values() iterator - cast to any for TypeScript compatibility
              const entries = (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>
              for await (const [name, handle] of entries) {
                const fullPath = prefix ? `${prefix}/${name}` : name
                if (handle.kind === 'directory') {
                  // Recurse into directories
                  await deleteMatchingEntries(handle as FileSystemDirectoryHandle, pattern, fullPath)
                  // Try to delete empty directories related to duckdb
                  if (name.toLowerCase().includes('duckdb') || name.toLowerCase().includes('cleanslate')) {
                    try {
                      await dir.removeEntry(name, { recursive: true })
                      console.log(`[DuckDB] Deleted directory: ${fullPath}`)
                    } catch { /* Directory not empty or other error */ }
                  }
                } else if (pattern.test(name)) {
                  try {
                    await dir.removeEntry(name)
                    console.log(`[DuckDB] Deleted file: ${fullPath}`)
                  } catch (e) {
                    console.warn(`[DuckDB] Failed to delete ${fullPath}:`, e)
                  }
                }
              }
            }

            // Delete any file containing 'cleanslate' or common DuckDB extensions
            const cleanupPattern = /cleanslate|\.duckdb|\.wal$/i
            await deleteMatchingEntries(root, cleanupPattern)
            console.log('[DuckDB] OPFS cleanup completed')

            // Create fresh DuckDB instance with new worker (using same bundle type)
            const freshWorker = new Worker(bundle.mainWorker!)
            db = new duckdb.AsyncDuckDB(logger, freshWorker)
            if (bundleType === 'COI' && bundle.pthreadWorker) {
              await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
            } else {
              await db.instantiate(bundle.mainModule)
            }

            // Update window reference
            if (typeof window !== 'undefined') {
              // @ts-ignore
              window.__db = db
            }

            // Retry opening with fresh OPFS file
            await db.open({
              path: 'opfs://cleanslate.db',
              accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
            })
            isPersistent = true
            console.log(`[DuckDB] OPFS persistence enabled after recovery (${caps.browser})`)

            toast({
              title: 'Database Recovered',
              description: 'A corrupted database file was detected and cleared. Your data has been reset.',
              variant: 'default',
            })
          } catch (recoveryError) {
            console.error('[DuckDB] Recovery failed:', recoveryError)
            // Need to recreate db instance for memory fallback
            if (!db) {
              const fallbackWorker = new Worker(bundle.mainWorker!)
              db = new duckdb.AsyncDuckDB(logger, fallbackWorker)
              if (bundleType === 'COI' && bundle.pthreadWorker) {
                await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
              } else {
                await db.instantiate(bundle.mainModule)
              }
              if (typeof window !== 'undefined') {
                // @ts-ignore
                window.__db = db
              }
            }
            throw openError  // Re-throw original error to trigger memory fallback
          }
        } else {
          throw openError  // Re-throw if not a locking issue
        }
      }
    } else {
      // Firefox: In-memory fallback
      await db.open({
        path: ':memory:',
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      })
      isPersistent = false
      console.log(`[DuckDB] In-memory mode (${caps.browser} - no OPFS support)`)
    }
  } catch (error) {
    console.error('[DuckDB] OPFS init failed, falling back to memory:', error)
    toast({
      title: 'Using In-Memory Mode',
      description: 'Data will not persist between sessions. Export your work before closing.',
      variant: 'default',
    })
    await db.open({ path: ':memory:' })
    isPersistent = false
  }

  // 4. Configure memory limit, compression, and run migration/pruning
  // All done in a single connection to avoid "Missing DB manager" errors
  const isTestEnv = typeof navigator !== 'undefined' &&
                    navigator.userAgent.includes('Playwright')
  const memoryLimit = isTestEnv ? '1843MB' : '1843MB'  // 1.8GB for both test and production

  const initConn = await db.connect()

  // Set memory limit
  await initConn.query(`SET memory_limit = '${memoryLimit}'`)

  // Reduce thread count to minimize memory overhead per thread
  // NOTE: DuckDB-WASM may not support thread configuration (compiled without threads)
  // Silently skip - this is expected and doesn't affect functionality
  try {
    await initConn.query(`SET threads = 2`)
  } catch (err) {
    // Silently ignore - WASM build doesn't support thread configuration (expected)
  }

  // Set temporary directory for large operations (spilling to disk)
  // CRITICAL: Only enable for write-access OPFS mode
  // Read-only tabs (secondary tabs) should NOT set temp_directory to avoid conflicts
  // NOTE: DuckDB-WASM 1.32.0 accepts this setting but doesn't use it for spilling yet
  if (isPersistent && !isReadOnly) {
    await initConn.query(`SET temp_directory = 'opfs://cleanslate_temp.db'`)
    // Removed log to avoid confusion - feature not working in WASM yet
  }

  // Enable compression (both OPFS and in-memory benefit)
  await initConn.query(`PRAGMA enable_object_cache=true`)
  await initConn.query(`PRAGMA force_compression='zstd'`)

  // Run one-time migration if needed (only for OPFS mode)
  if (isPersistent && !isReadOnly) {
    const migrationResult = await migrateFromCSVStorage(db, initConn)
    if (migrationResult.migrated) {
      console.log(
        `[Migration] Migrated ${migrationResult.tablesImported} tables from CSV storage`
      )
      if (migrationResult.error) {
        console.warn(`[Migration] ${migrationResult.error}`)
      }
    }

    // Prune old audit entries (keep last 100)
    await pruneAuditLog(initConn)
  }

  await initConn.close()

  console.log(
    `[DuckDB] ${bundleType} bundle, ${memoryLimit} limit, compression enabled, ` +
    `backend: ${isPersistent ? 'OPFS' : 'memory'}${isReadOnly ? ' (read-only)' : ''}`
  )
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

/**
 * Reset DuckDB connection (for tests or error recovery)
 * Forces re-initialization on next getConnection() call
 */
export async function resetConnection(): Promise<void> {
  return withMutex(async () => {
    if (conn) {
      try {
        await conn.close()
      } catch (error) {
        console.warn('[resetConnection] Failed to close connection:', error)
      }
      conn = null
    }
  })
}

/**
 * Check if connection is healthy
 * Returns false if connection is corrupted or in invalid state
 */
export async function checkConnectionHealth(): Promise<boolean> {
  return withMutex(async () => {
    try {
      const connection = await getConnection()
      await connection.query('SELECT 1 as health_check')
      return true
    } catch (error) {
      console.error('[checkConnectionHealth] Connection unhealthy:', error)
      return false
    }
  })
}

export async function query<T = Record<string, unknown>>(
  sql: string
): Promise<T[]> {
  return withMutex(async () => {
    const connection = await getConnection()
    const result = await connection.query(sql)
    return result.toArray().map((row) => row.toJSON() as T)
  })
}

export async function queryArrow(sql: string) {
  return withMutex(async () => {
    const connection = await getConnection()
    return await connection.query(sql)
  })
}

export async function execute(sql: string): Promise<void> {
  return withMutex(async () => {
    const connection = await getConnection()
    await connection.query(sql)
  })
}

export async function loadCSV(
  tableName: string,
  file: File,
  settings?: CSVIngestionSettings
): Promise<{ columns: string[]; rowCount: number }> {
  return withMutex(async () => {
    const db = await initDuckDB()
    const connection = await getConnection()

    // Register the file with DuckDB
    await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)

    // Build read_csv options based on settings
    const options: string[] = []

    if (settings?.headerRow !== undefined) {
      options.push('header=true')
      // Skip rows before header (0-indexed skip count)
      if (settings.headerRow > 1) {
        options.push(`skip=${settings.headerRow - 1}`)
      }
    } else {
      options.push('header=true')
    }

    if (settings?.delimiter) {
      // Escape the delimiter for SQL
      const delimEscaped = settings.delimiter === '\t' ? '\\t' : settings.delimiter
      options.push(`delim='${delimEscaped}'`)
    }

    // Build the SQL query
    const optionsStr = options.length > 0 ? `, ${options.join(', ')}` : ''
    const readCsvQuery = settings
      ? `read_csv('${file.name}'${optionsStr})`
      : `read_csv_auto('${file.name}')`

    // Create table from CSV with _cs_id for stable row identity
    // CRITICAL: Use ROW_NUMBER() to preserve insertion order, not gen_random_uuid()
    // Random UUIDs don't preserve order, causing rows to shuffle on CTAS operations
    // Use BIGINT for proper numeric ordering
    await connection.query(`
      CREATE OR REPLACE TABLE "${tableName}" AS
      SELECT ROW_NUMBER() OVER () as "${CS_ID_COLUMN}", * FROM ${readCsvQuery}
    `)

    // Get column info (excluding internal _cs_id column)
    const columnsResult = await connection.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    const allColumns = columnsResult.toArray().map((row) => row.toJSON().column_name as string)
    const columns = filterInternalColumns(allColumns)

    // Get row count
    const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
    const rowCount = Number(countResult.toArray()[0].toJSON().count)

    return { columns, rowCount }
  })
}

export async function loadJSON(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  return withMutex(async () => {
    const db = await initDuckDB()
    const connection = await getConnection()

    await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)

    // Create table from JSON with _cs_id for stable row identity
    // CRITICAL: Use ROW_NUMBER() to preserve insertion order, not gen_random_uuid()
    await connection.query(`
      CREATE OR REPLACE TABLE "${tableName}" AS
      SELECT ROW_NUMBER() OVER () as "${CS_ID_COLUMN}", * FROM read_json_auto('${file.name}')
    `)

    const columnsResult = await connection.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    const allColumns = columnsResult.toArray().map((row) => row.toJSON().column_name as string)
    const columns = filterInternalColumns(allColumns)

    const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
    const rowCount = Number(countResult.toArray()[0].toJSON().count)

    return { columns, rowCount }
  })
}

export async function loadParquet(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  return withMutex(async () => {
    const db = await initDuckDB()
    const connection = await getConnection()

    await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)

    // Create table from Parquet with _cs_id for stable row identity
    // CRITICAL: Use ROW_NUMBER() to preserve insertion order, not gen_random_uuid()
    await connection.query(`
      CREATE OR REPLACE TABLE "${tableName}" AS
      SELECT ROW_NUMBER() OVER () as "${CS_ID_COLUMN}", * FROM read_parquet('${file.name}')
    `)

    const columnsResult = await connection.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    const allColumns = columnsResult.toArray().map((row) => row.toJSON().column_name as string)
    const columns = filterInternalColumns(allColumns)

    const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
    const rowCount = Number(countResult.toArray()[0].toJSON().count)

    return { columns, rowCount }
  })
}

export async function loadXLSX(
  tableName: string,
  file: File
): Promise<{ columns: string[]; rowCount: number }> {
  // Use SheetJS (xlsx) to parse the Excel file (outside mutex - CPU-bound)
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

  // Database operations inside mutex
  return withMutex(async () => {
    const connection = await getConnection()

    // Create table with _cs_id column for stable row identity + user columns
    // Use BIGINT for _cs_id for proper numeric ordering
    const columnDefs = [`"${CS_ID_COLUMN}" BIGINT`, ...columns.map((col) => `"${col}" VARCHAR`)].join(', ')
    await connection.query(`CREATE OR REPLACE TABLE "${tableName}" (${columnDefs})`)

    // Insert data in batches with sequential IDs to preserve insertion order
    const batchSize = 500
    for (let i = 0; i < jsonData.length; i += batchSize) {
      const batch = jsonData.slice(i, i + batchSize)
      const values = batch
        .map((row, idx) => {
          // Use sequential ID based on position in jsonData array
          const rowId = i + idx + 1 // 1-indexed to match ROW_NUMBER()
          const vals = [
            `${rowId}`, // _cs_id as numeric BIGINT
            ...columns.map((col) => {
              const val = row[col]
              if (val === null || val === undefined || val === '') return 'NULL'
              const str = String(val).replace(/'/g, "''")
              return `'${str}'`
            })
          ]
          return `(${vals.join(', ')})`
        })
        .join(', ')

      await connection.query(`INSERT INTO "${tableName}" VALUES ${values}`)
    }

    const rowCount = jsonData.length

    return { columns, rowCount }
  })
}

export async function getTableData(
  tableName: string,
  offset = 0,
  limit = 1000,
  includeInternal = false
): Promise<Record<string, unknown>[]> {
  return withMutex(async () => {
    const connection = await getConnection()
    // Try ORDER BY _cs_id for deterministic pagination, fall back if column doesn't exist
    let result
    try {
      result = await connection.query(
        `SELECT * FROM "${tableName}" ORDER BY "${CS_ID_COLUMN}" LIMIT ${limit} OFFSET ${offset}`
      )
    } catch {
      // Table doesn't have _cs_id (e.g., diff tables) - query without ORDER BY
      result = await connection.query(
        `SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset}`
      )
    }
    const rows = result.toArray().map((row) => row.toJSON())

    if (includeInternal) {
      return rows
    }

    // Filter out internal columns from results
    return rows.map(row => {
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        if (!isInternalColumn(key)) {
          filtered[key] = value
        }
      }
      return filtered
    })
  })
}

/**
 * Get table data with _cs_id values for timeline operations
 * Returns rows with their stable row IDs
 */
export async function getTableDataWithRowIds(
  tableName: string,
  offset = 0,
  limit = 1000
): Promise<{ csId: string; data: Record<string, unknown> }[]> {
  return withMutex(async () => {
    const connection = await getConnection()
    // ORDER BY _cs_id for deterministic pagination across queries
    // Without this, multi-threaded DuckDB may return rows in different order
    const result = await connection.query(
      `SELECT * FROM "${tableName}" ORDER BY "${CS_ID_COLUMN}" LIMIT ${limit} OFFSET ${offset}`
    )
    return result.toArray().map((row) => {
      const json = row.toJSON()
      const csId = normalizeCsId(json[CS_ID_COLUMN])
      const data: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(json)) {
        if (!isInternalColumn(key)) {
          data[key] = value
        }
      }
      return { csId, data }
    })
  })
}

/**
 * Keyset pagination cursor for efficient O(1) queries at any table depth.
 * Uses WHERE _cs_id > X instead of OFFSET for consistent performance.
 */
export interface KeysetCursor {
  direction: 'forward' | 'backward'
  csId: string | null
}

/**
 * Result from keyset pagination query.
 * Includes boundary csIds for cursor management.
 */
export interface KeysetPageResult {
  rows: { csId: string; data: Record<string, unknown> }[]
  firstCsId: string | null
  lastCsId: string | null
  hasMore: boolean
}

/**
 * Get table data using keyset pagination for O(1) performance at any depth.
 *
 * Unlike OFFSET-based pagination which degrades linearly with depth,
 * keyset pagination uses WHERE _cs_id > X to jump directly to the target position.
 *
 * @param tableName - Name of the table to query
 * @param cursor - Pagination cursor (null csId for first page)
 * @param limit - Number of rows to fetch (default 500)
 * @returns Page of rows with boundary csIds for next/prev navigation
 */
export async function getTableDataWithKeyset(
  tableName: string,
  cursor: KeysetCursor,
  limit = 500
): Promise<KeysetPageResult> {
  return withMutex(async () => {
    const connection = await getConnection()
    let query: string

    if (!cursor.csId) {
      // First page - no cursor, start from beginning
      query = `SELECT * FROM "${tableName}" ORDER BY "${CS_ID_COLUMN}" LIMIT ${limit + 1}`
    } else if (cursor.direction === 'forward') {
      // Scroll down - get rows after cursor
      query = `SELECT * FROM "${tableName}" WHERE "${CS_ID_COLUMN}" > ${cursor.csId} ORDER BY "${CS_ID_COLUMN}" LIMIT ${limit + 1}`
    } else {
      // Scroll up - get rows before cursor, then reverse
      query = `SELECT * FROM "${tableName}" WHERE "${CS_ID_COLUMN}" < ${cursor.csId} ORDER BY "${CS_ID_COLUMN}" DESC LIMIT ${limit + 1}`
    }

    const result = await connection.query(query)
    let rawRows = result.toArray().map((row) => row.toJSON())

    // Check if there are more rows beyond this page
    const hasMore = rawRows.length > limit
    if (hasMore) {
      rawRows = rawRows.slice(0, limit)
    }

    // Reverse if scrolling backward (we queried DESC)
    if (cursor.direction === 'backward') {
      rawRows = rawRows.reverse()
    }

    // Map to output format with csId separation
    const rows = rawRows.map((row) => {
      const csId = normalizeCsId(row[CS_ID_COLUMN])
      const data: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        if (!isInternalColumn(key)) {
          data[key] = value
        }
      }
      return { csId, data }
    })

    return {
      rows,
      firstCsId: rows[0]?.csId ?? null,
      lastCsId: rows[rows.length - 1]?.csId ?? null,
      hasMore,
    }
  })
}

/**
 * Estimate the _cs_id for a given row index.
 *
 * Since _cs_id is sequential starting from 1 (ROW_NUMBER()),
 * row N approximately maps to _cs_id = N + 1.
 *
 * This is approximate if rows were deleted mid-session (gaps in sequence),
 * but is acceptable for data exploration and jump-to-row functionality.
 *
 * @param rowIndex - 0-based row index to estimate
 * @returns Estimated _cs_id value as string
 */
export function estimateCsIdForRow(rowIndex: number): string {
  // _cs_id uses ROW_NUMBER() which is 1-indexed
  return String(rowIndex + 1)
}

export async function getTableColumns(
  tableName: string,
  includeInternal = false
): Promise<{ name: string; type: string; nullable: boolean }[]> {
  return withMutex(async () => {
    const connection = await getConnection()
    const result = await connection.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    const allColumns = result.toArray().map((row) => {
      const json = row.toJSON()
      return {
        name: json.column_name as string,
        type: json.data_type as string,
        nullable: json.is_nullable === 'YES',
      }
    })

    if (includeInternal) {
      return allColumns
    }
    return allColumns.filter(col => !isInternalColumn(col.name))
  })
}

export async function exportToCSV(tableName: string): Promise<Blob> {
  return withMutex(async () => {
    const connection = await getConnection()
    const result = await connection.query(`SELECT * FROM "${tableName}"`)

    // Filter out internal columns from export
    const allColumns = result.schema.fields.map(f => f.name)
    const columns = filterInternalColumns(allColumns)
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
  })
}

export async function dropTable(tableName: string): Promise<void> {
  return withMutex(async () => {
    const connection = await getConnection()
    await connection.query(`DROP TABLE IF EXISTS "${tableName}"`)
  })
}

export async function tableExists(tableName: string): Promise<boolean> {
  return withMutex(async () => {
    const connection = await getConnection()
    const result = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_name = '${tableName}'
    `)
    return Number(result.toArray()[0].toJSON().count) > 0
  })
}

/**
 * Escape a value for SQL
 */
function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return 'NULL'
  } else if (typeof value === 'number') {
    return String(value)
  } else if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  } else {
    // String value - escape single quotes
    const escaped = String(value).replace(/'/g, "''")
    return `'${escaped}'`
  }
}

/**
 * Get the _cs_id value for a row at a given index
 */
export async function getRowCsId(
  tableName: string,
  rowIndex: number
): Promise<string | null> {
  const connection = await getConnection()
  const result = await connection.query(`
    SELECT "${CS_ID_COLUMN}" as cs_id
    FROM "${tableName}"
    LIMIT 1 OFFSET ${rowIndex}
  `)
  const rows = result.toArray()
  if (rows.length === 0) return null
  return rows[0].toJSON().cs_id as string
}

/**
 * Update a single cell value in a table using _cs_id for stable row targeting
 */
export async function updateCellByRowId(
  tableName: string,
  csId: string,
  columnName: string,
  newValue: unknown
): Promise<void> {
  const connection = await getConnection()
  const sqlValue = escapeSqlValue(newValue)

  await connection.query(`
    UPDATE "${tableName}"
    SET "${columnName}" = ${sqlValue}
    WHERE "${CS_ID_COLUMN}" = '${csId}'
  `)
}

/**
 * Update a single cell value in a table
 * Uses _cs_id for stable row targeting (falls back to rowid for legacy tables)
 */
export async function updateCell(
  tableName: string,
  rowIndex: number,
  columnName: string,
  newValue: unknown
): Promise<{ csId: string | null }> {
  const connection = await getConnection()
  const sqlValue = escapeSqlValue(newValue)

  // First, check if the table has _cs_id column
  const hasCsId = await tableHasCsId(tableName)

  if (hasCsId) {
    // Get the _cs_id for this row
    const csId = await getRowCsId(tableName, rowIndex)
    if (!csId) {
      throw new Error(`Row not found at index ${rowIndex}`)
    }

    await connection.query(`
      UPDATE "${tableName}"
      SET "${columnName}" = ${sqlValue}
      WHERE "${CS_ID_COLUMN}" = '${csId}'
    `)

    return { csId }
  } else {
    // Legacy: use rowid for tables without _cs_id
    await connection.query(`
      UPDATE "${tableName}"
      SET "${columnName}" = ${sqlValue}
      WHERE rowid = ${rowIndex}
    `)
    return { csId: null }
  }
}

/**
 * Check if a table has the _cs_id column
 */
export async function tableHasCsId(tableName: string): Promise<boolean> {
  const connection = await getConnection()
  const result = await connection.query(`
    SELECT COUNT(*) as count
    FROM information_schema.columns
    WHERE table_name = '${tableName}' AND column_name = '${CS_ID_COLUMN}'
  `)
  return Number(result.toArray()[0].toJSON().count) > 0
}

/**
 * Add _cs_id column to an existing table (migration for legacy tables)
 * CRITICAL: Use ROW_NUMBER() to preserve insertion order
 */
export async function addCsIdToTable(tableName: string): Promise<void> {
  const hasCsId = await tableHasCsId(tableName)
  if (hasCsId) return // Already has _cs_id

  const connection = await getConnection()

  // Rebuild table with sequential _cs_id to preserve row order
  const tempTable = `${tableName}_csid_temp_${Date.now()}`
  await connection.query(`
    CREATE TABLE "${tempTable}" AS
    SELECT ROW_NUMBER() OVER () as "${CS_ID_COLUMN}", *
    FROM "${tableName}"
  `)

  // Swap tables
  await connection.query(`DROP TABLE "${tableName}"`)
  await connection.query(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
}

/**
 * Get the value of a specific cell
 */
export async function getCellValue(
  tableName: string,
  rowIndex: number,
  columnName: string
): Promise<unknown> {
  const connection = await getConnection()
  const result = await connection.query(`
    SELECT "${columnName}" as value
    FROM "${tableName}"
    WHERE rowid = ${rowIndex}
  `)
  const rows = result.toArray()
  if (rows.length === 0) return undefined
  return rows[0].toJSON().value
}

/**
 * Duplicate a table with a new name
 * Uses CREATE TABLE AS SELECT for efficient copying
 * @param preserveRowIds - If true, keeps the same _cs_id values (for timeline snapshots)
 *                        If false, generates new _cs_id values (for user-facing duplicates)
 */
export async function duplicateTable(
  sourceName: string,
  targetName: string,
  preserveRowIds = false
): Promise<{ columns: { name: string; type: string }[]; rowCount: number }> {
  const connection = await getConnection()

  // Check if source has _cs_id
  const hasCsId = await tableHasCsId(sourceName)

  if (hasCsId && !preserveRowIds) {
    // Generate new _cs_id values for user-facing duplicates
    // Get all columns except _cs_id
    const cols = await getTableColumns(sourceName, true)
    const userCols = cols.filter(c => c.name !== CS_ID_COLUMN).map(c => `"${c.name}"`)

    // CRITICAL: Use ROW_NUMBER() to preserve row order, not gen_random_uuid()
    // Order by source _cs_id to maintain original ordering
    await connection.query(`
      CREATE TABLE "${targetName}" AS
      SELECT ROW_NUMBER() OVER (ORDER BY "${CS_ID_COLUMN}") as "${CS_ID_COLUMN}", ${userCols.join(', ')}
      FROM "${sourceName}"
    `)
  } else {
    // Preserve _cs_id values (for timeline snapshots) or source has no _cs_id
    // ORDER BY ensures deterministic row ordering for snapshot consistency
    const orderClause = hasCsId ? `ORDER BY "${CS_ID_COLUMN}"` : ''
    await connection.query(`
      CREATE TABLE "${targetName}" AS
      SELECT * FROM "${sourceName}"
      ${orderClause}
    `)
  }

  // Get column info (excluding internal columns for return value)
  const columnsResult = await connection.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = '${targetName}'
    ORDER BY ordinal_position
  `)
  const allColumns = columnsResult.toArray().map((row) => {
    const json = row.toJSON()
    return {
      name: json.column_name as string,
      type: json.data_type as string,
    }
  })
  const columns = allColumns.filter(col => !isInternalColumn(col.name))

  // Get row count
  const countResult = await connection.query(`SELECT COUNT(*) as count FROM "${targetName}"`)
  const rowCount = Number(countResult.toArray()[0].toJSON().count)

  return { columns, rowCount }
}

/**
 * Get the original snapshot table name for a table
 *
 * @deprecated This function is part of the legacy snapshot system (_original_${tableName}).
 * The timeline system now uses _timeline_original_${timelineId} snapshots instead.
 * This function is kept for backward compatibility with existing diff fallback logic.
 * @see getTimelineOriginalName in timeline-engine.ts for the new system
 */
export function getOriginalSnapshotName(tableName: string): string {
  return `_original_${tableName}`
}

/**
 * Check if an original snapshot exists for a table
 *
 * @deprecated This function is part of the legacy snapshot system (_original_${tableName}).
 * The timeline system now uses _timeline_original_${timelineId} snapshots instead.
 * This function is kept for backward compatibility with existing diff fallback logic.
 * @see initializeTimeline in timeline-engine.ts for the new system
 */
export async function hasOriginalSnapshot(tableName: string): Promise<boolean> {
  const snapshotName = getOriginalSnapshotName(tableName)
  return tableExists(snapshotName)
}

/**
 * Create an original snapshot of a table (if it doesn't exist)
 *
 * @deprecated This function is part of the legacy snapshot system.
 * No longer called by transformations.ts or DataGrid.tsx.
 * Use initializeTimeline() from timeline-engine.ts instead, which creates
 * _timeline_original_${timelineId} snapshots that are properly tracked.
 *
 * @see initializeTimeline in timeline-engine.ts for the new system
 */
export async function createOriginalSnapshot(tableName: string): Promise<boolean> {
  const snapshotName = getOriginalSnapshotName(tableName)

  // Check if snapshot already exists
  const exists = await tableExists(snapshotName)
  if (exists) {
    return false // Snapshot already exists
  }

  const connection = await getConnection()

  // Create a copy preserving _cs_id values for row tracking
  // CRITICAL: ORDER BY "_cs_id" preserves row order (prevents flaky tests)
  await connection.query(`
    CREATE TABLE "${snapshotName}" AS
    SELECT * FROM "${tableName}"
    ORDER BY "_cs_id"
  `)

  return true // New snapshot created
}

/**
 * Delete the original snapshot for a table
 *
 * @deprecated This function is part of the legacy snapshot system.
 * Kept for cleaning up legacy _original_${tableName} snapshots.
 * New code should use cleanupTimelineSnapshots() from timeline-engine.ts.
 *
 * @see cleanupTimelineSnapshots in timeline-engine.ts for the new system
 */
export async function deleteOriginalSnapshot(tableName: string): Promise<void> {
  const snapshotName = getOriginalSnapshotName(tableName)
  await dropTable(snapshotName)
}

/**
 * Restore a table from its original snapshot
 *
 * @deprecated This function is part of the legacy snapshot system.
 * Use replayToPosition(tableId, -1) from timeline-engine.ts instead,
 * which uses the timeline's original snapshot for restoration.
 *
 * @see replayToPosition in timeline-engine.ts for the new system
 */
export async function restoreFromOriginalSnapshot(tableName: string): Promise<boolean> {
  const snapshotName = getOriginalSnapshotName(tableName)

  const exists = await tableExists(snapshotName)
  if (!exists) {
    return false // No snapshot to restore from
  }

  const connection = await getConnection()

  // Replace current table with original
  // CRITICAL: ORDER BY "_cs_id" preserves row order (prevents flaky tests)
  await connection.query(`DROP TABLE IF EXISTS "${tableName}"`)
  await connection.query(`
    CREATE TABLE "${tableName}" AS
    SELECT * FROM "${snapshotName}"
    ORDER BY "_cs_id"
  `)

  return true
}

/**
 * Check if DuckDB is using persistent OPFS storage
 * Returns true for Chrome/Edge/Safari, false for Firefox (in-memory)
 */
export function isDuckDBPersistent(): boolean {
  return isPersistent
}

/**
 * Check if DuckDB is in read-only mode
 * Returns true if opened read-only due to database lock (double-tab scenario)
 */
export function isDuckDBReadOnly(): boolean {
  return isReadOnly
}

/**
 * Check storage quota and warn user if approaching limit (>80%)
 * Shows one-time toast per session to avoid spam
 */
async function checkStorageQuota(): Promise<void> {
  // Skip if already warned this session
  if (hasShownStorageWarning) return

  // Skip if read-only (user can't fix quota issues)
  if (isReadOnly) return

  try {
    const info = await getStorageInfo(isPersistent, isReadOnly)

    // No quota info available (Firefox, or API not supported)
    if (!info.quota) return

    if (info.quota.isNearLimit) {
      const { usedBytes, quotaBytes, usagePercent } = info.quota

      sonnerToast.error('Storage Almost Full', {
        description: `You're using ${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} (${Math.round(usagePercent)}%). Export or delete old tables to free up space.`,
        duration: 10000, // 10 seconds
        action: {
          label: 'View Tables',
          onClick: () => {
            // Trigger sidebar open (if collapsed)
            window.dispatchEvent(new CustomEvent('open-table-sidebar'))
          }
        }
      })

      hasShownStorageWarning = true
      console.warn('[Storage Quota] Near limit:', { usedBytes, quotaBytes, usagePercent })
    }
  } catch (err) {
    // Silently fail - don't interrupt user workflow
    console.warn('[Storage Quota] Check failed:', err)
  }
}

/**
 * Flush DuckDB WAL to OPFS
 * Debounced (1 second idle time) to prevent UI stuttering on bulk edits
 * @param immediate - If true, flush immediately (bypasses debounce)
 * @param callbacks - Optional callbacks for flush lifecycle events
 */
export async function flushDuckDB(
  immediate = false,
  callbacks?: {
    onStart?: () => void
    onComplete?: () => void
    onError?: (error: Error) => void
  }
): Promise<void> {
  if (!isPersistent || isReadOnly) return // In-memory or read-only - nothing to flush

  // Disable auto-flush in test environment to prevent race conditions
  const isTestEnv = import.meta.env.MODE === 'test' ||
                    (typeof navigator !== 'undefined' && navigator.userAgent.includes('Playwright'))

  if (!immediate && isTestEnv) {
    console.log('[flushDuckDB] Auto-flush disabled in test environment')
    return
  }

  // Notify start of flush
  callbacks?.onStart?.()

  // Clear existing timer
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  if (immediate) {
    // Immediate flush (called on app unload)
    try {
      const conn = await getConnection()
      await withMutex(async () => {
        await conn.query(`CHECKPOINT`)
      })
      console.log('[OPFS] Immediate flush completed')
      callbacks?.onComplete?.()

      // Check storage quota after successful flush
      await checkStorageQuota()
    } catch (err) {
      console.warn('[OPFS] Immediate flush failed:', err)
      callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  } else {
    // Debounced flush (1 second idle time)
    flushTimer = setTimeout(async () => {
      try {
        const conn = await getConnection()
        await withMutex(async () => {
          await conn.query(`CHECKPOINT`)
        })
        console.log('[OPFS] Auto-flush completed')
        callbacks?.onComplete?.()

        // Check storage quota after successful flush
        await checkStorageQuota()
      } catch (err) {
        console.warn('[OPFS] Auto-flush failed:', err)
        callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
      flushTimer = null
    }, 1000)
  }
}

export { db, conn }
