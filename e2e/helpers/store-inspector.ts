import { Page } from '@playwright/test'

export interface TableInfo {
  id: string
  name: string
  columns: { name: string; type: string }[]
  rowCount: number
}

export interface AuditEntry {
  id: string
  timestamp: Date
  tableId: string
  tableName: string
  action: string
  details: string
  entryType?: 'A' | 'B'
  previousValue?: unknown
  newValue?: unknown
  rowIndex?: number
  columnName?: string
}

export interface StoreInspector {
  getTables: () => Promise<TableInfo[]>
  getActiveTableId: () => Promise<string | null>
  getTableData: (tableName: string, limit?: number) => Promise<Record<string, unknown>[]>
  getAuditEntries: (tableId?: string) => Promise<AuditEntry[]>
  waitForDuckDBReady: () => Promise<void>
  waitForTableLoaded: (tableName: string, expectedRowCount?: number) => Promise<void>
  /**
   * Execute arbitrary SQL query against DuckDB for verification.
   * Use this to verify join results, counts, or any SQL-level assertions.
   * @param sql - SQL query to execute
   * @returns Query result rows
   */
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>
}

export function createStoreInspector(page: Page): StoreInspector {
  return {
    async getTables(): Promise<TableInfo[]> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return []
        const store = stores.tableStore as { getState: () => { tables: TableInfo[] } }
        const state = store.getState()
        return state.tables.map((t) => ({
          id: t.id,
          name: t.name,
          columns: t.columns,
          rowCount: t.rowCount,
        }))
      })
    },

    async getActiveTableId(): Promise<string | null> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        const store = stores.tableStore as { getState: () => { activeTableId: string | null } }
        return store.getState().activeTableId
      })
    },

    async getTableData(tableName: string, limit = 100): Promise<Record<string, unknown>[]> {
      return page.evaluate(
        async ({ tableName, limit }) => {
          const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { query: (sql: string) => Promise<Record<string, unknown>[]>; isReady: boolean } }).__CLEANSLATE_DUCKDB__
          if (!duckdb?.query) throw new Error('DuckDB not available')
          return duckdb.query(`SELECT * FROM "${tableName}" LIMIT ${limit}`)
        },
        { tableName, limit }
      )
    },

    async getAuditEntries(tableId?: string): Promise<AuditEntry[]> {
      return page.evaluate((tableId) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.auditStore) return []
        const store = stores.auditStore as { getState: () => { entries: AuditEntry[] } }
        const entries = store.getState().entries
        return tableId ? entries.filter((e) => e.tableId === tableId) : entries
      }, tableId)
    },

    async waitForDuckDBReady(): Promise<void> {
      // Wait for the "Initializing data engine..." text to disappear
      // This indicates DuckDB is ready in the UI
      await page.waitForFunction(
        () => {
          const initText = document.body.innerText
          return !initText.includes('Initializing data engine')
        },
        { timeout: 30000 }
      )
      // Also ensure the stores are exposed
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          return stores?.tableStore !== undefined
        },
        { timeout: 30000 }
      )
    },

    async waitForTableLoaded(tableName: string, expectedRowCount?: number): Promise<void> {
      await page.waitForFunction(
        ({ tableName, expectedRowCount }) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return false
          const store = stores.tableStore as { getState: () => { tables: TableInfo[] } }
          const tables = store.getState().tables
          const table = tables.find((t) => t.name === tableName)
          if (!table) return false
          if (expectedRowCount !== undefined && table.rowCount !== expectedRowCount) return false
          return true
        },
        { tableName, expectedRowCount },
        { timeout: 30000 }
      )
    },

    async runQuery(sql: string): Promise<Record<string, unknown>[]> {
      return page.evaluate(async (sql) => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { query: (sql: string) => Promise<Record<string, unknown>[]>; isReady: boolean } }).__CLEANSLATE_DUCKDB__
        if (!duckdb?.query) throw new Error('DuckDB not available')
        return duckdb.query(sql)
      }, sql)
    },
  }
}
