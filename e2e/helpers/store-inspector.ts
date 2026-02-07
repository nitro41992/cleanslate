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

export interface RecipeStoreState {
  recipes: Array<{
    id: string
    name: string
    description: string
    version: string
    requiredColumns: string[]
    steps: Array<{
      id: string
      type: string
      label: string
      column?: string
      params?: Record<string, unknown>
      enabled: boolean
    }>
    createdAt: Date
    modifiedAt: Date
  }>
  selectedRecipeId: string | null
  isProcessing: boolean
  executionProgress: { currentStep: number; totalSteps: number; currentStepLabel: string } | null
  executionError: string | null
}

export interface TimelineDirtyCellsState {
  dirtyCells: string[]  // Array of "csId:columnName" keys
  count: number
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

export interface OPFSFileInfo {
  name: string
  size: number
}

export interface SnapshotManifest {
  version: number
  snapshotId: string
  totalRows: number
  totalBytes: number
  shardSize: number
  shards: Array<{
    index: number
    fileName: string
    rowCount: number
    byteSize: number
    minCsId: number | null
    maxCsId: number | null
  }>
  columns: string[]
  orderByColumn: string
  createdAt: number
}

export interface StoreInspector {
  getTables: () => Promise<TableInfo[]>
  /** Alias for getTables (backward compatibility) */
  getTableList: () => Promise<TableInfo[]>
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
   * Execute SQL statement without returning results (CREATE, INSERT, DROP, etc.)
   */
  runExecute: (sql: string) => Promise<void>
  /**
   * Check if undo is available for a table
   */
  canUndo: (tableId: string) => Promise<boolean>
  /**
   * Check if redo is available for a table
   */
  canRedo: (tableId: string) => Promise<boolean>
  /**
   * Get UI store state property
   */
  getUIState: (property: string) => Promise<unknown>
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
   * Save app state (timelines, UI state) to OPFS immediately
   * Must be called before page reload if transforms or UI state should persist
   */
  saveAppState: () => Promise<void>
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
  /**
   * Wait for snapshot persistence to complete (debounce + save).
   * The app auto-saves tables as Arrow IPC files with a 2-3 second debounce.
   * This helper waits for all pending saves to finish.
   * @param timeout - Optional timeout in milliseconds (default 10000)
   */
  waitForPersistenceComplete: (timeout?: number) => Promise<void>
  /**
   * Wait for timelines to be restored from OPFS after page reload.
   * Use this after waitForDuckDBReady() when testing timeline-dependent features.
   * @param tableId - Table ID to wait for timeline restoration
   * @param timeout - Optional timeout in milliseconds (default 10000)
   */
  waitForTimelinesRestored: (tableId: string, timeout?: number) => Promise<void>
  /**
   * Get dirty cells from the timeline store for a specific table.
   * Dirty cells are cells that have been manually edited.
   * @param tableId - Optional table ID (uses activeTableId if not specified)
   * @returns Array of dirty cell keys in format "csId:columnName"
   */
  getTimelineDirtyCells: (tableId?: string) => Promise<TimelineDirtyCellsState>
  /**
   * Disable cell edit batching for tests.
   * When batching is disabled, cell edits are executed immediately (no 500ms debounce).
   * Call this at the start of tests that expect immediate audit log entries.
   */
  disableEditBatching: () => Promise<void>
  /**
   * Flush any pending cell edits immediately.
   * Use this after making cell edits if you need to verify audit log entries.
   */
  flushEditBatch: () => Promise<void>
  /**
   * Wait for edit batch to be flushed (all pending edits committed).
   * @param timeout - Optional timeout in milliseconds (default 2000)
   */
  waitForEditBatchFlush: (timeout?: number) => Promise<void>
  /**
   * Get pending edits count for a specific table.
   * @param tableId - The table ID to check
   * @returns Number of pending (unbatched) edits
   */
  getPendingEditsCount: (tableId: string) => Promise<number>
  /**
   * Get recipe store state for recipe testing.
   * @returns Recipe store state including recipes, selection, processing, and error state
   */
  getRecipeState: () => Promise<RecipeStoreState>
  /**
   * Wait for recipe execution to complete.
   * Polls recipeStore.isProcessing to detect when execution finishes.
   * @param timeout - Optional timeout in milliseconds (default 30000)
   */
  waitForRecipeExecutionComplete: (timeout?: number) => Promise<void>
  /**
   * Enumerate OPFS snapshot files matching a snapshot ID prefix.
   * @param snapshotId - The snapshot ID prefix to match (e.g., table name)
   * @returns Array of file info objects with name and size
   */
  getOPFSSnapshotFiles: (snapshotId: string) => Promise<OPFSFileInfo[]>
  /**
   * Read and parse a manifest JSON file from OPFS snapshots directory.
   * @param snapshotId - The snapshot ID (e.g., table name)
   * @returns Parsed manifest object, or null if not found
   */
  getOPFSManifest: (snapshotId: string) => Promise<SnapshotManifest | null>
  /**
   * Wait for background materialization to complete.
   * Polls tableStore.materializingTables until empty (or specific table removed).
   * @param tableId - Optional specific table ID to wait for
   * @param timeout - Optional timeout in milliseconds (default 30000)
   */
  waitForMaterializationComplete: (tableId?: string, timeout?: number) => Promise<void>
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
      // Wait for ALL loading states to complete:
      // 1. "Initializing data engine..." - DuckDB WASM initialization
      // 2. "Restoring your workspace..." - OPFS restore phase
      // Both must complete before DuckDB is ready to accept queries
      await page.waitForFunction(
        () => {
          const bodyText = document.body.innerText
          // Check for any loading state that blocks DuckDB queries
          const isInitializing = bodyText.includes('Initializing data engine')
          const isRestoring = bodyText.includes('Restoring your workspace')
          return !isInitializing && !isRestoring
        },
        { timeout: 60000 }  // Increased timeout for OPFS restore
      )
      // Also ensure the stores are exposed
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          return stores?.tableStore !== undefined
        },
        { timeout: 30000 }
      )
      // CRITICAL: Wait for DuckDB isReady flag (set after initDuckDB() completes in main.tsx)
      // This prevents "duckdb is not initialized" errors from COI bundle changes and race conditions
      await page.waitForFunction(
        () => {
          const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { isReady: boolean } }).__CLEANSLATE_DUCKDB__
          return duckdb?.isReady === true
        },
        { timeout: 30000 }
      )
      // CRITICAL: Verify DuckDB is truly ready by executing a test query
      // The isReady flag can be set before the WebWorker connection is fully initialized
      // This test query ensures the WASM connection is actually ready to accept queries
      await page.waitForFunction(
        async () => {
          try {
            const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { query: (sql: string) => Promise<unknown>; isReady: boolean } }).__CLEANSLATE_DUCKDB__
            if (!duckdb?.query || !duckdb.isReady) return false
            await duckdb.query('SELECT 1')
            return true
          } catch {
            return false
          }
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

    async saveAppState(): Promise<void> {
      await page.evaluate(async () => {
        const persistence = (window as Window & { __CLEANSLATE_PERSISTENCE__?: { saveNow: () => Promise<void> } }).__CLEANSLATE_PERSISTENCE__
        if (persistence?.saveNow) {
          await persistence.saveNow()
        } else {
          throw new Error('Persistence module not available')
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

async getTableList(): Promise<TableInfo[]> {
      // Alias for getTables (backward compatibility)
      return this.getTables()
    },

    async runExecute(sql: string): Promise<void> {
      await page.evaluate(async (sql) => {
        const duckdb = (window as Window & { __CLEANSLATE_DUCKDB__?: { execute: (sql: string) => Promise<void>; isReady: boolean } }).__CLEANSLATE_DUCKDB__
        if (!duckdb?.execute) throw new Error('DuckDB not available')
        return duckdb.execute(sql)
      }, sql)
    },

    async canUndo(tableId: string): Promise<boolean> {
      return page.evaluate((id) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        const timeline = state?.timelines?.get?.(id)
        return timeline?.currentPosition >= 0
      }, tableId)
    },

    async canRedo(tableId: string): Promise<boolean> {
      return page.evaluate((id) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        const timeline = state?.timelines?.get?.(id)
        if (!timeline) return false
        return timeline.currentPosition < timeline.commands.length - 1
      }, tableId)
    },

    async getUIState(property: string): Promise<unknown> {
      return page.evaluate((prop) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return state?.[prop]
      }, property)
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

    async waitForPersistenceComplete(timeout = 10000): Promise<void> {
      // Wait for snapshot persistence to complete
      // The app uses a 2-3 second debounce before auto-saving
      //
      // Two-phase wait:
      // 1. First wait for dirty state to be acknowledged (subscription fires)
      // 2. Then wait for save to complete (status becomes 'saved' or back to 'idle')

      // Phase 1: Wait briefly for the subscription to fire and mark table dirty
      // This prevents returning early if we check before the store subscription runs
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.uiStore) return true
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.uiStore as any).getState()
          const status = state?.persistenceStatus
          // Wait until we see dirty, saving, or saved (not initial idle)
          return status === 'dirty' || status === 'saving' || status === 'saved'
        },
        { timeout: 5000 }
      ).catch(() => {
        // If no dirty state after 5s, maybe nothing to persist - that's OK
      })

      // Phase 2: Now wait for persistence to complete
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.uiStore) return true
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.uiStore as any).getState()
          const status = state?.persistenceStatus
          const dirtyTableIds = state?.dirtyTableIds
          const hasDirtyTables = dirtyTableIds?.size > 0
          // Complete when: saved, or idle with no dirty tables
          return status === 'saved' || (status === 'idle' && !hasDirtyTables)
        },
        { timeout }
      )
    },

    async waitForTimelinesRestored(tableId: string, timeout = 10000): Promise<void> {
      // Wait for timeline store to have a timeline with commands for any table
      // This is needed after page reload because loadTimelines() runs after initDuckDB()
      // Note: tableId parameter kept for API compatibility but we wait for any timeline
      // since tableIds might be regenerated during reload
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.timelineStore) return false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const timelineState = (stores.timelineStore as any).getState()
          const timelines = timelineState?.timelines
          if (!timelines || timelines.size === 0) return false
          // Check if any timeline has commands (meaning it was restored)
          for (const timeline of timelines.values()) {
            if (timeline.commands && timeline.commands.length > 0) {
              return true
            }
          }
          return false
        },
        { timeout }
      )
    },

    async getTimelineDirtyCells(tableId?: string): Promise<TimelineDirtyCellsState> {
      return page.evaluate(({ tableId }) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore || !stores?.tableStore) {
          return { dirtyCells: [], count: 0 }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tableState = (stores.tableStore as any).getState()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timelineState = (stores.timelineStore as any).getState()
        const activeTableId = tableId || tableState?.activeTableId
        if (!activeTableId) {
          return { dirtyCells: [], count: 0 }
        }
        const dirtyCells = timelineState?.getDirtyCellsAtPosition?.(activeTableId) || new Set()
        return {
          dirtyCells: Array.from(dirtyCells) as string[],
          count: dirtyCells.size,
        }
      }, { tableId })
    },

    async disableEditBatching(): Promise<void> {
      await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (stores?.setBatchWindow) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (stores.setBatchWindow as any)(0)
        }
      })
    },

    async flushEditBatch(): Promise<void> {
      await page.evaluate(async () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (stores?.editBatchStore) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.editBatchStore as any).getState()
          if (state?.flushAll) {
            await state.flushAll()
          }
        }
      })
    },

    async waitForEditBatchFlush(timeout = 2000): Promise<void> {
      // Wait for pending edits to be flushed
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.editBatchStore) return true  // No batch store = nothing to wait for
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.editBatchStore as any).getState()
          // Check that no tables have pending edits
          return state?.pendingEdits?.size === 0
        },
        { timeout }
      )
    },

    async getPendingEditsCount(tableId: string): Promise<number> {
      return page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.editBatchStore) return 0
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.editBatchStore as any).getState()
        const pendingEdits = state?.pendingEdits?.get(tid)
        return pendingEdits?.length ?? 0
      }, tableId)
    },

    async getRecipeState(): Promise<RecipeStoreState> {
      return page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.recipeStore) {
          return {
            recipes: [],
            selectedRecipeId: null,
            isProcessing: false,
            executionProgress: null,
            executionError: null,
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.recipeStore as any).getState()
        return {
          recipes: state?.recipes || [],
          selectedRecipeId: state?.selectedRecipeId ?? null,
          isProcessing: state?.isProcessing ?? false,
          executionProgress: state?.executionProgress ?? null,
          executionError: state?.executionError ?? null,
        }
      })
    },

    async waitForRecipeExecutionComplete(timeout = 30000): Promise<void> {
      await page.waitForFunction(
        () => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.recipeStore) return true  // No recipe store = nothing to wait for
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.recipeStore as any).getState()
          // Wait for isProcessing to become false
          return state?.isProcessing === false
        },
        { timeout }
      )
    },

    async getOPFSSnapshotFiles(snapshotId: string): Promise<OPFSFileInfo[]> {
      return page.evaluate(async (prefix) => {
        const files: { name: string; size: number }[] = []
        try {
          const root = await navigator.storage.getDirectory()
          const appDir = await root.getDirectoryHandle('cleanslate')
          const snapshots = await appDir.getDirectoryHandle('snapshots')
          // entries() exists at runtime but TypeScript's lib doesn't include it
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for await (const [name, handle] of (snapshots as any).entries()) {
            if (handle.kind === 'file' && name.startsWith(prefix)) {
              const file = await handle.getFile()
              files.push({ name, size: file.size })
            }
          }
        } catch {
          // OPFS not available or directory missing
        }
        return files
      }, snapshotId)
    },

    async getOPFSManifest(snapshotId: string): Promise<SnapshotManifest | null> {
      return page.evaluate(async (id) => {
        try {
          const root = await navigator.storage.getDirectory()
          const appDir = await root.getDirectoryHandle('cleanslate')
          const snapshots = await appDir.getDirectoryHandle('snapshots')
          const handle = await snapshots.getFileHandle(`${id}_manifest.json`)
          const file = await handle.getFile()
          const text = await file.text()
          return JSON.parse(text)
        } catch {
          return null
        }
      }, snapshotId) as Promise<SnapshotManifest | null>
    },

    async waitForMaterializationComplete(tableId?: string, timeout = 30000): Promise<void> {
      await page.waitForFunction(
        ({ tableId }) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return true
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (stores.tableStore as any).getState()
          const materializing: Set<string> = state?.materializingTables
          if (!materializing || materializing.size === 0) return true
          if (tableId) return !materializing.has(tableId)
          return materializing.size === 0
        },
        { tableId },
        { timeout }
      )
    },
  }
}
