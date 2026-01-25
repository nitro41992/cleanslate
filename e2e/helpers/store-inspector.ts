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
  hasRowDetails?: boolean
  auditEntryId?: string
  rowsAffected?: number
}

export interface TimelineHighlightState {
  commandId: string | null
  rowCount: number           // Keep for backward compatibility
  rowIds: string[]           // NEW: Expose actual row IDs
  columnCount: number
  diffMode: string
}

export interface TimelinePositionState {
  current: number
  total: number
}

export interface DiffStoreState {
  isComparing: boolean
  summary: { added: number; removed: number; modified: number; unchanged: number } | null
  mode: string
}

export interface EditDirtyState {
  hasDirtyEdits: boolean
  dirtyCount: number
}

export interface StoreInspector {
  getTables: () => Promise<TableInfo[]>
  getActiveTableId: () => Promise<string | null>
  getTableData: (tableName: string, limit?: number) => Promise<Record<string, unknown>[]>
  getAuditEntries: (tableId?: string) => Promise<AuditEntry[]>
  waitForDuckDBReady: () => Promise<void>
  waitForTableLoaded: (tableName: string, expectedRowCount?: number, timeout?: number) => Promise<void>
  /**
   * Execute arbitrary SQL query against DuckDB for verification.
   * Use this to verify join results, counts, or any SQL-level assertions.
   * @param sql - SQL query to execute
   * @returns Query result rows
   */
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>
  /**
   * Get diff highlighting state from diffStore
   */
  getDiffState: () => Promise<DiffStoreState>
  /**
   * Get edit store dirty state
   */
  getEditDirtyState: () => Promise<EditDirtyState>
  /**
   * Get timeline position for undo/redo verification
   */
  getTimelinePosition: (tableId?: string) => Promise<TimelinePositionState>
  /**
   * Get timeline highlight state (for visual highlighting verification)
   */
  getTimelineHighlight: () => Promise<TimelineHighlightState>
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

    async waitForTableLoaded(tableName: string, expectedRowCount?: number, timeout: number = 30000): Promise<void> {
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
        { timeout }
      )
    },

    async runQuery(sql: string): Promise<Record<string, unknown>[]> {
      return page.evaluate(async (sql) => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { query: (sql: string) => Promise<Record<string, unknown>[]>; isReady: boolean } }).__CLEANSLATE_DUCKDB__
        if (!duckdb?.query) throw new Error('DuckDB not available')
        return duckdb.query(sql)
      }, sql)
    },

    async getDiffState(): Promise<DiffStoreState> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.diffStore) {
          return { isComparing: false, summary: null, mode: 'compare-preview' }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.diffStore as any).getState()
        return {
          isComparing: state?.isComparing || false,
          summary: state?.summary || null,
          mode: state?.mode || 'compare-preview',
        }
      })
    },

    async getEditDirtyState(): Promise<EditDirtyState> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.editStore) {
          return { hasDirtyEdits: false, dirtyCount: 0 }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.editStore as any).getState()
        // editStore uses dirtyCells (Map), not dirtyPositions
        const dirtyCells = state?.dirtyCells
        return {
          hasDirtyEdits: dirtyCells?.size > 0,
          dirtyCount: dirtyCells?.size || 0,
        }
      })
    },

    async getTimelinePosition(tableId?: string): Promise<TimelinePositionState> {
      return page.evaluate(({ tableId }) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore || !stores?.tableStore) {
          return { current: -1, total: 0 }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tableState = (stores.tableStore as any).getState()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timelineState = (stores.timelineStore as any).getState()
        const activeTableId = tableId || tableState?.activeTableId
        const timeline = timelineState?.timelines?.get?.(activeTableId)
        return {
          current: timeline?.currentPosition ?? -1,
          total: timeline?.commands?.length ?? 0,
        }
      }, { tableId })
    },

    async getTimelineHighlight(): Promise<TimelineHighlightState> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) {
          return { commandId: null, rowCount: 0, rowIds: [], columnCount: 0, diffMode: 'none' }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        const highlight = state?.highlight
        return {
          commandId: highlight?.commandId || null,
          rowCount: highlight?.rowIds?.size || 0,
          rowIds: Array.from(highlight?.rowIds || []),  // NEW: Expose actual row IDs
          columnCount: highlight?.highlightedColumns?.size || 0,
          diffMode: highlight?.diffMode || 'none',
        }
      })
    },
  }
}
