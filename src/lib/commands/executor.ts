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
import { duplicateTable, dropTable, tableExists } from '@/lib/duckdb'
import {
  ensureAuditDetailsTable,
  captureTier23RowDetails,
} from './audit-capture'
import { getBaseColumnName } from './column-versions'
import type { TimelineCommandType } from '@/types'

// ===== TIMELINE STORAGE =====

/**
 * Maximum number of Tier 3 snapshots per table.
 * LRU eviction removes oldest when limit exceeded.
 */
const MAX_SNAPSHOTS_PER_TABLE = 5

// Per-table timeline of executed commands for undo/redo
// Key: tableId, Value: { commands, position, snapshots }
interface TableCommandTimeline {
  commands: TimelineCommandRecord[]
  position: number // -1 = before first command, 0+ = after command at that index
  snapshots: Map<number, string> // position -> snapshot table name
  snapshotTimestamps: Map<number, number> // position -> timestamp for LRU tracking
  originalSnapshot?: string // Initial state snapshot
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
    // Clean up snapshot tables
    for (const snapshotName of timeline.snapshots.values()) {
      dropTable(snapshotName).catch(() => {
        // Ignore errors during cleanup
      })
    }
    if (timeline.originalSnapshot) {
      dropTable(timeline.originalSnapshot).catch(() => {})
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

      // Step 3: Pre-snapshot for Tier 3
      let snapshotTableName: string | undefined
      if (needsSnapshot && !skipTimeline) {
        progress('snapshotting', 20, 'Creating backup snapshot...')
        snapshotTableName = await this.createSnapshot(ctx)

        // If this is the first snapshot for this table, set it as originalSnapshotName
        // so the Diff View can compare against original state
        const timelineStoreState = useTimelineStore.getState()
        let existingTimeline = timelineStoreState.getTimeline(tableId)

        // Create timeline if it doesn't exist yet
        if (!existingTimeline) {
          timelineStoreState.createTimeline(tableId, ctx.table.name, snapshotTableName)
          existingTimeline = timelineStoreState.getTimeline(tableId)
        } else if (!existingTimeline.originalSnapshotName) {
          // Timeline exists but no original snapshot set yet
          timelineStoreState.updateTimelineOriginalSnapshot(tableId, snapshotTableName)
        }

        // Prune oldest snapshot if over limit
        await this.pruneOldestSnapshot(getTimeline(tableId))
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

      // Step 4: Execute
      progress('executing', 40, 'Executing command...')
      const executionResult = await command.execute(ctx)

      if (!executionResult.success) {
        // Rollback snapshot if execution failed
        if (snapshotTableName) {
          await this.restoreFromSnapshot(ctx.table.name, snapshotTableName)
        }
        return {
          success: false,
          executionResult,
          error: executionResult.error || 'Command execution failed',
        }
      }

      // Refresh context with new schema
      const updatedCtx = await refreshTableContext(ctx)

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
          snapshotTableName
        )
      }

      // Extract affected row IDs from diff view for highlighting support
      const affectedRowIds = await this.extractAffectedRowIds(updatedCtx, diffViewName)

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
          snapshotTableName,
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
          // Tier 1: Column versioning undo
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

  private async createSnapshot(ctx: CommandContext): Promise<string> {
    const snapshotName = `_cmd_snapshot_${ctx.table.id}_${Date.now()}`
    await duplicateTable(ctx.table.name, snapshotName, true)
    return snapshotName
  }

  /**
   * Prune oldest snapshot if over limit (LRU eviction).
   * Marks the corresponding command as undoDisabled.
   */
  private async pruneOldestSnapshot(timeline: TableCommandTimeline): Promise<void> {
    if (timeline.snapshots.size <= MAX_SNAPSHOTS_PER_TABLE) return

    // Find oldest by timestamp
    let oldestPosition = -1
    let oldestTimestamp = Infinity

    for (const [pos, ts] of timeline.snapshotTimestamps) {
      if (ts < oldestTimestamp) {
        oldestTimestamp = ts
        oldestPosition = pos
      }
    }

    if (oldestPosition >= 0) {
      const snapshotName = timeline.snapshots.get(oldestPosition)
      if (snapshotName) {
        // Drop the snapshot table
        await dropTable(snapshotName).catch(() => {})
        timeline.snapshots.delete(oldestPosition)
        timeline.snapshotTimestamps.delete(oldestPosition)

        // Mark the command as undoDisabled
        const command = timeline.commands[oldestPosition]
        if (command) {
          command.undoDisabled = true
        }
      }
    }
  }

  private async restoreFromSnapshot(
    tableName: string,
    snapshotName: string
  ): Promise<void> {
    const exists = await tableExists(snapshotName)
    if (!exists) {
      throw new Error(`Snapshot ${snapshotName} not found`)
    }

    // Drop current table and duplicate from snapshot
    await dropTable(tableName)
    await duplicateTable(snapshotName, tableName, true)
  }

  private async createDiffView(
    ctx: CommandContext,
    tier: UndoTier,
    rowPredicate: string | null,
    affectedColumn: string | null,
    snapshotTable?: string
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
      if (tier === 3 && snapshotTable) {
        // Tier 3 with snapshot - can show deleted/added rows
        return await createTier3DiffView(ctx, { ...config, snapshotTable })
      } else {
        // Tier 1/2 - show modified rows based on predicate
        return await createTier1DiffView(ctx, config)
      }
    } catch {
      // Diff view creation is non-critical, don't fail the command
      return undefined
    }
  }

  private findNearestSnapshot(
    timeline: TableCommandTimeline,
    maxPosition: number
  ): string | undefined {
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
    snapshotTable?: string,
    backupColumn?: string,
    rowPredicate?: string | null
  ): Promise<void> {
    const timeline = getTimeline(tableId)

    // Truncate any commands after current position (for redo)
    if (timeline.position < timeline.commands.length - 1) {
      timeline.commands = timeline.commands.slice(0, timeline.position + 1)
      // Clean up orphaned snapshots and timestamps
      for (const [pos, name] of timeline.snapshots.entries()) {
        if (pos > timeline.position) {
          dropTable(name).catch(() => {})
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
      snapshotTable,
      backupColumn,
      inverseSql,
      rowPredicate,
      affectedColumns,
      cellChanges,
    }

    timeline.commands.push(record)
    timeline.position = timeline.commands.length - 1

    // Store snapshot reference and timestamp if provided
    if (snapshotTable) {
      timeline.snapshots.set(timeline.position, snapshotTable)
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
    } else {
      timelineParams = {
        type: legacyCommandType === 'transform' ? 'transform' : legacyCommandType,
        transformationType: command.type.replace('transform:', '').replace('scrub:', '').replace('edit:', ''),
        column,
      } as import('@/types').TimelineParams
    }

    timelineStoreState.appendCommand(tableId, legacyCommandType, command.label, timelineParams, {
      auditEntryId: auditInfo?.auditEntryId ?? command.id,
      affectedColumns: auditInfo?.affectedColumns ?? (column ? [column] : []),
      rowsAffected: auditInfo?.rowsAffected,
      hasRowDetails: auditInfo?.hasRowDetails,
      affectedRowIds,
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
