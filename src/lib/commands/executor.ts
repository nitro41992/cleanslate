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
import { duplicateTable, dropTable, tableExists } from '@/lib/duckdb'

// ===== TIMELINE STORAGE =====

// Per-table timeline of executed commands for undo/redo
// Key: tableId, Value: { commands, position, snapshots }
interface TableCommandTimeline {
  commands: TimelineCommandRecord[]
  position: number // -1 = before first command, 0+ = after command at that index
  snapshots: Map<number, string> // position -> snapshot table name
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
    return !!timeline && timeline.position >= 0
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
      // Clean up orphaned snapshots
      for (const [pos, name] of timeline.snapshots.entries()) {
        if (pos > timeline.position) {
          dropTable(name).catch(() => {})
          timeline.snapshots.delete(pos)
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
      affectedColumns: [], // Will be populated from audit info
      cellChanges,
    }

    timeline.commands.push(record)
    timeline.position = timeline.commands.length - 1

    // Store snapshot reference if provided
    if (snapshotTable) {
      timeline.snapshots.set(timeline.position, snapshotTable)
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
    result: { rowCount: number; columns: { name: string; type: string; nullable: boolean }[]; newColumnNames?: string[]; droppedColumnNames?: string[] }
  ): void {
    const tableStore = useTableStore.getState()
    tableStore.updateTable(tableId, {
      rowCount: result.rowCount,
      columns: result.columns,
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
