/**
 * Application State Persistence System
 *
 * Saves React application state (table metadata, timelines, UI preferences) to OPFS
 * as JSON, enabling workspace restoration across page refreshes.
 *
 * DuckDB tables and Parquet snapshots persist separately via cleanslate.db
 * This module only handles application-level metadata.
 */

import { query, getTableColumns } from '@/lib/duckdb'
import { generateId } from '@/lib/utils'
import type { TableInfo, ColumnInfo, SerializedTableTimeline, LastEditLocation, SerializedRecipe, Recipe } from '@/types'

/**
 * Application state schema version 2 (legacy)
 */
export interface AppStateV2 {
  version: 2
  lastUpdated: string
  tables: TableInfo[]
  activeTableId: string | null
  timelines: SerializedTableTimeline[]
  uiPreferences: {
    sidebarCollapsed: boolean
  }
}

/**
 * Application state schema version 3 (legacy)
 * - Added lastEdit to uiPreferences for gutter indicator persistence
 */
export interface AppStateV3 {
  version: 3
  lastUpdated: string
  tables: TableInfo[]
  activeTableId: string | null
  timelines: SerializedTableTimeline[]
  uiPreferences: {
    sidebarCollapsed: boolean
    lastEdit: LastEditLocation | null
  }
}

/**
 * Application state schema version 4
 * - Added recipes for recipe template persistence (FR-G)
 */
export interface AppStateV4 {
  version: 4
  lastUpdated: string
  tables: TableInfo[]
  activeTableId: string | null
  timelines: SerializedTableTimeline[]
  recipes: SerializedRecipe[]
  uiPreferences: {
    sidebarCollapsed: boolean
    lastEdit: LastEditLocation | null
  }
}

const STORAGE_DIR = 'cleanslate'
const APP_STATE_FILE = 'app-state.json'
const SCHEMA_VERSION = 4

/**
 * Get the OPFS root directory handle
 */
async function getOPFSRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(STORAGE_DIR, { create: true })
  } catch (error) {
    console.warn('[Persistence] OPFS not available:', error)
    return null
  }
}

/**
 * Save application state to OPFS
 * Called by debounced store subscriptions after user actions
 */
/**
 * Compact timeline commands to reduce memory and storage.
 * - Clears large arrays (affectedRowIds, cellChanges) from old commands
 * - Preserves rowsAffected count for audit display
 */
function compactTimelines(timelines: SerializedTableTimeline[]): SerializedTableTimeline[] {
  const KEEP_FULL_COMMANDS = 10 // Keep full data for last 10 commands per timeline

  return timelines.map(timeline => {
    const currentPos = timeline.currentPosition
    const compactedCommands = timeline.commands.map((cmd, index) => {
      const isRecent = index >= currentPos - KEEP_FULL_COMMANDS && index <= currentPos

      if (isRecent) {
        return cmd // Keep recent commands intact for highlighting
      }

      // Compact old commands by clearing large arrays
      const compacted = { ...cmd }

      // Store rowsAffected count before clearing, if not already set
      if (compacted.affectedRowIds && compacted.affectedRowIds.length > 0) {
        if (compacted.rowsAffected === undefined) {
          compacted.rowsAffected = compacted.affectedRowIds.length
        }
        compacted.affectedRowIds = undefined
      }

      // Clear cellChanges from old commands (can be very large for batch edits)
      if (compacted.cellChanges && compacted.cellChanges.length > 0) {
        compacted.cellChanges = undefined
      }

      return compacted
    })

    return {
      ...timeline,
      commands: compactedCommands,
    }
  })
}

export async function saveAppState(
  tables: TableInfo[],
  activeTableId: string | null,
  timelines: SerializedTableTimeline[],
  sidebarCollapsed: boolean,
  lastEdit: LastEditLocation | null = null,
  recipes: Recipe[] = []
): Promise<void> {
  const root = await getOPFSRoot()
  if (!root) {
    console.warn('[Persistence] Cannot save state - OPFS unavailable')
    return
  }

  try {
    // Compact timelines to reduce storage and memory on reload
    const compactedTimelines = compactTimelines(timelines)

    // Serialize TableInfo (convert Dates to ISO strings)
    const serializedTables = tables.map(table => ({
      ...table,
      createdAt: table.createdAt.toISOString(),
      updatedAt: table.updatedAt.toISOString(),
      lineage: table.lineage ? {
        ...table.lineage,
        checkpointedAt: table.lineage.checkpointedAt.toISOString(),
        transformations: table.lineage.transformations.map(t => ({
          ...t,
          timestamp: t.timestamp.toISOString(),
        })),
      } : undefined,
    }))

    // Serialize recipes (convert Dates to ISO strings)
    const serializedRecipes: SerializedRecipe[] = recipes.map(recipe => ({
      ...recipe,
      createdAt: recipe.createdAt.toISOString(),
      modifiedAt: recipe.modifiedAt.toISOString(),
    }))

    const state: AppStateV4 = {
      version: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),
      tables: serializedTables as unknown as TableInfo[],
      activeTableId,
      timelines: compactedTimelines,
      recipes: serializedRecipes,
      uiPreferences: {
        sidebarCollapsed,
        lastEdit,
      },
    }

    // BigInt replacer - convert BigInt to string with "n" suffix for later parsing
    const bigIntReplacer = (_key: string, value: unknown) => {
      if (typeof value === 'bigint') {
        return value.toString() + 'n'
      }
      return value
    }

    const fileHandle = await root.getFileHandle(APP_STATE_FILE, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(state, bigIntReplacer, 2))
    await writable.close()

    console.log('[Persistence] App state saved:', {
      tables: tables.length,
      timelines: timelines.length,
      recipes: recipes.length,
      activeTableId,
    })
  } catch (error) {
    if ((error as { name?: string }).name === 'QuotaExceededError') {
      console.error('[Persistence] Storage quota exceeded')
      // Don't throw - allow app to continue running
    } else {
      console.error('[Persistence] Failed to save app state:', error)
      throw error
    }
  }
}

/**
 * Restore application state from OPFS
 * Called after DuckDB initialization completes
 * Returns null if no saved state exists (fresh start)
 */
export async function restoreAppState(): Promise<AppStateV4 | null> {
  const root = await getOPFSRoot()
  if (!root) {
    console.log('[Persistence] OPFS unavailable - starting fresh')
    return null
  }

  try {
    const fileHandle = await root.getFileHandle(APP_STATE_FILE)
    const file = await fileHandle.getFile()
    const text = await file.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state = JSON.parse(text) as any

    // Handle v2 → v3 migration
    if (state.version === 2) {
      console.log('[Persistence] Migrating from V2 to V3')
      state = {
        ...state,
        version: 3,
        uiPreferences: {
          ...state.uiPreferences,
          lastEdit: null,
        },
      }
    }

    // Handle v3 → v4 migration (add recipes)
    if (state.version === 3) {
      console.log('[Persistence] Migrating from V3 to V4')
      state = {
        ...state,
        version: 4,
        recipes: [],
      } as AppStateV4
    }

    // Validate schema version
    if (state.version !== SCHEMA_VERSION) {
      console.warn(`[Persistence] Schema version mismatch (got ${state.version}, expected ${SCHEMA_VERSION})`)
      await clearAppState()
      return null
    }

    console.log('[Persistence] App state loaded:', {
      tables: state.tables.length,
      timelines: state.timelines.length,
      recipes: state.recipes?.length ?? 0,
      activeTableId: state.activeTableId,
    })

    // Reconcile metadata with DuckDB reality
    const reconciledTables = await reconcileTablesWithDuckDB(state.tables)

    return {
      ...state,
      tables: reconciledTables,
    }
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFoundError') {
      console.log('[Persistence] No saved state found - starting fresh')
      return null
    }

    // Corrupted JSON or other error
    console.warn('[Persistence] Corrupted app-state.json, starting fresh:', error)
    await clearAppState()
    return null
  }
}

/**
 * Reconcile metadata with actual DuckDB tables
 * Handles orphaned metadata (table deleted) and orphaned tables (metadata missing)
 */
async function reconcileTablesWithDuckDB(tables: TableInfo[]): Promise<TableInfo[]> {
  // Helper to deserialize dates from JSON strings
  const deserializeTable = (table: TableInfo): TableInfo => ({
    ...table,
    createdAt: new Date(table.createdAt as unknown as string),
    updatedAt: new Date(table.updatedAt as unknown as string),
    lineage: table.lineage ? {
      ...table.lineage,
      checkpointedAt: new Date(table.lineage.checkpointedAt as unknown as string),
      transformations: table.lineage.transformations.map(t => ({
        ...t,
        timestamp: new Date(t.timestamp as unknown as string),
      })),
    } : undefined,
  })

  try {
    // Get list of user tables from DuckDB (exclude internal tables)
    const duckdbTables = await query<{ table_name: string }>(
      `SELECT table_name
       FROM duckdb_tables()
       WHERE NOT internal
       AND table_name NOT LIKE '_timeline%'
       AND table_name NOT LIKE '_audit%'
       AND table_name NOT LIKE '_diff%'`
    )

    const duckdbTableNames = new Set(duckdbTables.map(t => t.table_name))

    // CRITICAL: If DuckDB is empty, skip reconciliation and preserve original metadata.
    // At startup with Parquet persistence, DuckDB starts empty. The Parquet files are
    // imported AFTER restoreAppState() runs (in usePersistence.hydrate()). Without this
    // check, all tables would be incorrectly marked as "orphan metadata" and removed,
    // breaking activeTableId restoration and timeline matching.
    if (duckdbTableNames.size === 0 && tables.length > 0) {
      console.log(`[Persistence] DuckDB empty - preserving ${tables.length} table(s) from app-state.json for Parquet import`)
      return tables.map(deserializeTable)
    }

    const validTables: TableInfo[] = []
    const metadataTableNames = new Set<string>()

    // Check metadata tables against DuckDB
    for (const table of tables) {
      metadataTableNames.add(table.name)

      if (duckdbTableNames.has(table.name)) {
        // Table exists in both - keep metadata with deserialized dates
        validTables.push(deserializeTable(table))
      } else {
        // Orphan metadata (table deleted from DuckDB)
        console.warn(`[Persistence] Removing orphan metadata for '${table.name}'`)
      }
    }

    // Check for orphan DuckDB tables (not in metadata)
    for (const { table_name } of duckdbTables) {
      if (!metadataTableNames.has(table_name)) {
        console.warn(`[Persistence] Orphan table '${table_name}' found, creating metadata`)
        const metadata = await createMetadataFromDuckDB(table_name)
        if (metadata) {
          validTables.push(metadata)
        }
      }
    }

    console.log(`[Persistence] Reconciliation: ${tables.length} metadata tables, ${duckdbTableNames.size} DuckDB tables, ${validTables.length} valid`)

    return validTables
  } catch (error) {
    console.error('[Persistence] Reconciliation failed:', error)
    // Return original tables if reconciliation fails
    return tables.map(deserializeTable)
  }
}

/**
 * Create minimal TableInfo metadata from DuckDB introspection
 * Used when DuckDB table exists but metadata is missing (orphan table)
 */
async function createMetadataFromDuckDB(tableName: string): Promise<TableInfo | null> {
  try {
    // Get columns
    const columns = await getTableColumns(tableName)
    const columnInfos: ColumnInfo[] = columns.map(col => ({
      name: col.name,
      type: col.type,
      nullable: true, // Conservative default
    }))

    // Get row count
    const rowCountResult = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${tableName}"`
    )
    const rowCount = Number(rowCountResult[0].count)

    // Create minimal metadata
    const now = new Date()
    const metadata: TableInfo = {
      id: generateId(),
      name: tableName,
      columns: columnInfos,
      rowCount,
      createdAt: now,
      updatedAt: now,
      dataVersion: 0,
      columnOrder: columnInfos
        .filter(c => !c.name.startsWith('_cs_') && !c.name.startsWith('__'))
        .map(c => c.name),
    }

    console.log(`[Persistence] Created metadata for orphan table '${tableName}' (${rowCount} rows)`)
    return metadata
  } catch (error) {
    console.error(`[Persistence] Failed to create metadata for '${tableName}':`, error)
    return null
  }
}

/**
 * Clear saved application state
 * Used when corruption detected or user wants fresh start
 */
export async function clearAppState(): Promise<void> {
  const root = await getOPFSRoot()
  if (!root) return

  try {
    await root.removeEntry(APP_STATE_FILE)
    console.log('[Persistence] App state cleared')
  } catch (error) {
    if ((error as { name?: string }).name !== 'NotFoundError') {
      console.warn('[Persistence] Failed to clear app state:', error)
    }
  }
}

/**
 * Save current application state immediately (bypasses debounce)
 * Exported for debugging and manual triggers
 */
export async function saveAppStateNow(): Promise<void> {
  try {
    // Dynamically import stores to avoid circular dependencies
    const { useTableStore } = await import('@/stores/tableStore')
    const { useTimelineStore } = await import('@/stores/timelineStore')
    const { useUIStore } = await import('@/stores/uiStore')
    const { useRecipeStore } = await import('@/stores/recipeStore')

    const tableState = useTableStore.getState()
    const timelineState = useTimelineStore.getState()
    const uiState = useUIStore.getState()
    const recipeState = useRecipeStore.getState()

    console.log('[Persistence] Manual save triggered:', {
      tables: tableState.tables.length,
      recipes: recipeState.recipes.length,
      activeTableId: tableState.activeTableId,
    })

    await saveAppState(
      tableState.tables,
      tableState.activeTableId,
      timelineState.getSerializedTimelines(),
      uiState.sidebarCollapsed,
      uiState.lastEdit,
      recipeState.recipes
    )
  } catch (error) {
    console.error('[Persistence] Manual save failed:', error)
    throw error
  }
}

// Expose to window for debugging
if (typeof window !== 'undefined') {
  (window as any).__CLEANSLATE_PERSISTENCE__ = {
    saveNow: saveAppStateNow,
    clearState: clearAppState,
    restoreState: restoreAppState,
  }
}
