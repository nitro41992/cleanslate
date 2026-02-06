import { create } from 'zustand'
import type { PersistenceStatus, LastEditLocation } from '@/types'
import { getMemoryStatus, getMemoryBreakdown, MEMORY_LIMIT_BYTES } from '@/lib/duckdb/memory'
import {
  takeMemorySnapshot,
  analyzeMemoryTrend,
  runMemoryCleanup,
  type MemoryHealthLevel,
} from '@/lib/memory-manager'

// Debounce cleanup attempts - only run once per 30 seconds
let lastCleanupAttempt = 0
let cleanupInProgress = false
const CLEANUP_DEBOUNCE_MS = 30_000

export type ThemeMode = 'light' | 'dark'
export type MemoryLevel = 'normal' | 'warning' | 'critical'
export type CompactionStatus = 'idle' | 'running'

/**
 * Chunk progress for large snapshot exports (>100k rows)
 */
export interface ChunkProgress {
  tableName: string
  currentChunk: number
  totalChunks: number
}

/**
 * Memory breakdown by category for UI tooltip
 */
export interface MemoryBreakdown {
  tableDataBytes: number   // User tables
  timelineBytes: number    // _timeline_*, snapshot_*, _original_*
  diffBytes: number        // _diff_* tables
  overheadBytes: number    // Buffer pool, indexes, temp storage
}

/**
 * Usage metrics for future analytics/monetization
 */
export interface UsageMetrics {
  totalTables: number
  totalRows: number
  opfsUsedBytes: number
  peakMemoryBytes: number
  transformCount: number
}

/** Info about a row that was just inserted - for local state injection without reload */
export interface PendingRowInsertion {
  tableId: string
  csId: string
  rowIndex: number
}

interface UIState {
  themeMode: ThemeMode
  sidebarCollapsed: boolean
  persistenceStatus: PersistenceStatus
  lastSavedAt: Date | null
  dirtyTableIds: Set<string>  // Tables with unsaved changes
  prioritySaveTableIds: Set<string>  // Tables that need IMMEDIATE saving (bypass debounce)
  memoryUsage: number
  memoryLimit: number
  memoryLevel: MemoryLevel
  busyCount: number  // Reference counter for nested DuckDB locks
  loadingMessage: string | null  // Dynamic loading message for file imports
  skipNextGridReload: boolean  // Flag to skip next DataGrid reload (e.g., after diff close)
  transformingTables: Set<string>  // Tables currently undergoing transforms (prevents edit flushes)
  /** Row that was just inserted - DataGrid will inject this locally without reload */
  pendingRowInsertion: PendingRowInsertion | null
  // Snapshot queue state (for persistence indicator)
  savingTables: string[]           // Tables currently being saved (snapshot export in progress)
  pendingTables: string[]          // Tables queued for next save (coalescing)
  chunkProgress: ChunkProgress | null  // Chunked export progress (null if not chunking)
  compactionStatus: CompactionStatus   // Changelog compaction status
  pendingChangelogCount: number        // Cell edits pending compaction
  // Memory breakdown (for memory indicator tooltip)
  memoryBreakdown: MemoryBreakdown
  // JS heap memory (browser tab memory - what Task Manager shows)
  jsHeapBytes: number | null  // null if browser doesn't support performance.memory
  // Estimated total memory (approximates Task Manager value)
  estimatedTotalMemory: number
  // Memory health level based on estimated total
  memoryHealthLevel: MemoryHealthLevel
  // Is memory leaking (consistent growth detected)
  isMemoryLeaking: boolean
  // Usage metrics (for future analytics)
  usageMetrics: UsageMetrics
  // Last edit location for gutter indicator (single location, not full history)
  lastEdit: LastEditLocation | null
}

interface UIActions {
  setThemeMode: (mode: ThemeMode) => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPersistenceStatus: (status: PersistenceStatus) => void
  setLastSavedAt: (date: Date | null) => void
  /** Mark a table as having unsaved changes (called immediately when command executes) */
  markTableDirty: (tableId: string) => void
  /** Mark a table as saved (called after snapshot export completes) */
  markTableClean: (tableId: string) => void
  setMemoryUsage: (used: number, limit: number) => void
  setMemoryLevel: (level: MemoryLevel) => void
  /** Refresh memory status from DuckDB - call after operations that change data */
  refreshMemory: () => Promise<void>
  /** Increment busy counter (pauses memory polling) */
  incrementBusy: () => void
  /** Decrement busy counter (resumes memory polling when 0) */
  decrementBusy: () => void
  /** Set dynamic loading message for file imports */
  setLoadingMessage: (message: string | null) => void
  /** Set flag to skip next DataGrid reload (e.g., after diff close) */
  setSkipNextGridReload: (skip: boolean) => void
  /** Mark a table as undergoing transformation (defers edit flushes) */
  setTableTransforming: (tableId: string, isTransforming: boolean) => void
  /** Check if a table is currently undergoing transformation */
  isTableTransforming: (tableId: string) => boolean
  /** Request immediate (non-debounced) save for a table - call after transforms complete */
  requestPrioritySave: (tableId: string) => void
  /** Clear priority save flag after save completes */
  clearPrioritySave: (tableId: string) => void
  /** Check if a table has priority save requested */
  hasPrioritySave: (tableId: string) => boolean
  /** Get all tables with priority save requested */
  getPrioritySaveTables: () => string[]
  // Snapshot queue actions
  /** Add a table to the saving list (call when snapshot export starts) */
  addSavingTable: (tableName: string) => void
  /** Remove a table from the saving list (call when snapshot export completes) */
  removeSavingTable: (tableName: string) => void
  /** Add a table to the pending list (call when save is queued for coalescing) */
  addPendingTable: (tableName: string) => void
  /** Remove a table from the pending list (call when save begins or cancelled) */
  removePendingTable: (tableName: string) => void
  /** Set chunk progress for large exports (null to clear) */
  setChunkProgress: (progress: ChunkProgress | null) => void
  /** Set compaction status */
  setCompactionStatus: (status: CompactionStatus) => void
  /** Set pending changelog entry count */
  setPendingChangelogCount: (count: number) => void
  // Memory breakdown actions
  /** Set memory breakdown from memory.ts getMemoryBreakdown() */
  setMemoryBreakdown: (breakdown: MemoryBreakdown) => void
  // Usage metrics actions
  /** Update usage metrics (merges partial update into existing) */
  updateUsageMetrics: (metrics: Partial<UsageMetrics>) => void
  /** Set pending row insertion for local state injection */
  setPendingRowInsertion: (insertion: PendingRowInsertion | null) => void
  /** Set the most recent edit location (overwrites previous) */
  setLastEdit: (edit: LastEditLocation | null) => void
  /** Clear last edit for a specific table (call on table delete) */
  clearLastEditForTable: (tableId: string) => void
}

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  const stored = localStorage.getItem('cleanslate-theme')
  return stored === 'light' ? 'light' : 'dark'
}

export const useUIStore = create<UIState & UIActions>((set, get) => ({
  themeMode: getInitialTheme(),
  sidebarCollapsed: false,
  persistenceStatus: 'idle',
  lastSavedAt: null,
  dirtyTableIds: new Set<string>(),
  prioritySaveTableIds: new Set<string>(),
  memoryUsage: 0,
  memoryLimit: MEMORY_LIMIT_BYTES, // 3GB (75% of 4GB WASM ceiling)
  memoryLevel: 'normal',
  busyCount: 0,
  loadingMessage: null,
  skipNextGridReload: false,
  transformingTables: new Set<string>(),
  pendingRowInsertion: null,
  // Snapshot queue initial state
  savingTables: [],
  pendingTables: [],
  chunkProgress: null,
  compactionStatus: 'idle',
  pendingChangelogCount: 0,
  // Memory breakdown initial state
  memoryBreakdown: {
    tableDataBytes: 0,
    timelineBytes: 0,
    diffBytes: 0,
    overheadBytes: 0,
  },
  // JS heap (browser memory) initial state
  jsHeapBytes: null,
  // Estimated total memory initial state
  estimatedTotalMemory: 0,
  memoryHealthLevel: 'healthy' as MemoryHealthLevel,
  isMemoryLeaking: false,
  // Usage metrics initial state
  usageMetrics: {
    totalTables: 0,
    totalRows: 0,
    opfsUsedBytes: 0,
    peakMemoryBytes: 0,
    transformCount: 0,
  },
  // Last edit location initial state
  lastEdit: null,

  setThemeMode: (mode) => {
    set({ themeMode: mode })
    if (mode === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('cleanslate-theme', mode)
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed })
  },

  setPersistenceStatus: (status) => {
    set({ persistenceStatus: status })
    if (status === 'saved') {
      set({ lastSavedAt: new Date() })
    }
  },

  setLastSavedAt: (date) => {
    set({ lastSavedAt: date })
  },

  markTableDirty: (tableId) => {
    const current = get().dirtyTableIds
    if (!current.has(tableId)) {
      const updated = new Set(current)
      updated.add(tableId)
      set({ dirtyTableIds: updated, persistenceStatus: 'dirty' })
    } else if (get().persistenceStatus !== 'dirty' && get().persistenceStatus !== 'saving') {
      // Ensure status is dirty if we have dirty tables
      set({ persistenceStatus: 'dirty' })
    }
  },

  markTableClean: (tableId) => {
    const current = get().dirtyTableIds
    let finalSize = current.size

    if (current.has(tableId)) {
      const updated = new Set(current)
      updated.delete(tableId)
      set({ dirtyTableIds: updated })
      finalSize = updated.size
    }

    // Transition to 'saved' when all tables are clean
    // This check is OUTSIDE the if block to handle re-saves where the table
    // was already cleaned by a previous save but status is still 'saving'.
    // Also handle 'dirty' status for changelog fast path (cell edits don't go through 'saving').
    const status = get().persistenceStatus
    if (finalSize === 0 && (status === 'saving' || status === 'dirty')) {
      set({ persistenceStatus: 'saved', lastSavedAt: new Date() })

      // Auto-reset to 'idle' after 3 seconds
      setTimeout(() => {
        // Only reset if still 'saved' (avoid race with new operations)
        if (get().persistenceStatus === 'saved') {
          set({ persistenceStatus: 'idle' })
        }
      }, 3000)
    }
  },

  setMemoryUsage: (used, limit) => {
    set({ memoryUsage: used, memoryLimit: limit })
  },

  setMemoryLevel: (level) => {
    set({ memoryLevel: level })
  },

  refreshMemory: async () => {
    // Skip if any DuckDB operation is in progress (prevents race condition)
    if (get().busyCount > 0) return
    try {
      // Fetch both status and breakdown in parallel
      const [status, breakdown] = await Promise.all([
        getMemoryStatus(),
        getMemoryBreakdown(),
      ])
      // Take memory snapshot for trend analysis
      const snapshot = takeMemorySnapshot(status.duckdbReportedBytes)
      const trend = analyzeMemoryTrend()

      set({
        memoryUsage: status.usedBytes,
        memoryLimit: status.limitBytes,
        memoryLevel: status.level,
        memoryBreakdown: breakdown,
        jsHeapBytes: snapshot.jsHeapUsed,
        estimatedTotalMemory: snapshot.estimatedTotalMemory,
        memoryHealthLevel: snapshot.healthLevel,
        isMemoryLeaking: trend.isLeaking,
      })

      // Auto-cleanup caches when memory reaches soft threshold or higher (debounced to avoid spam)
      // Soft eviction at 1GB prevents reaching critical thresholds
      const now = Date.now()
      const needsCleanup =
        snapshot.healthLevel === 'soft' ||
        snapshot.healthLevel === 'warning' ||
        snapshot.healthLevel === 'critical' ||
        snapshot.healthLevel === 'danger'

      if (
        needsCleanup &&
        now - lastCleanupAttempt > CLEANUP_DEBOUNCE_MS &&
        !cleanupInProgress
      ) {
        cleanupInProgress = true
        lastCleanupAttempt = now
        console.log(`[Memory] ${snapshot.healthLevel} memory level detected, running cleanup...`)
        runMemoryCleanup()
          .catch(console.error)
          .finally(() => {
            cleanupInProgress = false
          })
      }
      // Track peak memory for usage metrics
      const current = get()
      if (status.usedBytes > current.usageMetrics.peakMemoryBytes) {
        set({
          usageMetrics: {
            ...current.usageMetrics,
            peakMemoryBytes: status.usedBytes,
          },
        })
      }
    } catch (error) {
      console.warn('Failed to refresh memory status:', error)
    }
  },

  incrementBusy: () => set((state) => ({ busyCount: state.busyCount + 1 })),
  decrementBusy: () => set((state) => ({ busyCount: Math.max(0, state.busyCount - 1) })),
  setLoadingMessage: (message) => set({ loadingMessage: message }),
  setSkipNextGridReload: (skip) => {
    set({ skipNextGridReload: skip })
  },

  setTableTransforming: (tableId, isTransforming) => {
    set((state) => {
      const newSet = new Set(state.transformingTables)
      if (isTransforming) {
        newSet.add(tableId)
      } else {
        newSet.delete(tableId)
      }
      return { transformingTables: newSet }
    })
  },

  isTableTransforming: (tableId) => {
    return get().transformingTables.has(tableId)
  },

  requestPrioritySave: (tableId) => {
    set((state) => {
      const newSet = new Set(state.prioritySaveTableIds)
      newSet.add(tableId)
      console.log(`[UIStore] Priority save requested for table ${tableId}`)
      return { prioritySaveTableIds: newSet }
    })
  },

  clearPrioritySave: (tableId) => {
    set((state) => {
      const newSet = new Set(state.prioritySaveTableIds)
      newSet.delete(tableId)
      return { prioritySaveTableIds: newSet }
    })
  },

  hasPrioritySave: (tableId) => {
    return get().prioritySaveTableIds.has(tableId)
  },

  getPrioritySaveTables: () => {
    return Array.from(get().prioritySaveTableIds)
  },

  // Snapshot queue actions
  addSavingTable: (tableName) => {
    set((state) => {
      if (state.savingTables.includes(tableName)) return state
      return { savingTables: [...state.savingTables, tableName] }
    })
  },

  removeSavingTable: (tableName) => {
    set((state) => ({
      savingTables: state.savingTables.filter((t) => t !== tableName),
      // Clear chunk progress if this was the table being chunked
      chunkProgress: state.chunkProgress?.tableName === tableName ? null : state.chunkProgress,
    }))
  },

  addPendingTable: (tableName) => {
    set((state) => {
      if (state.pendingTables.includes(tableName)) return state
      return { pendingTables: [...state.pendingTables, tableName] }
    })
  },

  removePendingTable: (tableName) => {
    set((state) => ({
      pendingTables: state.pendingTables.filter((t) => t !== tableName),
    }))
  },

  setChunkProgress: (progress) => {
    set({ chunkProgress: progress })
  },

  setCompactionStatus: (status) => {
    set({ compactionStatus: status })
  },

  setPendingChangelogCount: (count) => {
    set({ pendingChangelogCount: count })
  },

  // Memory breakdown actions
  setMemoryBreakdown: (breakdown) => {
    set({ memoryBreakdown: breakdown })
  },

  // Usage metrics actions
  updateUsageMetrics: (metrics) => {
    set((state) => ({
      usageMetrics: {
        ...state.usageMetrics,
        ...metrics,
        // Track peak memory
        peakMemoryBytes: Math.max(
          state.usageMetrics.peakMemoryBytes,
          metrics.peakMemoryBytes ?? state.memoryUsage
        ),
      },
    }))
  },

  // Row insertion action (for local state injection without reload)
  setPendingRowInsertion: (insertion) => {
    set({ pendingRowInsertion: insertion })
  },

  // Last edit location actions
  setLastEdit: (edit) => {
    set({ lastEdit: edit })
  },

  clearLastEditForTable: (tableId) => {
    const current = get().lastEdit
    if (current?.tableId === tableId) {
      set({ lastEdit: null })
    }
  },
}))

// Persistence: Auto-save state on UI preference changes
// Import dynamically to avoid circular dependencies
let isRestoringState = false

export function setRestoringState(restoring: boolean) {
  isRestoringState = restoring
}

if (typeof window !== 'undefined') {
  import('@/lib/persistence/debounce').then(({ DebouncedSave }) => {
    const debouncedSave = new DebouncedSave(500)

    useUIStore.subscribe((state, prevState) => {
      // Skip save during state restoration to avoid write cycles
      if (isRestoringState) return

      // Save if sidebarCollapsed or lastEdit changed
      const needsSave =
        state.sidebarCollapsed !== prevState.sidebarCollapsed ||
        state.lastEdit !== prevState.lastEdit

      if (needsSave) {
        // Trigger debounced save
        debouncedSave.trigger(async () => {
          const { saveAppState } = await import('@/lib/persistence/state-persistence')
          const { useTableStore } = await import('@/stores/tableStore')
          const { useTimelineStore } = await import('@/stores/timelineStore')
          const { useRecipeStore } = await import('@/stores/recipeStore')
          const { useMatcherStore } = await import('@/stores/matcherStore')

          const tableState = useTableStore.getState()
          const timelineState = useTimelineStore.getState()
          const recipeState = useRecipeStore.getState()
          const matcherSerialized = useMatcherStore.getState().getSerializedState()
          if (matcherSerialized) {
            const matchTable = tableState.tables.find(t => t.id === matcherSerialized.tableId)
            matcherSerialized.tableRowCount = matchTable?.rowCount ?? 0
          }

          await saveAppState(
            tableState.tables,
            tableState.activeTableId,
            timelineState.getSerializedTimelines(),
            state.sidebarCollapsed,
            state.lastEdit,
            recipeState.recipes,
            matcherSerialized
          )
        })
      }
    })
  })
}
