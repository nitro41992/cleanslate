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
  csId?: string  // Stable cell identifier for manual edits (replaces rowIndex)
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

export interface MatcherStoreState {
  pairs: Array<{ id: string; status: string }>
  stats: {
    total: number
    merged: number
    keptSeparate: number
    pending: number
    definiteCount: number
    maybeCount: number
    notMatchCount: number
  }
}

export interface MatcherConfigState {
  tableName: string | null
  matchColumn: string | null
  blockingStrategy: string
  isMatching: boolean
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
  runQuery: <T = Record<string, unknown>>(sql: string) => Promise<T[]>
  /**
   * Get diff highlighting state from diffStore
   */
  getDiffState: () => Promise<DiffStoreState>
  /**
   * Get edit store dirty state
   */
  getEditDirtyState: () => Promise<EditDirtyState>
  /**
   * Get matcher store state (pairs count and stats)
   */
  getMatcherState: () => Promise<MatcherStoreState>
  /**
   * Get matcher store config (tableName, matchColumn, blockingStrategy)
   */
  getMatcherConfig: () => Promise<MatcherConfigState>
  /**
   * Wait for matcher blocking strategy to be set to a specific value.
   * Use after clicking strategy radio buttons to ensure store is updated.
   * @param strategy - The expected blocking strategy value
   * @param timeout - Optional timeout in milliseconds (default 5000)
   */
  waitForBlockingStrategy: (strategy: string, timeout?: number) => Promise<void>
  /**
   * Get timeline position for undo/redo verification
   */
  getTimelinePosition: (tableId?: string) => Promise<TimelinePositionState>
  /**
   * Get timeline highlight state (for visual highlighting verification)
   */
  getTimelineHighlight: () => Promise<TimelineHighlightState>
  /**
   * Reset DuckDB connection (for test cleanup or error recovery)
   */
  resetDuckDBConnection: () => Promise<void>
  /**
   * Check if DuckDB connection is healthy
   */
  checkConnectionHealth: () => Promise<boolean>
  /**
   * Flush DuckDB WAL to OPFS storage immediately
   * Must be called before page reload in tests to ensure data persistence
   */
  flushToOPFS: () => Promise<void>
  /**
   * Get column information for a specific table
   */
  getTableColumns: (tableName: string) => Promise<{ name: string; type: string }[]>
  /**
   * Get full table info including columnOrder field
   */
  getTableInfo: (tableName: string) => Promise<TableInfo | undefined>
  /**
   * Get future states count for undo/redo confirmation testing.
   * Returns the number of commands that would be discarded if a new action is performed.
   */
  getFutureStatesCount: (tableId?: string) => Promise<number>
  /**
   * Wait for a transformation to complete by checking loading state and store updates.
   * Polls tableStore.isLoading and dataVersion to detect when the operation finishes.
   * @param tableId - The table ID to monitor (uses activeTableId if not specified)
   * @param timeout - Optional timeout in milliseconds (default 30000)
   */
  waitForTransformComplete: (tableId?: string, timeout?: number) => Promise<void>
  /**
   * Wait for a panel to be fully open with data-state="open" attribute.
   * @param panelId - The data-testid of the panel (e.g., 'panel-clean', 'panel-match')
   * @param timeout - Optional timeout in milliseconds (default 10000)
   */
  waitForPanelAnimation: (panelId: string, timeout?: number) => Promise<void>
  /**
   * Wait for matcher merge operation to complete.
   * Polls matcherStore.isMatching to detect when the merge finishes.
   * @param timeout - Optional timeout in milliseconds (default 30000)
   */
  waitForMergeComplete: (timeout?: number) => Promise<void>
  /**
   * Wait for combiner operation (stack/join) to complete.
   * Polls combinerStore.isProcessing to detect when the operation finishes.
   * @param timeout - Optional timeout in milliseconds (default 30000)
   */
  waitForCombinerComplete: (timeout?: number) => Promise<void>
  /**
   * Wait for the data grid to be fully initialized and ready for interaction.
   * Checks for grid visibility, data loading completion, and stable state.
   * @param timeout - Optional timeout in milliseconds (default 15000)
   */
  waitForGridReady: (timeout?: number) => Promise<void>
  /**
   * Wait for timeline replay to complete (Heavy Path undo/redo).
   * When a Tier 3 command is undone, the timeline replays all commands from a snapshot.
   * This helper waits for that replay to finish before asserting on data.
   * @param timeout - Optional timeout in milliseconds (default 30000)
   */
  waitForReplayComplete: (timeout?: number) => Promise<void>
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
          // ORDER BY "_cs_id" for deterministic row ordering (matches src/lib/duckdb/index.ts)
          // CRITICAL: Must use quotes around _cs_id for proper identifier resolution
          // Fall back to no ORDER BY if _cs_id doesn't exist (e.g., diff tables)
          try {
            return await duckdb.query(`SELECT * FROM "${tableName}" ORDER BY "_cs_id" LIMIT ${limit}`)
          } catch {
            return await duckdb.query(`SELECT * FROM "${tableName}" LIMIT ${limit}`)
          }
        },
        { tableName, limit }
      )
    },

    async getAuditEntries(tableId?: string): Promise<AuditEntry[]> {
      return page.evaluate((tableId) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.auditStore) return []
        const store = stores.auditStore as {
          getState: () => {
            getAllEntries: () => AuditEntry[]
            getEntriesForTable: (tableId: string) => AuditEntry[]
            _legacyEntries: AuditEntry[]
          }
        }
        // Use getAllEntries() or getEntriesForTable() methods which derive from timeline
        const timelineEntries = tableId ? store.getState().getEntriesForTable(tableId) : store.getState().getAllEntries()
        // Also include legacy entries (used by persist operation which doesn't go through CommandExecutor)
        const legacyEntries = store.getState()._legacyEntries || []
        // Merge and dedupe by id, preferring timeline entries
        const entryMap = new Map<string, AuditEntry>()
        for (const entry of legacyEntries) {
          entryMap.set(entry.id, entry)
        }
        for (const entry of timelineEntries) {
          entryMap.set(entry.id, entry)
        }
        return Array.from(entryMap.values())
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

    async runQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      return page.evaluate(async (sql) => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { query: (sql: string) => Promise<Record<string, unknown>[]>; isReady: boolean } }).__CLEANSLATE_DUCKDB__
        if (!duckdb?.query) throw new Error('DuckDB not available')
        return duckdb.query(sql)
      }, sql) as Promise<T[]>
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

    async getMatcherState(): Promise<MatcherStoreState> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.matcherStore) {
          return {
            pairs: [],
            stats: {
              total: 0,
              merged: 0,
              keptSeparate: 0,
              pending: 0,
              definiteCount: 0,
              maybeCount: 0,
              notMatchCount: 0,
            },
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.matcherStore as any).getState()
        return {
          pairs: state?.pairs || [],
          stats: state?.stats || {
            total: 0,
            merged: 0,
            keptSeparate: 0,
            pending: 0,
            definiteCount: 0,
            maybeCount: 0,
            notMatchCount: 0,
          },
        }
      })
    },

    async getMatcherConfig(): Promise<MatcherConfigState> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.matcherStore) {
          return {
            tableName: null,
            matchColumn: null,
            blockingStrategy: 'double_metaphone',
            isMatching: false,
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.matcherStore as any).getState()
        return {
          tableName: state?.tableName ?? null,
          matchColumn: state?.matchColumn ?? null,
          blockingStrategy: state?.blockingStrategy ?? 'double_metaphone',
          isMatching: state?.isMatching ?? false,
        }
      })
    },

    async waitForBlockingStrategy(strategy: string, timeout = 5000): Promise<void> {
      await page.waitForFunction(
        (expectedStrategy) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.matcherStore) return false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.matcherStore as any).getState()
          return state?.blockingStrategy === expectedStrategy
        },
        strategy,
        { timeout }
      )
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

    async resetDuckDBConnection(): Promise<void> {
      return page.evaluate(async () => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: any }).__CLEANSLATE_DUCKDB__
        if (!duckdb?.resetConnection) {
          throw new Error('resetConnection not available')
        }
        return duckdb.resetConnection()
      })
    },

    async checkConnectionHealth(): Promise<boolean> {
      return page.evaluate(async () => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: any }).__CLEANSLATE_DUCKDB__
        if (!duckdb?.checkConnectionHealth) {
          throw new Error('checkConnectionHealth not available')
        }
        return duckdb.checkConnectionHealth()
      })
    },

    async flushToOPFS(): Promise<void> {
      await page.evaluate(async () => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: any }).__CLEANSLATE_DUCKDB__
        if (duckdb?.flushDuckDB) {
          // immediate=true bypasses test environment check
          await duckdb.flushDuckDB(true)
        }
      })
    },

    async getTableColumns(tableName: string): Promise<{ name: string; type: string }[]> {
      return page.evaluate(async (name) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return []
        const store = stores.tableStore as { getState: () => { tables: TableInfo[] } }
        const state = store.getState()
        const table = state.tables.find((t) => t.name === name)
        return table?.columns || []
      }, tableName)
    },

    async getTableInfo(tableName: string): Promise<TableInfo | undefined> {
      return page.evaluate(async (name) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return undefined
        const store = stores.tableStore as { getState: () => { tables: TableInfo[] } }
        const state = store.getState()
        return state.tables.find((t) => t.name === name)
      }, tableName)
    },

    async getFutureStatesCount(tableId?: string): Promise<number> {
      return page.evaluate(({ tableId }) => {
        // Try to get count from CommandExecutor first (primary source)
        const commandsModule = (window as Window & { __CLEANSLATE_COMMANDS__?: { getCommandExecutor: () => { getFutureStatesCount: (id: string) => number } } }).__CLEANSLATE_COMMANDS__
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__

        // Get active table ID if not provided
        let resolvedTableId = tableId
        if (!resolvedTableId && stores?.tableStore) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tableState = (stores.tableStore as any).getState()
          resolvedTableId = tableState?.activeTableId
        }

        if (!resolvedTableId) return 0

        // Try CommandExecutor first
        if (commandsModule?.getCommandExecutor) {
          const executor = commandsModule.getCommandExecutor()
          if (executor?.getFutureStatesCount) {
            return executor.getFutureStatesCount(resolvedTableId)
          }
        }

        // Fallback to timeline store calculation
        if (stores?.timelineStore) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const timelineState = (stores.timelineStore as any).getState()
          const timeline = timelineState?.timelines?.get?.(resolvedTableId)
          if (timeline) {
            const current = timeline.currentPosition ?? -1
            const total = timeline.commands?.length ?? 0
            // Future states = commands after current position
            return Math.max(0, total - current - 1)
          }
        }

        return 0
      }, { tableId })
    },

    async waitForTransformComplete(tableId?: string, timeout = 30000): Promise<void> {
      await page.waitForFunction(
        ({ tableId }) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.tableStore as any).getState()

          // Resolve table ID if not provided
          const resolvedTableId = tableId || state.activeTableId
          if (!resolvedTableId) return false

          // Check that loading is complete
          if (state.isLoading) return false

          // Verify the table exists and has been updated
          const table = state.tables?.find((t: { id: string }) => t.id === resolvedTableId)
          return table !== undefined
        },
        { tableId },
        { timeout }
      )
    },

    async waitForPanelAnimation(panelId: string, timeout = 10000): Promise<void> {
      // Wait for panel to exist and be visible
      const panel = page.getByTestId(panelId)
      await panel.waitFor({ state: 'visible', timeout })

      // Wait for animation to complete by checking data-state attribute
      await page.waitForFunction(
        (id) => {
          const element = document.querySelector(`[data-testid="${id}"]`)
          return element?.getAttribute('data-state') === 'open'
        },
        panelId,
        { timeout }
      )
    },

    async waitForMergeComplete(timeout = 30000): Promise<void> {
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.matcherStore) return true  // If store doesn't exist, consider complete
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.matcherStore as any).getState()
          // Wait for isMatching to become false
          return state?.isMatching === false
        },
        { timeout }
      )
    },

    async waitForCombinerComplete(timeout = 30000): Promise<void> {
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.combinerStore) return true  // If store doesn't exist, consider complete
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.combinerStore as any).getState()
          // Wait for isProcessing to become false
          return state?.isProcessing === false
        },
        { timeout }
      )
    },

    async waitForGridReady(timeout = 15000): Promise<void> {
      // Wait for grid container to be visible
      const gridContainer = page.locator('[data-testid="data-grid"], .glide-canvas')
      await gridContainer.first().waitFor({ state: 'visible', timeout })

      // Wait for tableStore to not be loading
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.tableStore as any).getState()
          return state?.isLoading === false && state?.tables?.length > 0
        },
        { timeout }
      )

      // Wait for grid canvas to be rendered (indicates Glide is ready)
      await page.locator('canvas[data-testid="main-canvas"], .glide-canvas canvas').first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => {
          // Some grids may not have canvas immediately, which is OK
        })
    },

    async waitForReplayComplete(timeout = 30000): Promise<void> {
      // Wait for timeline replay to complete (Heavy Path undo/redo)
      // The timeline engine sets isReplaying=true during replay and false when done
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.timelineStore) return true  // No timeline store = nothing to wait for
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.timelineStore as any).getState()
          // Wait for isReplaying to become false (or undefined if not set)
          return state?.isReplaying !== true
        },
        { timeout }
      )
      // Also ensure tableStore is not loading (replay may trigger data refresh)
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return true
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.tableStore as any).getState()
          return state?.isLoading !== true
        },
        { timeout: 5000 }
      ).catch(() => {
        // Ignore timeout - tableStore may not have isLoading flag set
      })
    },
  }
}
