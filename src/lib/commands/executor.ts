/**
 * Command Executor
 *
 * Central orchestrator for command execution with 3-tier undo strategy.
 *
 * Execution Flow:
 * 1. validate() - Check params and preconditions
 * 2. checkUndoStrategy() - Determine Tier 1/2/3
 * 3. pre-snapshot - If Tier 3, create snapshot
 * 4. execute() - Run the command
 * 5. createDiffView() - Create v_diff_step_X for highlighting
 * 6. recordTimeline() - Add to undo/redo stack
 * 7. updateStores() - Update tableStore, auditStore
 */

import type {
  Command,
  CommandContext,
  ExecuteOptions,
  ExecutorProgress,
  ExecutorResult,
  ICommandExecutor,
  TimelineCommandRecord,
  HighlightInfo,
  UndoTier,
  CellChange,
  SnapshotMetadata,
} from './types'
import { buildCommandContext, refreshTableContext } from './context'
import { createColumnVersionManager, type ColumnVersionStore } from './column-versions'
import { getUndoTier, requiresSnapshot, createCommand } from './registry'
import {
  createTier1DiffView,
  createTier3DiffView,
  type DiffViewConfig,
} from './diff-views'
import { useTableStore } from '@/stores/tableStore'
import { useAuditStore } from '@/stores/auditStore'
import { useTimelineStore } from '@/stores/timelineStore'
import { duplicateTable, dropTable, tableExists, getConnection } from '@/lib/duckdb'
import { initDuckDB } from '@/lib/duckdb'
import {
  ensureAuditDetailsTable,
  captureTier23RowDetails,
} from './audit-capture'
import { getBaseColumnName } from './column-versions'
import type { TimelineCommandType } from '@/types'
import { toast } from '@/hooks/use-toast'
import {
  getMemoryStatus,
  getDuckDBMemoryUsage,
  getEstimatedTableSizes,
} from '@/lib/duckdb/memory'
import {
  exportTableToParquet,
  importTableFromParquet,
  deleteParquetSnapshot,
} from '@/lib/opfs/snapshot-storage'

// ===== TIMELINE STORAGE =====

/**
 * Maximum number of Tier 3 snapshots per table.
 * LRU eviction removes oldest when limit exceeded.
 */
const MAX_SNAPSHOTS_PER_TABLE = 5

/**
 * Timeout ID for auto-resetting persistence status from 'saved' to 'idle'
 * Cleared if a new operation starts during the countdown
 */
let persistenceAutoResetTimer: NodeJS.Timeout | null = null

// Per-table timeline of executed commands for undo/redo
// Key: tableId, Value: { commands, position, snapshots }
interface TableCommandTimeline {
  commands: TimelineCommandRecord[]
  position: number // -1 = before first command, 0+ = after command at that index
  snapshots: Map<number, SnapshotMetadata> // position -> snapshot metadata
  snapshotTimestamps: Map<number, number> // position -> timestamp for LRU tracking
  originalSnapshot?: SnapshotMetadata // Initial state snapshot
}

const tableTimelines = new Map<string, TableCommandTimeline>()

/**
 * Get or create timeline for a table
 */
function getTimeline(tableId: string): TableCommandTimeline {
  let timeline = tableTimelines.get(tableId)
  if (!timeline) {
    timeline = {
      commands: [],
      position: -1,
      snapshots: new Map(),
      snapshotTimestamps: new Map(),
    }
    tableTimelines.set(tableId, timeline)
  }
  return timeline
}

/**
 * Clear timeline for a table (when table is deleted)
 */
export function clearCommandTimeline(tableId: string): void {
  const timeline = tableTimelines.get(tableId)
  if (timeline) {
    // Clean up snapshots (both table and Parquet)
    for (const snapshot of timeline.snapshots.values()) {
      if (snapshot.storageType === 'table' && snapshot.tableName) {
        dropTable(snapshot.tableName).catch(() => {
          // Ignore errors during cleanup
        })
      } else if (snapshot.storageType === 'parquet') {
        deleteParquetSnapshot(snapshot.id).catch(() => {})
      }
    }
    if (timeline.originalSnapshot) {
      if (timeline.originalSnapshot.storageType === 'table' && timeline.originalSnapshot.tableName) {
        dropTable(timeline.originalSnapshot.tableName).catch(() => {})
      } else if (timeline.originalSnapshot.storageType === 'parquet') {
        deleteParquetSnapshot(timeline.originalSnapshot.id).catch(() => {})
      }
    }
    tableTimelines.delete(tableId)
  }
}

// ===== COMMAND EXECUTOR CLASS =====

export class CommandExecutor implements ICommandExecutor {
  /**
   * Execute a command with full lifecycle
   */
  async execute(
    command: Command,
    options: ExecuteOptions = {}
  ): Promise<ExecutorResult> {
    const {
      skipValidation = false,
      skipDiffView = false,
      skipTimeline = false,
      skipAudit = false,
      onProgress,
    } = options

    const progress = (
      phase: ExecutorProgress['phase'],
      pct: number,
      message: string
    ) => {
      onProgress?.({ phase, progress: pct, message })
    }

    try {
      // Extract tableId from command params
      const tableId = (command.params as Record<string, unknown>)?.tableId as string
      if (!tableId) {
        return {
          success: false,
          error: 'tableId is required in command params',
        }
      }

      // Build context
      const ctx = await buildCommandContext(tableId)

      // Step 1: Validation
      if (!skipValidation) {
        progress('validating', 10, 'Validating command...')
        const validationResult = await command.validate(ctx)
        if (!validationResult.isValid) {
          return {
            success: false,
            validationResult,
            error: validationResult.errors.map((e) => e.message).join('; '),
          }
        }
      }

      // Step 2: Determine undo tier
      const tier = getUndoTier(command.type)
      const needsSnapshot = requiresSnapshot(command.type)

      // Step 2.5: Batching decision for large operations (>500k rows)
      // MOVED FROM Step 3.75 - needed for snapshot decision
      const shouldBatch = ctx.table.rowCount > 500_000
      const batchSize = 50_000

      if (shouldBatch) {
        console.log(`[Executor] Large operation (${ctx.table.rowCount.toLocaleString()} rows), using batch mode`)
      }

      // Step 3: Pre-snapshot for Tier 3 OR batched Tier 1 (delegated to timeline system)
      let snapshotMetadata: SnapshotMetadata | undefined
      const needsSnapshotForBatchedTier1 = tier === 1 && shouldBatch
      if ((needsSnapshot || needsSnapshotForBatchedTier1) && !skipTimeline) {
        progress('snapshotting', 20, 'Creating backup snapshot...')

        // Log why snapshot was created (diagnostic)
        if (needsSnapshotForBatchedTier1) {
          console.log(`[Executor] Created snapshot for batched Tier 1 operation (fallback undo strategy)`)
        }

        // Get or create timeline
        const timelineStoreState = useTimelineStore.getState()
        let existingTimeline = timelineStoreState.getTimeline(tableId)

        // Create timeline if it doesn't exist yet
        if (!existingTimeline) {
          // Create with empty snapshot name initially
          const { initializeTimeline } = await import('@/lib/timeline-engine')
          const timelineId = await initializeTimeline(tableId, ctx.table.name)
          existingTimeline = timelineStoreState.getTimeline(tableId)
        } else if (!existingTimeline.originalSnapshotName) {
          // Timeline exists but no original snapshot set yet
          const { createTimelineOriginalSnapshot } = await import('@/lib/timeline-engine')
          const snapshotName = await createTimelineOriginalSnapshot(ctx.table.name, existingTimeline.id)
          timelineStoreState.updateTimelineOriginalSnapshot(tableId, snapshotName)
        }

        // Call timeline engine's createStepSnapshot for Parquet-backed snapshots
        // This creates a snapshot of the CURRENT state (before the new command is applied)
        const { createStepSnapshot } = await import('@/lib/timeline-engine')
        const timeline = getTimeline(tableId)
        const stepIndex = timeline.position + 1  // Position after this command will execute

        const snapshotName = await createStepSnapshot(
          ctx.table.name,
          existingTimeline!.id,
          stepIndex
        )

        // Convert to SnapshotMetadata format for executor use
        if (snapshotName.startsWith('parquet:')) {
          const snapshotId = snapshotName.replace('parquet:', '')
          snapshotMetadata = {
            id: snapshotId,
            storageType: 'parquet',
            path: `${snapshotId}.parquet`
          }
        } else {
          snapshotMetadata = {
            id: `step_${stepIndex}`,
            storageType: 'table',
            tableName: snapshotName
          }
        }

        console.log('[Memory] Step snapshot created via timeline system:', snapshotMetadata)
      }

      // Step 3.5: Pre-capture row details for Tier 2/3 (BEFORE transformation)
      // Tier 2/3 transforms modify data in-place, so we must capture "before" values now
      // Tier 1 uses __base columns, so it captures AFTER execution
      const preGeneratedAuditEntryId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      if (!skipAudit && tier !== 1) {
        try {
          await this.capturePreExecutionDetails(ctx, command, preGeneratedAuditEntryId)
        } catch (err) {
          console.warn('[EXECUTOR] Failed to capture pre-execution row details:', err)
        }
      }

      // Inject batching metadata into context
      // Commands can check ctx.batchMode to enable batched execution
      // NOTE: Most commands will ignore this and execute normally
      // Future: Individual commands can opt-in to batching by checking ctx.batchMode
      const batchableContext: CommandContext = {
        ...ctx,
        batchMode: shouldBatch,
        batchSize: batchSize,
        onBatchProgress: shouldBatch
          ? (curr, total, pct) => {
              // Map batch progress to execute phase (40-80%)
              const adjustedPct = 40 + (pct * 0.4)
              progress('executing', adjustedPct, `Processing ${curr.toLocaleString()} / ${total.toLocaleString()} rows`)
            }
          : undefined,
      }

      // Step 3.9: Capture memory state before execution (diagnostic)
      const memBefore = await getDuckDBMemoryUsage()
      const tablesBefore = await getEstimatedTableSizes()

      // Step 4: Execute
      progress('executing', 40, 'Executing command...')
      const executionResult = await command.execute(batchableContext)

      if (!executionResult.success) {
        // Rollback snapshot if execution failed
        if (snapshotMetadata) {
          await this.restoreFromSnapshot(ctx.table.name, snapshotMetadata)
        }
        return {
          success: false,
          executionResult,
          error: executionResult.error || 'Command execution failed',
        }
      }

      // Step 4.3: Memory diagnostic logging (after execution)
      const memAfter = await getDuckDBMemoryUsage()
      const tablesAfter = await getEstimatedTableSizes()

      const memoryDelta = memAfter.totalBytes - memBefore.totalBytes
      const tableCountDelta = tablesAfter.length - tablesBefore.length

      // Calculate per-tag deltas
      const tagDeltas = Object.keys(memAfter.byTag).map(tag => {
        const afterMem = memAfter.byTag[tag]?.memoryBytes || 0
        const beforeMem = memBefore.byTag[tag]?.memoryBytes || 0
        return {
          tag,
          delta: afterMem - beforeMem,
          before: beforeMem,
          after: afterMem,
        }
      }).filter(t => t.delta !== 0) // Only show tags with changes

      console.log('[Memory Diagnostic]', {
        command: command.type,
        tier,
        memoryDelta: `${(memoryDelta / 1024 / 1024).toFixed(2)} MB`,
        tableCountDelta,
        totalBefore: `${(memBefore.totalBytes / 1024 / 1024).toFixed(2)} MB`,
        totalAfter: `${(memAfter.totalBytes / 1024 / 1024).toFixed(2)} MB`,
        byTagDelta: tagDeltas.map(t => ({
          tag: t.tag,
          delta: `${(t.delta / 1024 / 1024).toFixed(2)} MB`,
          before: `${(t.before / 1024 / 1024).toFixed(2)} MB`,
          after: `${(t.after / 1024 / 1024).toFixed(2)} MB`,
        })),
      })

      // Refresh context with new schema
      const updatedCtx = await refreshTableContext(ctx)

      // Step 4.5: CHECKPOINT after Tier 3 to flush WAL and release buffer pool
      if (tier === 3) {
        try {
          await ctx.db.execute('CHECKPOINT')
          console.log('[Memory] Checkpointed after Tier 3 operation')
        } catch (err) {
          console.warn('[Memory] CHECKPOINT failed (non-fatal):', err)
        }
      }

      // Step 5: Audit logging
      let auditInfo
      if (!skipAudit) {
        progress('auditing', 60, 'Recording audit log...')
        auditInfo = command.getAuditInfo(updatedCtx, executionResult)
        // Use pre-generated auditEntryId for Tier 2/3 (captured before execution)
        // EXCEPT for commands that store their own audit details (standardize, merge)
        // These commands use their own ID in execute() and we must keep it consistent
        const commandStoresOwnAuditDetails = command.type === 'standardize:apply' || command.type === 'match:merge'
        if (tier !== 1 && !commandStoresOwnAuditDetails) {
          auditInfo.auditEntryId = preGeneratedAuditEntryId
        }
        this.recordAudit(ctx.table.id, ctx.table.name, auditInfo)
      }

      // Step 6: Diff view
      let diffViewName: string | undefined
      if (!skipDiffView) {
        progress('diffing', 70, 'Creating diff view...')
        const rowPredicate = await command.getAffectedRowsPredicate(updatedCtx)
        const affectedColumn = (command.params as { column?: string })?.column || null
        diffViewName = await this.createDiffView(
          updatedCtx,
          tier,
          rowPredicate,
          affectedColumn,
          snapshotMetadata
        )
      }

      // Extract affected row IDs from diff view for highlighting support
      let affectedRowIds = await this.extractAffectedRowIds(updatedCtx, diffViewName)

      // CRITICAL FIX: For transform commands, ensure affectedRowIds are populated
      // even if diff view extraction fails. Use conservative approach: all non-null values.
      if (affectedRowIds.length === 0 && command.type.startsWith('transform:')) {
        const column = (command.params as { column?: string })?.column
        if (column) {
          try {
            const quotedColumn = `"${column}"`
            const result = await updatedCtx.db.query<{ _cs_id: string }>(`
              SELECT _cs_id FROM "${updatedCtx.table.name}"
              WHERE ${quotedColumn} IS NOT NULL
            `)
            affectedRowIds = result.map(r => String(r._cs_id))
          } catch (err) {
            console.warn('[EXECUTOR] Failed to extract affectedRowIds for transform:', err)
          }
        }
      }

      // Drop diff view immediately after extracting row IDs
      // Diff views are ephemeral - only needed for highlighting extraction
      // Prevents accumulation of large views (1M rows each) in memory
      if (diffViewName) {
        try {
          await ctx.db.execute(`DROP VIEW IF EXISTS "${diffViewName}"`)
          console.log(`[Memory] Dropped diff view: ${diffViewName}`)
        } catch (err) {
          // Non-fatal - don't fail the command if view cleanup fails
          console.warn(`[Memory] Failed to drop diff view ${diffViewName}:`, err)
        }
      }

      // Step 7: Record timeline for undo/redo
      let highlightInfo: HighlightInfo | undefined
      if (!skipTimeline) {
        progress('complete', 90, 'Recording timeline...')
        const rowPredicate = await command.getAffectedRowsPredicate(updatedCtx)
        highlightInfo = {
          rowPredicate,
          columns: auditInfo?.affectedColumns || [],
          mode: rowPredicate ? 'row' : 'column',
        }
        await this.recordTimelineCommand(
          ctx.table.id,
          command,
          tier,
          updatedCtx,
          snapshotMetadata,
          executionResult.versionedColumn?.backup,
          highlightInfo.rowPredicate
        )

        // Sync with legacy timelineStore for UI integration (highlight, drill-down)
        this.syncExecuteToTimelineStore(ctx.table.id, ctx.table.name, command, auditInfo, affectedRowIds)
      }

      // Capture row-level details for Tier 1 only (uses __base columns, must be AFTER execution)
      // Tier 2/3 already captured BEFORE execution in Step 3.5
      if (!skipAudit && auditInfo?.hasRowDetails && auditInfo?.auditEntryId && tier === 1) {
        try {
          await this.captureTier1RowDetails(updatedCtx,
            (command.params as { column?: string }).column!,
            auditInfo.auditEntryId
          )
        } catch (err) {
          console.warn('[EXECUTOR] Failed to capture Tier 1 row details:', err)
          // Non-critical - don't fail the command
        }
      }

      // Step 8: Update stores
      progress('complete', 100, 'Complete')
      this.updateTableStore(ctx.table.id, executionResult)

      // Proactive memory management: prune snapshots if memory > 80%
      await this.pruneSnapshotsIfHighMemory()

      // Auto-persist to OPFS (debounced, non-blocking)
      // Waits 1 second of idle time before flushing to prevent stuttering on bulk edits
      const { flushDuckDB } = await import('@/lib/duckdb')
      const { useUIStore } = await import('@/stores/uiStore')

      flushDuckDB(false, {
        onStart: () => {
          // Clear any pending auto-reset timeout to prevent race condition
          if (persistenceAutoResetTimer) {
            clearTimeout(persistenceAutoResetTimer)
            persistenceAutoResetTimer = null
          }
          useUIStore.getState().setPersistenceStatus('saving')
        },
        onComplete: () => {
          const store = useUIStore.getState()
          store.setPersistenceStatus('saved')

          // Auto-reset to idle after 3 seconds
          persistenceAutoResetTimer = setTimeout(() => {
            // Only reset if still 'saved' (avoid race with new operations)
            if (useUIStore.getState().persistenceStatus === 'saved') {
              useUIStore.getState().setPersistenceStatus('idle')
            }
            persistenceAutoResetTimer = null
          }, 3000)
        },
        onError: (error) => {
          useUIStore.getState().setPersistenceStatus('error')
          console.error('[EXECUTOR] Flush error:', error)
        }
      })

      return {
        success: true,
        executionResult,
        auditInfo,
        highlightInfo,
        diffViewName,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Undo the last command
   */
  async undo(tableId: string): Promise<ExecutorResult> {
    const timeline = tableTimelines.get(tableId)
    if (!timeline || timeline.position < 0) {
      return {
        success: false,
        error: 'Nothing to undo',
      }
    }

    const commandRecord = timeline.commands[timeline.position]
    if (!commandRecord) {
      return {
        success: false,
        error: 'No command at current position',
      }
    }

    // Check if undo is disabled (snapshot was pruned)
    if (commandRecord.undoDisabled) {
      return {
        success: false,
        error: 'Undo unavailable: History limit reached',
      }
    }

    try {
      const ctx = await buildCommandContext(tableId)

      switch (commandRecord.tier) {
        case 1:
          // Tier 1: Column versioning undo OR snapshot if batched
          if (commandRecord.backupColumn && commandRecord.affectedColumns?.[0]) {
            const versionStore: ColumnVersionStore = { versions: ctx.columnVersions }
            const versionManager = createColumnVersionManager(ctx.db, versionStore)
            const result = await versionManager.undoVersion(
              ctx.table.name,
              commandRecord.affectedColumns[0]
            )
            if (!result.success) {
              return { success: false, error: result.error }
            }
          } else if (commandRecord.snapshotTable) {
            // Fallback to snapshot if no backup column (batched execution)
            // Large batched operations use Parquet cold storage
            await this.restoreFromSnapshot(ctx.table.name, commandRecord.snapshotTable)
          } else {
            return {
              success: false,
              error: 'Undo unavailable: No backup column or snapshot found'
            }
          }
          break

        case 2:
          // Tier 2: Execute inverse SQL
          if (commandRecord.inverseSql) {
            await ctx.db.execute(commandRecord.inverseSql)
          }
          break

        case 3:
          // Tier 3: Restore from snapshot
          if (commandRecord.snapshotTable) {
            await this.restoreFromSnapshot(ctx.table.name, commandRecord.snapshotTable)
          } else {
            // Find nearest snapshot before this position
            const snapshot = this.findNearestSnapshot(timeline, timeline.position - 1)
            if (snapshot) {
              await this.restoreFromSnapshot(ctx.table.name, snapshot)
              // Replay commands from snapshot position to target position
              // (For now, just restore and decrement position)
            }
          }
          break
      }

      // Decrement position
      timeline.position--

      // Drop diff view for the undone command (cleanup orphaned views)
      // Diff views are created during execute() with stepIndex = position + 1
      const stepIndex = timeline.position + 1 // Position before decrement
      const diffViewName = `v_diff_step_${tableId}_${stepIndex}`
      try {
        await ctx.db.execute(`DROP VIEW IF EXISTS "${diffViewName}"`)
        console.log(`[Undo] Dropped diff view: ${diffViewName}`)
      } catch (err) {
        // Non-fatal - diff view may not exist or already dropped
        console.warn(`[Undo] Failed to drop diff view ${diffViewName}:`, err)
      }

      // Sync with legacy timelineStore
      const timelineStoreState = useTimelineStore.getState()
      const legacyTimeline = timelineStoreState.getTimeline(tableId)
      if (legacyTimeline && legacyTimeline.currentPosition >= 0) {
        timelineStoreState.setPosition(tableId, legacyTimeline.currentPosition - 1)
      }

      // Update table store
      const updatedCtx = await refreshTableContext(ctx)
      this.updateTableStore(tableId, {
        rowCount: updatedCtx.table.rowCount,
        columns: updatedCtx.table.columns,
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Redo the next command
   */
  async redo(tableId: string): Promise<ExecutorResult> {
    const timeline = tableTimelines.get(tableId)
    if (!timeline || timeline.position >= timeline.commands.length - 1) {
      return {
        success: false,
        error: 'Nothing to redo',
      }
    }

    const nextPosition = timeline.position + 1
    const commandRecord = timeline.commands[nextPosition]
    if (!commandRecord) {
      return {
        success: false,
        error: 'No command at next position',
      }
    }

    try {
      // Recreate the command from the saved params
      const command = createCommand(
        commandRecord.commandType,
        commandRecord.params
      )

      // Build context
      const ctx = await buildCommandContext(tableId)

      // Execute the command directly
      const executionResult = await command.execute(ctx)

      if (!executionResult.success) {
        return {
          success: false,
          executionResult,
          error: executionResult.error || 'Redo execution failed',
        }
      }

      // Advance position
      timeline.position = nextPosition

      // Sync with legacy timelineStore
      const timelineStoreState = useTimelineStore.getState()
      const legacyTimeline = timelineStoreState.getTimeline(tableId)
      if (legacyTimeline && legacyTimeline.currentPosition < legacyTimeline.commands.length - 1) {
        timelineStoreState.setPosition(tableId, legacyTimeline.currentPosition + 1)
      }

      // Update table store
      const updatedCtx = await refreshTableContext(ctx)
      this.updateTableStore(tableId, {
        rowCount: updatedCtx.table.rowCount,
        columns: updatedCtx.table.columns,
      })

      return {
        success: true,
        executionResult,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  canUndo(tableId: string): boolean {
    const timeline = tableTimelines.get(tableId)
    if (!timeline || timeline.position < 0) return false

    const cmd = timeline.commands[timeline.position]
    return !!cmd && !cmd.undoDisabled
  }

  canRedo(tableId: string): boolean {
    const timeline = tableTimelines.get(tableId)
    return !!timeline && timeline.position < timeline.commands.length - 1
  }

  getHighlightPredicate(tableId: string, stepIndex: number): string | null {
    const timeline = tableTimelines.get(tableId)
    if (!timeline || stepIndex < 0 || stepIndex >= timeline.commands.length) {
      return null
    }
    return timeline.commands[stepIndex].rowPredicate || null
  }

  /**
   * Get set of dirty cell keys for a table
   *
   * Returns cells that have been modified by edit:cell commands
   * at or before the current timeline position.
   *
   * @param tableId - The table ID to get dirty cells for
   * @returns Set of cell keys in format "csId:columnName"
   */
  getDirtyCells(tableId: string): Set<string> {
    const timeline = tableTimelines.get(tableId)
    if (!timeline) return new Set()

    const dirtyCells = new Set<string>()

    // Collect cells from commands up to current position (inclusive)
    // Commands after currentPosition are "undone" and shouldn't show as dirty
    for (let i = 0; i <= timeline.position && i < timeline.commands.length; i++) {
      const cmd = timeline.commands[i]
      if (cmd.cellChanges) {
        for (const change of cmd.cellChanges) {
          // Key format: "{csId}:{columnName}" - consistent with timelineStore
          dirtyCells.add(`${change.csId}:${change.columnName}`)
        }
      }
    }

    return dirtyCells
  }

  /**
   * Get the current timeline position for a table
   * Useful for triggering re-renders when position changes
   */
  getTimelinePosition(tableId: string): number {
    const timeline = tableTimelines.get(tableId)
    return timeline?.position ?? -1
  }

  // ===== PRIVATE METHODS =====

  /**
   * Aggressively prune snapshots across all tables if memory usage > 80%.
   * Called after command execution to prevent OOM on large datasets.
   * Shows toast notification to inform user that old undo history was cleared.
   *
   * NOTE: Snapshot pruning now delegated to timeline system.
   * This method is kept for future memory management enhancements.
   */
  private async pruneSnapshotsIfHighMemory(): Promise<void> {
    const memStatus = await getMemoryStatus()

    if (memStatus.percentage < 80) return // Not critical yet

    console.warn('[Memory] High memory usage detected (>80%)')

    // Timeline system manages snapshots via timelineStore
    // Future enhancement: Could trigger timeline snapshot pruning here if needed
    // For now, rely on timeline system's built-in snapshot management
  }

  private async restoreFromSnapshot(
    tableName: string,
    snapshot: SnapshotMetadata
  ): Promise<void> {
    if (snapshot.storageType === 'table') {
      // Hot storage: Instant restore from in-memory table
      const exists = await tableExists(snapshot.tableName!)
      if (!exists) {
        throw new Error(`Snapshot table ${snapshot.tableName} not found`)
      }

      await dropTable(tableName)
      await duplicateTable(snapshot.tableName!, tableName, true)

    } else if (snapshot.storageType === 'parquet') {
      // Cold storage: Restore from OPFS Parquet file
      console.log(`[Snapshot] Restoring from Parquet: ${snapshot.path}`)

      const db = await initDuckDB()
      const conn = await getConnection()
      await dropTable(tableName)
      await importTableFromParquet(db, conn, snapshot.id, tableName)

      console.log(`[Snapshot] Restored ${tableName} from cold storage`)
    } else {
      throw new Error(`Unknown snapshot storage type: ${snapshot.storageType}`)
    }
  }

  private async createDiffView(
    ctx: CommandContext,
    tier: UndoTier,
    rowPredicate: string | null,
    affectedColumn: string | null,
    snapshot?: SnapshotMetadata
  ): Promise<string | undefined> {
    const timeline = getTimeline(ctx.table.id)
    const stepIndex = timeline.position + 1 // Next position after this command

    const config: DiffViewConfig = {
      tableName: ctx.table.name,
      tableId: ctx.table.id,
      stepIndex,
      rowPredicate,
      affectedColumn,
      changeType: 'modified',
    }

    try {
      if (tier === 3 && snapshot) {
        // Tier 3 with snapshot - can show deleted/added rows
        // For Parquet snapshots, we can't use them in diff views (must be in-memory)
        // Skip diff view creation for Parquet snapshots (highlighting still works via affectedRowIds)
        if (snapshot.storageType === 'table' && snapshot.tableName) {
          return await createTier3DiffView(ctx, { ...config, snapshotTable: snapshot.tableName })
        } else {
          // Parquet snapshot - skip diff view (can't reference Parquet in SQL)
          console.log('[Diff] Skipping diff view for Parquet snapshot (highlighting via row IDs)')
          return undefined
        }
      } else if (tier === 1) {
        // Tier 1 - show modified rows using __base columns
        return await createTier1DiffView(ctx, config)
      } else {
        // Tier 2 - show modified rows based on predicate (no __base columns)
        // For now, skip diff view for Tier 2 (can add predicate-based view later)
        return undefined
      }
    } catch {
      // Diff view creation is non-critical, don't fail the command
      return undefined
    }
  }

  private findNearestSnapshot(
    timeline: TableCommandTimeline,
    maxPosition: number
  ): SnapshotMetadata | undefined {
    // Look for snapshots at or before maxPosition
    for (let i = maxPosition; i >= 0; i--) {
      const snapshot = timeline.snapshots.get(i)
      if (snapshot) return snapshot
    }
    return timeline.originalSnapshot
  }

  private async recordTimelineCommand(
    tableId: string,
    command: Command,
    tier: UndoTier,
    ctx: CommandContext,
    snapshot?: SnapshotMetadata,
    backupColumn?: string,
    rowPredicate?: string | null
  ): Promise<void> {
    const timeline = getTimeline(tableId)

    // Truncate any commands after current position (for redo)
    if (timeline.position < timeline.commands.length - 1) {
      timeline.commands = timeline.commands.slice(0, timeline.position + 1)
      // Clean up orphaned snapshots and timestamps
      for (const [pos, snapshotMeta] of timeline.snapshots.entries()) {
        if (pos > timeline.position) {
          if (snapshotMeta.storageType === 'table' && snapshotMeta.tableName) {
            dropTable(snapshotMeta.tableName).catch(() => {})
          } else if (snapshotMeta.storageType === 'parquet') {
            deleteParquetSnapshot(snapshotMeta.id).catch(() => {})
          }
          timeline.snapshots.delete(pos)
          timeline.snapshotTimestamps.delete(pos)
        }
      }
    }

    // Get inverse SQL for Tier 2 commands
    let inverseSql: string | undefined
    if (tier === 2 && typeof command.getInverseSql === 'function') {
      inverseSql = command.getInverseSql(ctx)
    }

    // Get cell changes for edit:cell commands (for dirty cell tracking)
    let cellChanges: CellChange[] | undefined
    const commandWithCellChanges = command as unknown as { getCellChanges?: () => CellChange[] }
    if (typeof commandWithCellChanges.getCellChanges === 'function') {
      cellChanges = commandWithCellChanges.getCellChanges()
    }

    // Get affected columns from command params
    const commandParams = command.params as { column?: string; columns?: string[] }
    const affectedColumns = commandParams.column
      ? [commandParams.column]
      : commandParams.columns ?? []

    // Create record
    const record: TimelineCommandRecord = {
      id: command.id,
      commandType: command.type,
      label: command.label,
      params: command.params,
      timestamp: new Date(),
      tier,
      snapshotTable: snapshot,
      backupColumn,
      inverseSql,
      rowPredicate,
      affectedColumns,
      cellChanges,
    }

    timeline.commands.push(record)
    timeline.position = timeline.commands.length - 1

    // Store snapshot reference and timestamp if provided
    if (snapshot) {
      timeline.snapshots.set(timeline.position, snapshot)
      timeline.snapshotTimestamps.set(timeline.position, Date.now())
    }
  }

  private recordAudit(
    tableId: string,
    tableName: string,
    auditInfo: { action: string; details: unknown; rowsAffected: number; affectedColumns: string[]; hasRowDetails: boolean; auditEntryId: string; isCapped: boolean }
  ): void {
    const auditStore = useAuditStore.getState()
    auditStore.addTransformationEntry({
      tableId,
      tableName,
      action: auditInfo.action,
      details: JSON.stringify(auditInfo.details),
      rowsAffected: auditInfo.rowsAffected,
      hasRowDetails: auditInfo.hasRowDetails,
      auditEntryId: auditInfo.auditEntryId,
      isCapped: auditInfo.isCapped,
    })
  }

  private updateTableStore(
    tableId: string,
    result: { rowCount?: number; columns?: { name: string; type: string; nullable: boolean }[]; newColumnNames?: string[]; droppedColumnNames?: string[] }
  ): void {
    const tableStore = useTableStore.getState()
    const currentTable = tableStore.tables.find(t => t.id === tableId)

    tableStore.updateTable(tableId, {
      rowCount: result.rowCount ?? currentTable?.rowCount,
      columns: result.columns ?? currentTable?.columns,
      dataVersion: (currentTable?.dataVersion ?? 0) + 1, // CRITICAL: Trigger re-render
    })
  }

  /**
   * Map command type to legacy TimelineCommandType for timelineStore sync
   */
  private mapToLegacyCommandType(commandType: string): TimelineCommandType {
    if (commandType.startsWith('transform:')) return 'transform'
    if (commandType === 'edit:cell') return 'manual_edit'
    if (commandType === 'edit:batch') return 'batch_edit'
    if (commandType === 'combine:stack') return 'stack'
    if (commandType === 'combine:join') return 'join'
    if (commandType === 'match:merge') return 'merge'
    if (commandType === 'standardize:apply') return 'standardize'
    if (commandType.startsWith('scrub:')) return 'scrub'
    return 'transform'
  }

  /**
   * Capture row-level audit details BEFORE execution for Tier 2/3 commands.
   * Must be called BEFORE command.execute() to capture original "before" values.
   *
   * Tier 2/3 transforms modify data in-place without __base columns,
   * so we must capture the current values as "previous" before they change.
   */
  private async capturePreExecutionDetails(
    ctx: CommandContext,
    command: Command,
    auditEntryId: string
  ): Promise<void> {
    const column = (command.params as { column?: string }).column

    await ensureAuditDetailsTable(ctx.db)

    // Extract transform type from command type (e.g., 'transform:standardize_date' -> 'standardize_date')
    const transformationType = command.type
      .replace('transform:', '')
      .replace('scrub:', '')
      .replace('edit:', '')

    // Only capture if we have a column (most transforms) or it's a structural transform
    const isStructuralTransform = ['combine_columns', 'split_column'].includes(transformationType)
    if (column || isStructuralTransform) {
      await captureTier23RowDetails(ctx.db, {
        tableName: ctx.table.name,
        column: column || '',
        transformationType,
        auditEntryId,
        params: command.params as Record<string, unknown>,
      })
    }
  }

  /**
   * Capture row details for Tier 1 commands using versioned columns.
   * After a Tier 1 transform:
   *   - column = transformed value (new)
   *   - column__base = original value (before)
   */
  private async captureTier1RowDetails(
    ctx: CommandContext,
    column: string,
    auditEntryId: string
  ): Promise<void> {
    // Ensure audit details table exists before inserting
    await ensureAuditDetailsTable(ctx.db)

    const baseColumn = getBaseColumnName(column)
    const quotedCol = `"${column}"`
    const quotedBase = `"${baseColumn}"`
    const escapedColumn = column.replace(/'/g, "''")

    // Check if base column exists (it should for Tier 1)
    const colsResult = await ctx.db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = '${ctx.table.name}' AND column_name = '${baseColumn}'
    `)

    if (colsResult.length === 0) {
      console.warn(`[EXECUTOR] Base column ${baseColumn} not found, skipping audit capture`)
      return
    }

    // Insert row details: previous = base column, new = transformed column
    // Only include rows where values actually differ
    const sql = `
      INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
      SELECT
        uuid(),
        '${auditEntryId}',
        rowid,
        '${escapedColumn}',
        CAST(${quotedBase} AS VARCHAR),
        CAST(${quotedCol} AS VARCHAR),
        CURRENT_TIMESTAMP
      FROM "${ctx.table.name}"
      WHERE ${quotedBase} IS DISTINCT FROM ${quotedCol}
      LIMIT 50000
    `

    await ctx.db.execute(sql)
  }

  /**
   * Extract affected row IDs from diff view for highlighting support.
   * Non-critical - returns empty array if extraction fails.
   * Limits to MAX_HIGHLIGHT_ROWS to prevent OOM on large datasets.
   *
   * Note: Diff views (created by createTier1DiffView and createTier3DiffView)
   * explicitly alias _cs_id as _row_id, so this column is guaranteed to exist.
   */
  private async extractAffectedRowIds(
    ctx: CommandContext,
    diffViewName: string | undefined
  ): Promise<string[]> {
    if (!diffViewName) return []

    try {
      const MAX_HIGHLIGHT_ROWS = 10000

      const sql = `
        SELECT _row_id
        FROM "${diffViewName}"
        WHERE _change_type != 'unchanged'
        LIMIT ${MAX_HIGHLIGHT_ROWS}
      `

      const result = await ctx.db.query<{ _row_id: string }>(sql)
      // Explicit string conversion for type safety (though _cs_id is already VARCHAR/UUID)
      return result.map(row => String(row._row_id))
    } catch (err) {
      console.warn('[EXECUTOR] Failed to extract affected row IDs from diff view:', err)
      return []
    }
  }

  /**
   * Sync command execution to legacy timelineStore for UI integration
   */
  private syncExecuteToTimelineStore(
    tableId: string,
    tableName: string,
    command: Command,
    auditInfo?: { affectedColumns: string[]; rowsAffected: number; hasRowDetails: boolean; auditEntryId: string },
    affectedRowIds?: string[]
  ): void {
    const timelineStoreState = useTimelineStore.getState()
    const legacyTimeline = timelineStoreState.getTimeline(tableId)

    if (!legacyTimeline) {
      timelineStoreState.createTimeline(tableId, tableName, '')
    }

    const legacyCommandType = this.mapToLegacyCommandType(command.type)
    const column = (command.params as { column?: string }).column

    // Build params based on command type
    // Standardize commands need full params for replay (mappings array)
    let timelineParams: import('@/types').TimelineParams
    if (command.type === 'standardize:apply') {
      const standardizeParams = command.params as { column: string; mappings: unknown[] }
      timelineParams = {
        type: 'standardize',
        columnName: standardizeParams.column,
        mappings: standardizeParams.mappings,
      } as import('@/types').StandardizeParams
    } else if (command.type === 'edit:cell') {
      // Manual edits need complete EditCellParams for replay
      const editParams = command.params as {
        tableId: string
        tableName: string
        csId: string
        columnName: string
        previousValue: unknown
        newValue: unknown
      }
      timelineParams = {
        type: 'manual_edit',
        csId: editParams.csId,
        columnName: editParams.columnName,
        previousValue: editParams.previousValue,
        newValue: editParams.newValue,
      } as import('@/types').ManualEditParams
    } else {
      timelineParams = {
        type: legacyCommandType === 'transform' ? 'transform' : legacyCommandType,
        transformationType: command.type.replace('transform:', '').replace('scrub:', '').replace('edit:', ''),
        column,
      } as import('@/types').TimelineParams
    }

    // Extract cell changes for highlighting (manual edits, batch edits)
    let cellChanges: import('@/types').CellChange[] | undefined
    const commandWithCellChanges = command as unknown as { getCellChanges?: () => import('@/types').CellChange[] }
    if (typeof commandWithCellChanges.getCellChanges === 'function') {
      cellChanges = commandWithCellChanges.getCellChanges()
    }

    timelineStoreState.appendCommand(tableId, legacyCommandType, command.label, timelineParams, {
      auditEntryId: auditInfo?.auditEntryId ?? command.id,
      affectedColumns: auditInfo?.affectedColumns ?? (column ? [column] : []),
      rowsAffected: auditInfo?.rowsAffected,
      hasRowDetails: auditInfo?.hasRowDetails,
      affectedRowIds,
      cellChanges,
    })
  }
}

// ===== SINGLETON EXPORT =====

let executorInstance: CommandExecutor | null = null

/**
 * Get the singleton CommandExecutor instance
 */
export function getCommandExecutor(): CommandExecutor {
  if (!executorInstance) {
    executorInstance = new CommandExecutor()
  }
  return executorInstance
}

/**
 * Reset the executor (for testing)
 */
export function resetCommandExecutor(): void {
  executorInstance = null
  tableTimelines.clear()
}
