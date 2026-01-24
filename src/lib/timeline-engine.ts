/**
 * Timeline Engine - Handles replay and snapshot management for the timeline feature
 *
 * Key responsibilities:
 * 1. Replay commands to reach a specific position (using nearest snapshot for optimization)
 * 2. Create snapshots before expensive operations
 * 3. Apply individual commands during replay
 */

import {
  execute,
  query,
  duplicateTable,
  tableExists,
  dropTable,
  updateCellByRowId,
  CS_ID_COLUMN,
  getTableColumns,
  initDuckDB,
  getConnection,
} from '@/lib/duckdb'
import { applyTransformation, EXPENSIVE_TRANSFORMS } from '@/lib/transformations'
import { applyStandardization } from '@/lib/standardizer-engine'
import { useTimelineStore } from '@/stores/timelineStore'
import { exportTableToParquet, importTableFromParquet } from '@/lib/opfs/snapshot-storage'
import type {
  TimelineCommand,
  TimelineParams,
  TransformParams,
  ManualEditParams,
  StandardizeParams,
  BatchEditParams,
  ColumnInfo,
} from '@/types'

/**
 * Threshold for using Parquet storage for original snapshots
 * Tables with ≥100k rows use OPFS Parquet, smaller tables use in-memory duplicates
 */
const ORIGINAL_SNAPSHOT_THRESHOLD = 100_000

/**
 * Naming convention for timeline snapshots
 */
export function getTimelineSnapshotName(timelineId: string, stepIndex: number): string {
  return `_timeline_snapshot_${timelineId}_${stepIndex}`
}

/**
 * Naming convention for timeline original snapshot
 */
export function getTimelineOriginalName(timelineId: string): string {
  return `_timeline_original_${timelineId}`
}

/**
 * Create the original snapshot for a table's timeline
 * This is called when a timeline is first created for a table
 *
 * Uses Parquet storage for large tables (≥100k rows) to reduce baseline RAM usage
 * Returns special "parquet:" prefix for Parquet-backed snapshots
 */
export async function createTimelineOriginalSnapshot(
  tableName: string,
  timelineId: string
): Promise<string> {
  // Check row count to decide storage strategy
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const rowCount = Number(countResult[0].count)

  if (rowCount >= ORIGINAL_SNAPSHOT_THRESHOLD) {
    console.log(`[Timeline] Creating Parquet original snapshot for ${rowCount.toLocaleString()} rows...`)

    const db = await initDuckDB()
    const conn = await getConnection()
    const snapshotId = `original_${timelineId}`

    // Export to OPFS Parquet
    await exportTableToParquet(db, conn, tableName, snapshotId)
    await db.dropFile(`${snapshotId}.parquet`)  // Critical: release handle

    // Return special prefix to signal Parquet storage (keeps store type as string)
    return `parquet:${snapshotId}`
  }

  // Small table - use in-memory duplicate (existing behavior)
  const originalName = `_timeline_original_${timelineId}`
  const exists = await tableExists(originalName)
  if (!exists) {
    await duplicateTable(tableName, originalName, true)
  }
  return originalName
}

/**
 * Restore a table from a timeline original snapshot
 * Handles both in-memory and Parquet-backed snapshots
 */
export async function restoreTimelineOriginalSnapshot(
  tableName: string,
  snapshotName: string
): Promise<void> {
  if (snapshotName.startsWith('parquet:')) {
    // Extract snapshot ID from "parquet:original_abc123"
    const snapshotId = snapshotName.replace('parquet:', '')

    console.log(`[Timeline] Restoring from Parquet: ${snapshotId}`)
    const db = await initDuckDB()
    const conn = await getConnection()

    // Drop current table
    await dropTable(tableName)

    // Import from OPFS
    await importTableFromParquet(db, conn, snapshotId, tableName)
  } else {
    // In-memory snapshot (existing behavior)
    await dropTable(tableName)
    await duplicateTable(snapshotName, tableName, true)
  }
}

/**
 * Create a snapshot at a specific step index (before expensive operation)
 * Uses Parquet storage for large tables to prevent RAM spikes
 */
export async function createStepSnapshot(
  tableName: string,
  timelineId: string,
  stepIndex: number
): Promise<string> {
  // Check row count to decide storage strategy
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const rowCount = Number(countResult[0].count)

  if (rowCount >= ORIGINAL_SNAPSHOT_THRESHOLD) {
    console.log(`[Timeline] Creating Parquet step snapshot for ${rowCount.toLocaleString()} rows at step ${stepIndex}...`)

    const db = await initDuckDB()
    const conn = await getConnection()
    const snapshotId = `snapshot_${timelineId}_${stepIndex}`

    // Export to OPFS Parquet
    await exportTableToParquet(db, conn, tableName, snapshotId)
    await db.dropFile(`${snapshotId}.parquet`)  // Critical: release handle

    // Register in store with parquet: prefix
    const tableId = findTableIdByTimeline(timelineId)
    if (tableId) {
      useTimelineStore.getState().createSnapshot(tableId, stepIndex, `parquet:${snapshotId}`)
    }

    return `parquet:${snapshotId}`
  }

  // Small table - use in-memory duplicate (existing behavior)
  const snapshotName = getTimelineSnapshotName(timelineId, stepIndex)
  const exists = await tableExists(snapshotName)
  if (!exists) {
    await duplicateTable(tableName, snapshotName, true)
  }

  // Register in store
  const tableId = findTableIdByTimeline(timelineId)
  if (tableId) {
    useTimelineStore.getState().createSnapshot(tableId, stepIndex, snapshotName)
  }

  return snapshotName
}

/**
 * Find tableId from timelineId
 */
function findTableIdByTimeline(timelineId: string): string | null {
  const timelines = useTimelineStore.getState().timelines
  for (const [tableId, timeline] of timelines) {
    if (timeline.id === timelineId) {
      return tableId
    }
  }
  return null
}

/**
 * Apply a single command to a table
 * Used during replay
 */
export async function applyCommand(
  tableName: string,
  command: TimelineCommand
): Promise<void> {
  const params = command.params

  switch (params.type) {
    case 'transform':
      await applyTransformCommand(tableName, params)
      break

    case 'manual_edit':
      await applyManualEditCommand(tableName, params)
      break

    case 'standardize':
      await applyStandardizeCommand(tableName, params)
      break

    case 'batch_edit':
      await applyBatchEditCommand(tableName, params)
      break

    case 'merge':
      // Merge operations are complex - for now, we'll need to re-execute the delete
      await applyMergeCommand(tableName, params)
      break

    case 'stack':
    case 'join':
    case 'scrub':
      // These create new tables, not modify existing ones
      // Timeline replay for these is handled differently
      console.warn(`Command type ${params.type} requires special handling in replay`)
      break

    default:
      console.warn(`Unknown command type: ${(params as TimelineParams).type}`)
  }
}

/**
 * Apply a transformation command
 */
async function applyTransformCommand(
  tableName: string,
  params: TransformParams
): Promise<void> {
  const step = {
    id: 'replay',
    type: params.transformationType,
    column: params.column,
    params: params.params,
    label: `Replay: ${params.transformationType}`,
  }

  // Skip audit tracking during replay
  await applyTransformation(tableName, step)
}

/**
 * Apply a manual edit command
 */
async function applyManualEditCommand(
  tableName: string,
  params: ManualEditParams
): Promise<void> {
  await updateCellByRowId(tableName, params.csId, params.columnName, params.newValue)
}

/**
 * Apply a standardize command
 */
async function applyStandardizeCommand(
  tableName: string,
  params: StandardizeParams
): Promise<void> {
  // Skip audit tracking during replay by passing empty auditEntryId
  await applyStandardization(
    tableName,
    params.columnName,
    params.mappings,
    'replay-no-audit'
  )
}

/**
 * Apply a batch edit command
 */
async function applyBatchEditCommand(
  tableName: string,
  params: BatchEditParams
): Promise<void> {
  for (const change of params.changes) {
    await updateCellByRowId(tableName, change.csId, change.columnName, change.newValue)
  }
}

/**
 * Apply a merge command (delete duplicate rows)
 */
async function applyMergeCommand(
  tableName: string,
  params: { type: 'merge'; matchColumn: string; mergedPairs: { keepRowId: string; deleteRowId: string }[] }
): Promise<void> {
  // Delete the rows that were marked for deletion
  const rowIdsToDelete = params.mergedPairs.map((p) => p.deleteRowId)

  if (rowIdsToDelete.length === 0) return

  // Build WHERE clause with all row IDs
  const whereClause = rowIdsToDelete.map((id) => `'${id}'`).join(', ')

  await execute(`
    DELETE FROM "${tableName}"
    WHERE "${CS_ID_COLUMN}" IN (${whereClause})
  `)
}

/**
 * Replay timeline to a specific position
 * Uses nearest snapshot for optimization
 *
 * @param tableId - The table ID
 * @param targetPosition - The target position (-1 = original state)
 * @param onProgress - Optional progress callback
 */
export async function replayToPosition(
  tableId: string,
  targetPosition: number,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[] }> {
  console.log('[REPLAY] replayToPosition called', { tableId, targetPosition })
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline) {
    console.error('[REPLAY] Timeline not found for table:', tableId)
    throw new Error(`Timeline not found for table ${tableId}`)
  }

  const { tableName, commands, originalSnapshotName } = timeline
  console.log('[REPLAY] Timeline info:', {
    tableName,
    commandCount: commands.length,
    originalSnapshotName,
    currentPosition: timeline.currentPosition,
  })

  // Validate target position
  if (targetPosition < -1 || targetPosition >= commands.length) {
    console.error('[REPLAY] Invalid target position:', targetPosition)
    throw new Error(`Invalid target position: ${targetPosition}`)
  }

  store.setIsReplaying(true)
  console.log('[REPLAY] Starting replay...')

  try {
    onProgress?.(0, 'Finding nearest snapshot...')

    // Find the nearest snapshot at or before target position
    const snapshot = store.getSnapshotBefore(tableId, targetPosition)
    const snapshotIndex = snapshot?.index ?? -1
    let snapshotTableName = snapshot?.tableName ?? originalSnapshotName

    console.log('[REPLAY] Snapshot search result:', {
      snapshot,
      snapshotIndex,
      snapshotTableName,
      originalSnapshotName,
    })

    // Handle missing or empty snapshot name
    if (!snapshotTableName) {
      // Try to create the original snapshot from current table state
      // This is a recovery path for timelines created before proper snapshot handling
      console.warn('[REPLAY] Timeline has no original snapshot, creating one now')
      snapshotTableName = await createTimelineOriginalSnapshot(tableName, timeline.id)
      store.updateTimelineOriginalSnapshot(tableId, snapshotTableName)
    }

    // Verify snapshot exists (handle both Parquet and in-memory)
    const isParquetSnapshot = snapshotTableName.startsWith('parquet:')
    const snapshotExists = isParquetSnapshot || await tableExists(snapshotTableName)
    console.log('[REPLAY] Snapshot exists check:', { snapshotTableName, snapshotExists, isParquetSnapshot })

    if (!snapshotExists) {
      // Last resort: try to create snapshot from current table
      console.warn('[REPLAY] Snapshot not found, creating from current state (THIS IS BAD - will capture modified data)')
      snapshotTableName = await createTimelineOriginalSnapshot(tableName, timeline.id)
      store.updateTimelineOriginalSnapshot(tableId, snapshotTableName)
    }

    onProgress?.(10, `Restoring from ${snapshotIndex === -1 ? 'original' : `step ${snapshotIndex}`}...`)

    // Restore from snapshot (handle both Parquet and in-memory)
    console.log('[REPLAY] Restoring table from snapshot:', { tableName, snapshotTableName, isParquetSnapshot })
    if (snapshotTableName.startsWith('parquet:')) {
      await restoreTimelineOriginalSnapshot(tableName, snapshotTableName)
    } else {
      await execute(`DROP TABLE IF EXISTS "${tableName}"`)
      await duplicateTable(snapshotTableName, tableName, true)
    }

    // Debug: Query a sample of the restored data
    const sampleData = await query<Record<string, unknown>>(`SELECT * FROM "${tableName}" LIMIT 3`)
    console.log('[REPLAY] Table restored from snapshot. Sample data:', sampleData)

    // If target is at or before snapshot, we're done
    if (targetPosition <= snapshotIndex) {
      onProgress?.(100, 'Complete')
      store.setPosition(tableId, targetPosition)
      store.setIsReplaying(false)
      // Get row count AND columns for caller to update tableStore
      const countResult = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${tableName}"`)
      const columns = await getTableColumns(tableName)
      const userColumns = columns.filter(c => c.name !== CS_ID_COLUMN)
      return { rowCount: Number(countResult[0].count), columns: userColumns }
    }

    // Replay commands from (snapshotIndex + 1) to targetPosition
    const commandsToReplay = commands.slice(snapshotIndex + 1, targetPosition + 1)
    const totalCommands = commandsToReplay.length

    console.log('[REPLAY] Commands to replay:', {
      snapshotIndex,
      targetPosition,
      totalCommands,
      commandLabels: commandsToReplay.map(c => c.label),
    })

    for (let i = 0; i < commandsToReplay.length; i++) {
      const cmd = commandsToReplay[i]

      // Progress: 10-90% for replay, leaving 10% for final steps
      const progress = 10 + Math.round((i / totalCommands) * 80)
      onProgress?.(progress, `Replaying: ${cmd.label}...`)

      console.log('[REPLAY] Replaying command:', { index: i, label: cmd.label, type: cmd.commandType })

      // Check if this command needs a snapshot created before it
      const absoluteIndex = snapshotIndex + 1 + i
      if (cmd.isExpensive && !timeline.snapshots.has(absoluteIndex)) {
        // We should have a snapshot here but don't - create one
        // This can happen if we're replaying forward past an expensive op
        // Note: During normal forward execution, snapshots are created before execution
        // During replay, we're recreating state, so we create snapshot after reaching that state
      }

      await applyCommand(tableName, cmd)
      console.log('[REPLAY] Command applied')
      store.setReplayProgress(progress)
    }

    onProgress?.(95, 'Finalizing...')

    // Update position in store
    store.setPosition(tableId, targetPosition)

    // Get row count AND columns for caller to update tableStore
    const countResult = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${tableName}"`)
    const columns = await getTableColumns(tableName)
    const userColumns = columns.filter(c => c.name !== CS_ID_COLUMN)

    onProgress?.(100, 'Complete')
    return { rowCount: Number(countResult[0].count), columns: userColumns }
  } finally {
    store.setIsReplaying(false)
    store.setReplayProgress(0)
  }
}

/**
 * Undo to the previous position
 * Returns the new row count and columns on success, or undefined if cannot undo
 */
export async function undoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[] } | undefined> {
  console.log('[TIMELINE] undoTimeline called for tableId:', tableId)
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  console.log('[TIMELINE] Timeline found:', timeline ? {
    id: timeline.id,
    tableName: timeline.tableName,
    currentPosition: timeline.currentPosition,
    commandCount: timeline.commands.length,
    originalSnapshotName: timeline.originalSnapshotName,
    commands: timeline.commands.map((c, i) => ({ index: i, label: c.label, type: c.commandType })),
  } : null)

  if (!timeline || timeline.currentPosition < 0) {
    console.log('[TIMELINE] Cannot undo - no timeline or at original state')
    return undefined
  }

  const targetPosition = timeline.currentPosition - 1
  console.log('[TIMELINE] Target position for undo:', targetPosition)
  return await replayToPosition(tableId, targetPosition, onProgress)
}

/**
 * Redo to the next position
 * Returns the new row count and columns on success, or undefined if cannot redo
 */
export async function redoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[] } | undefined> {
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline || timeline.currentPosition >= timeline.commands.length - 1) {
    return undefined
  }

  const targetPosition = timeline.currentPosition + 1
  return await replayToPosition(tableId, targetPosition, onProgress)
}

/**
 * Cleanup all timeline snapshots for a table
 * Called when a table is deleted
 * Handles both in-memory and Parquet snapshots
 */
export async function cleanupTimelineSnapshots(tableId: string): Promise<void> {
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline) return

  const { deleteParquetSnapshot } = await import('@/lib/opfs/snapshot-storage')

  // Drop original snapshot
  try {
    if (timeline.originalSnapshotName.startsWith('parquet:')) {
      const snapshotId = timeline.originalSnapshotName.replace('parquet:', '')
      await deleteParquetSnapshot(snapshotId)
      console.log(`[Timeline] Deleted Parquet original snapshot: ${snapshotId}`)
    } else {
      await dropTable(timeline.originalSnapshotName)
    }
  } catch (e) {
    console.warn(`Failed to drop original snapshot: ${e}`)
  }

  // Drop all step snapshots
  for (const snapshotName of timeline.snapshots.values()) {
    try {
      if (snapshotName.startsWith('parquet:')) {
        const snapshotId = snapshotName.replace('parquet:', '')
        await deleteParquetSnapshot(snapshotId)
        console.log(`[Timeline] Deleted Parquet step snapshot: ${snapshotId}`)
      } else {
        await dropTable(snapshotName)
      }
    } catch (e) {
      console.warn(`Failed to drop snapshot ${snapshotName}: ${e}`)
    }
  }

  // Remove timeline from store
  store.deleteTimeline(tableId)
}

/**
 * Get the current state diff between two positions
 * Useful for showing what changed between steps
 */
export async function getPositionDiff(
  tableId: string,
  fromPosition: number,
  toPosition: number
): Promise<{
  addedRows: number
  removedRows: number
  modifiedCells: number
}> {
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline) {
    throw new Error(`Timeline not found for table ${tableId}`)
  }

  // Get commands in range
  const startIdx = Math.min(fromPosition, toPosition) + 1
  const endIdx = Math.max(fromPosition, toPosition) + 1
  const commands = timeline.commands.slice(startIdx, endIdx)

  let addedRows = 0
  let removedRows = 0
  let modifiedCells = 0

  for (const cmd of commands) {
    // Estimate based on command type
    switch (cmd.commandType) {
      case 'manual_edit':
        modifiedCells += 1
        break
      case 'batch_edit':
        modifiedCells += cmd.cellChanges?.length ?? 0
        break
      case 'transform':
        modifiedCells += cmd.rowsAffected ?? 0
        break
      case 'merge':
        removedRows += cmd.rowsAffected ?? 0
        break
      case 'stack':
        addedRows += cmd.rowsAffected ?? 0
        break
      default:
        // Unknown or complex operation
        break
    }
  }

  return { addedRows, removedRows, modifiedCells }
}

/**
 * Initialize timeline for an existing table (on first edit or transform)
 */
export async function initializeTimeline(
  tableId: string,
  tableName: string
): Promise<string> {
  console.log('[INIT_TIMELINE] initializeTimeline called', { tableId, tableName })
  const store = useTimelineStore.getState()

  // Check if timeline already exists
  const existing = store.getTimeline(tableId)
  if (existing) {
    console.log('[INIT_TIMELINE] Timeline already exists:', {
      id: existing.id,
      originalSnapshotName: existing.originalSnapshotName,
      commandCount: existing.commands.length,
      currentPosition: existing.currentPosition,
    })
    // Verify the original snapshot exists, create if missing
    if (existing.originalSnapshotName) {
      const exists = await tableExists(existing.originalSnapshotName)
      console.log('[INIT_TIMELINE] Original snapshot exists:', exists)
      if (!exists) {
        console.log('[INIT_TIMELINE] Creating missing original snapshot...')
        const snapshotName = await createTimelineOriginalSnapshot(tableName, existing.id)
        store.updateTimelineOriginalSnapshot(tableId, snapshotName)
      }
    } else {
      // No original snapshot name set, create one
      console.log('[INIT_TIMELINE] No original snapshot name, creating one...')
      const snapshotName = await createTimelineOriginalSnapshot(tableName, existing.id)
      store.updateTimelineOriginalSnapshot(tableId, snapshotName)
    }
    return existing.id
  }

  console.log('[INIT_TIMELINE] Creating new timeline...')
  // Create timeline with a temporary empty snapshot name
  const timelineId = store.createTimeline(tableId, tableName, '')

  // Create original snapshot
  console.log('[INIT_TIMELINE] Creating original snapshot...')
  const originalSnapshotName = await createTimelineOriginalSnapshot(tableName, timelineId)
  console.log('[INIT_TIMELINE] Original snapshot created:', originalSnapshotName)

  // Update timeline with the actual snapshot name using proper store method
  store.updateTimelineOriginalSnapshot(tableId, originalSnapshotName)

  return timelineId
}

/**
 * Record a command and optionally create a snapshot before expensive operations
 */
export async function recordCommand(
  tableId: string,
  tableName: string,
  commandType: TimelineCommand['commandType'],
  label: string,
  params: TimelineParams,
  options: {
    auditEntryId?: string
    affectedRowIds?: string[]
    affectedColumns?: string[]
    cellChanges?: TimelineCommand['cellChanges']
    rowsAffected?: number
    hasRowDetails?: boolean
  } = {}
): Promise<TimelineCommand> {
  const store = useTimelineStore.getState()

  // Ensure timeline exists
  let timeline = store.getTimeline(tableId)
  if (!timeline) {
    await initializeTimeline(tableId, tableName)
    timeline = store.getTimeline(tableId)!
  }

  // Check if this will be an expensive operation
  const isExpensive = isExpensiveOperation(commandType, params)

  // Create snapshot BEFORE expensive operations
  if (isExpensive) {
    const currentPosition = timeline.currentPosition
    // Snapshot index = currentPosition (state after command at currentPosition, before new command)
    // This ensures getSnapshotBefore(currentPosition) finds this snapshot for fast undo
    await createStepSnapshot(tableName, timeline.id, currentPosition)
  }

  // Record the command
  const command = store.appendCommand(
    tableId,
    commandType,
    label,
    params,
    options
  )

  return command
}

/**
 * Check if an operation is expensive (requires snapshot)
 */
function isExpensiveOperation(
  commandType: TimelineCommand['commandType'],
  params: TimelineParams
): boolean {
  // These operations are always expensive
  if (['merge', 'join', 'stack'].includes(commandType)) {
    return true
  }

  // Check for expensive transformations using the shared constant
  if (commandType === 'transform' && params.type === 'transform') {
    return EXPENSIVE_TRANSFORMS.has(params.transformationType)
  }

  return false
}
