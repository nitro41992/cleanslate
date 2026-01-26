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
import {
  exportTableToParquet,
  importTableFromParquet,
  checkSnapshotFileExists,
} from '@/lib/opfs/snapshot-storage'
import type {
  TimelineCommand,
  TimelineParams,
  TransformParams,
  ManualEditParams,
  StandardizeParams,
  BatchEditParams,
  ColumnInfo,
  TableTimeline,
} from '@/types'

/**
 * Mutex to prevent concurrent timeline initialization for the same tableId.
 *
 * This is critical because:
 * 1. React Strict Mode can cause double-renders, triggering duplicate calls
 * 2. Vite HMR can remount components while Parquet export is in progress
 * 3. Concurrent calls writing to the same Parquet files causes corruption
 *
 * The mutex tracks in-flight Promises so subsequent calls wait for the first to complete.
 */
const initializationInFlight = new Map<string, Promise<string>>()

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
 * Check if a table name represents a timeline snapshot
 * Snapshot tables can be safely dropped after Parquet export
 * Active tables (user-facing) must NEVER be dropped
 */
export function isSnapshotTable(tableName: string): boolean {
  return (
    tableName.startsWith('_timeline_original_') ||
    tableName.startsWith('_timeline_snapshot_') ||
    tableName.startsWith('_mat_') ||
    tableName.startsWith('_custom_sql_before_')
  )
}

/**
 * Get all snapshot tables currently in DuckDB memory
 * Used for debugging and memory profiling
 */
export async function listSnapshotTables(): Promise<string[]> {
  const tables = await query<{ table_name: string }>(`
    SELECT table_name
    FROM duckdb_tables()
    WHERE NOT internal
  `)

  return tables
    .map(t => t.table_name)
    .filter(name => isSnapshotTable(name))
}

/**
 * Create the original snapshot for a table's timeline
 * This is called when a timeline is first created for a table
 *
 * Uses Parquet storage for large tables (≥100k rows) to reduce baseline RAM usage
 * Returns special "parquet:" prefix for Parquet-backed snapshots
 *
 * IMPORTANT: Uses tableName (sanitized) for snapshot naming for cross-session resilience.
 * This allows detecting existing snapshots even after page reload or HMR.
 */
export async function createTimelineOriginalSnapshot(
  tableName: string,
  _timelineId: string,
  _tableId?: string
): Promise<string> {
  // Use sanitized tableName for snapshot naming (survives page reloads)
  // This ensures the same file loaded twice uses the same snapshot
  // Note: timelineId and tableId params kept for backwards compatibility but unused
  const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  const snapshotId = `original_${sanitizedTableName}`

  // IDEMPOTENCY CHECK: If Parquet files already exist, reuse them
  // This prevents HMR/Strict Mode/page reloads from overwriting snapshots with modified data
  const existingSnapshot = await checkSnapshotFileExists(snapshotId)
  if (existingSnapshot) {
    console.log(`[Timeline] Original snapshot already exists, reusing: parquet:${snapshotId}`)
    return `parquet:${snapshotId}`
  }

  // Check row count to decide storage strategy
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const rowCount = Number(countResult[0].count)

  if (rowCount >= ORIGINAL_SNAPSHOT_THRESHOLD) {
    console.log(`[Timeline] Creating Parquet original snapshot for ${rowCount.toLocaleString()} rows...`)

    const db = await initDuckDB()
    const conn = await getConnection()

    // Export to OPFS Parquet using direct call (no wrapper needed)
    await exportTableToParquet(db, conn, tableName, snapshotId)

    // Return special prefix to signal Parquet storage (keeps store type as string)
    return `parquet:${snapshotId}`
  }

  // Small table - export to Parquet like large tables do
  // OPTIMIZATION: Export active table directly (no duplicate needed)
  // DuckDB handles read consistency, so no risk of corruption during export

  try {
    // Export active table directly to OPFS Parquet
    // This is safe because:
    // 1. DuckDB uses MVCC (multi-version concurrency control)
    // 2. Export reads from a consistent snapshot of the table
    // 3. No temporary RAM allocation needed (saves ~150MB for small tables)
    const db = await initDuckDB()
    const conn = await getConnection()
    await exportTableToParquet(db, conn, tableName, snapshotId)

    console.log(`[Timeline] Exported original snapshot to OPFS (${rowCount.toLocaleString()} rows)`)

    // Return Parquet reference (same as large table path)
    return `parquet:${snapshotId}`

  } catch (error) {
    // On export failure, fall back to in-memory duplicate
    console.error('[Timeline] Parquet export failed, creating in-memory snapshot fallback:', error)

    const tempSnapshotName = `_timeline_original_${sanitizedTableName}`
    await duplicateTable(tableName, tempSnapshotName, true)

    // Return the in-memory table name instead of Parquet reference
    return tempSnapshotName
  }
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

    // Export to OPFS Parquet (file handles are dropped inside exportTableToParquet)
    await exportTableToParquet(db, conn, tableName, snapshotId)

    // Register in store with parquet: prefix
    const tableId = findTableIdByTimeline(timelineId)
    if (tableId) {
      useTimelineStore.getState().createSnapshot(tableId, stepIndex, `parquet:${snapshotId}`)
    }

    return `parquet:${snapshotId}`
  }

  // Small table - export to Parquet like large tables do
  // OPTIMIZATION: Export active table directly (no duplicate needed)
  const db = await initDuckDB()
  const conn = await getConnection()
  const snapshotId = `snapshot_${timelineId}_${stepIndex}`

  try {
    // Export active table directly to OPFS Parquet
    // Safe due to DuckDB MVCC - reads from consistent snapshot
    await exportTableToParquet(db, conn, tableName, snapshotId)

    console.log(`[Timeline] Exported step ${stepIndex} snapshot to OPFS (${rowCount.toLocaleString()} rows)`)

    // Register in store with Parquet reference
    const tableId = findTableIdByTimeline(timelineId)
    if (tableId) {
      useTimelineStore.getState().createSnapshot(tableId, stepIndex, `parquet:${snapshotId}`)
    }

    return `parquet:${snapshotId}`

  } catch (error) {
    // On export failure, fall back to in-memory duplicate
    console.error('[Timeline] Parquet export failed, creating in-memory snapshot fallback:', error)

    const tempSnapshotName = getTimelineSnapshotName(timelineId, stepIndex)
    await duplicateTable(tableName, tempSnapshotName, true)

    // Register in-memory table
    const tableId = findTableIdByTimeline(timelineId)
    if (tableId) {
      useTimelineStore.getState().createSnapshot(tableId, stepIndex, tempSnapshotName)
    }

    return tempSnapshotName
  }
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
): Promise<{ rowCount: number; columns: ColumnInfo[]; columnOrder?: string[] }> {
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
      snapshotTableName = await createTimelineOriginalSnapshot(tableName, timeline.id, tableId)
      store.updateTimelineOriginalSnapshot(tableId, snapshotTableName)
    }

    // Verify snapshot exists (handle both Parquet and in-memory)
    const isParquetSnapshot = snapshotTableName.startsWith('parquet:')
    const snapshotExists = isParquetSnapshot || await tableExists(snapshotTableName)
    console.log('[REPLAY] Snapshot exists check:', { snapshotTableName, snapshotExists, isParquetSnapshot })

    if (!snapshotExists) {
      // Last resort: try to create snapshot from current table
      console.warn('[REPLAY] Snapshot not found, creating from current state (THIS IS BAD - will capture modified data)')
      snapshotTableName = await createTimelineOriginalSnapshot(tableName, timeline.id, tableId)
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
      // Resolve column order at target position
      const columnOrder = resolveColumnOrder(timeline, targetPosition)
      return { rowCount: Number(countResult[0].count), columns: userColumns, columnOrder }
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
    // Resolve column order at target position
    const columnOrder = resolveColumnOrder(timeline, targetPosition)

    onProgress?.(100, 'Complete')
    return { rowCount: Number(countResult[0].count), columns: userColumns, columnOrder }
  } finally {
    store.setIsReplaying(false)
    store.setReplayProgress(0)
  }
}

/**
 * Convert a value to SQL literal for use in UPDATE statements
 */
function toSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'string') {
    // Escape single quotes by doubling them
    return `'${value.replace(/'/g, "''")}'`
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  // For other types, convert to string
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Execute inverse UPDATE for Fast Path undo of manual_edit commands.
 *
 * Validates that the column exists before attempting the update.
 * Returns false if column doesn't exist (edge case: user edits column A → renames to B → undoes rename → undoes edit)
 *
 * @param tableName - The table to update
 * @param csId - The _cs_id of the row to update
 * @param columnName - The column to update
 * @param previousValue - The value to restore
 * @returns true if successful, false if column doesn't exist
 */
async function executeInverseUpdate(
  tableName: string,
  csId: string,
  columnName: string,
  previousValue: unknown
): Promise<boolean> {
  // SAFETY: Validate column exists before attempting update
  const columns = await getTableColumns(tableName)
  const columnExists = columns.some(c => c.name === columnName)

  if (!columnExists) {
    console.warn(`[FastPath] Column "${columnName}" not found in table, falling back to Heavy Path`)
    return false
  }

  const sqlValue = toSqlValue(previousValue)
  await execute(`UPDATE "${tableName}" SET "${columnName}" = ${sqlValue} WHERE "${CS_ID_COLUMN}" = '${csId}'`)
  return true
}

/**
 * Find the effective columnOrder at a given timeline position.
 * Walks backward to find the most recent command with columnOrderAfter,
 * or returns undefined to signal "use current tableStore order".
 *
 * @param timeline - The timeline to search
 * @param position - The position to resolve column order for (-1 = original, 0+ = after command at index)
 * @returns Column order array if found, undefined otherwise
 */
function resolveColumnOrder(timeline: TableTimeline, position: number): string[] | undefined {
  // Walk backward from position to find last command that set columnOrder
  for (let i = position; i >= 0; i--) {
    const cmd = timeline.commands[i]
    if (cmd.columnOrderAfter) {
      return cmd.columnOrderAfter
    }
  }
  // No command has columnOrder - return undefined, caller uses tableStore's current order
  return undefined
}

/**
 * Undo to the previous position
 * Returns the new row count, columns, and columnOrder on success, or undefined if cannot undo
 *
 * Uses Fast Path for manual_edit commands (instant inverse SQL) when possible.
 * Falls back to Heavy Path (snapshot restore + replay) for transforms.
 */
export async function undoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[]; columnOrder?: string[] } | undefined> {
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

  const command = timeline.commands[timeline.currentPosition]

  // FAST PATH: Manual edits use inverse SQL (instant, no snapshot restore)
  if (command.params.type === 'manual_edit') {
    console.log('[TIMELINE] Fast Path: Undoing manual_edit via inverse SQL')
    const params = command.params as ManualEditParams
    const success = await executeInverseUpdate(
      timeline.tableName,
      params.csId,
      params.columnName,
      params.previousValue
    )

    if (!success) {
      // Column doesn't exist (edge case after column operations) - fall back to Heavy Path
      console.log('[TIMELINE] Fast Path failed, falling back to Heavy Path')
      const targetPosition = timeline.currentPosition - 1
      return await replayToPosition(tableId, targetPosition, onProgress)
    }

    // Update position
    store.setPosition(tableId, timeline.currentPosition - 1)

    // Return current table state (no full reload needed)
    const columns = await getTableColumns(timeline.tableName)
    const countResult = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${timeline.tableName}"`)

    // Resolve column order from timeline or fall back to command's columnOrderBefore
    const columnOrder = resolveColumnOrder(timeline, timeline.currentPosition - 1) || command.columnOrderBefore

    console.log('[TIMELINE] Fast Path undo completed')
    return {
      rowCount: Number(countResult[0].count),
      columns: columns.filter(c => c.name !== CS_ID_COLUMN),
      columnOrder,
    }
  }

  // HEAVY PATH: Transforms use snapshot restore + replay
  const targetPosition = timeline.currentPosition - 1
  console.log('[TIMELINE] Heavy Path: Target position for undo:', targetPosition)
  return await replayToPosition(tableId, targetPosition, onProgress)
}

/**
 * Redo to the next position
 * Returns the new row count, columns, and columnOrder on success, or undefined if cannot redo
 *
 * Uses Fast Path for manual_edit commands (instant re-execute) when possible.
 * Falls back to Heavy Path (snapshot restore + replay) for transforms.
 */
export async function redoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[]; columnOrder?: string[] } | undefined> {
  console.log('[TIMELINE] redoTimeline called for tableId:', tableId)
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline || timeline.currentPosition >= timeline.commands.length - 1) {
    console.log('[TIMELINE] Cannot redo - no timeline or at latest state')
    return undefined
  }

  const nextPosition = timeline.currentPosition + 1
  const command = timeline.commands[nextPosition]

  // FAST PATH: Manual edits use direct SQL execution (instant)
  if (command.params.type === 'manual_edit') {
    console.log('[TIMELINE] Fast Path: Redoing manual_edit via direct SQL')
    const params = command.params as ManualEditParams
    const success = await executeForwardUpdate(
      timeline.tableName,
      params.csId,
      params.columnName,
      params.newValue
    )

    if (!success) {
      // Column doesn't exist - fall back to Heavy Path
      console.log('[TIMELINE] Fast Path failed, falling back to Heavy Path')
      return await replayToPosition(tableId, nextPosition, onProgress)
    }

    // Update position
    store.setPosition(tableId, nextPosition)

    // Return current table state
    const columns = await getTableColumns(timeline.tableName)
    const countResult = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${timeline.tableName}"`)

    // Resolve column order from the command being redone
    const columnOrder = command.columnOrderAfter || resolveColumnOrder(timeline, nextPosition)

    console.log('[TIMELINE] Fast Path redo completed')
    return {
      rowCount: Number(countResult[0].count),
      columns: columns.filter(c => c.name !== CS_ID_COLUMN),
      columnOrder,
    }
  }

  // HEAVY PATH: Transforms use snapshot restore + replay
  console.log('[TIMELINE] Heavy Path: Target position for redo:', nextPosition)
  return await replayToPosition(tableId, nextPosition, onProgress)
}

/**
 * Execute forward UPDATE for Fast Path redo of manual_edit commands.
 *
 * @param tableName - The table to update
 * @param csId - The _cs_id of the row to update
 * @param columnName - The column to update
 * @param newValue - The value to set
 * @returns true if successful, false if column doesn't exist
 */
async function executeForwardUpdate(
  tableName: string,
  csId: string,
  columnName: string,
  newValue: unknown
): Promise<boolean> {
  // SAFETY: Validate column exists before attempting update
  const columns = await getTableColumns(tableName)
  const columnExists = columns.some(c => c.name === columnName)

  if (!columnExists) {
    console.warn(`[FastPath] Column "${columnName}" not found in table, falling back to Heavy Path`)
    return false
  }

  const sqlValue = toSqlValue(newValue)
  await execute(`UPDATE "${tableName}" SET "${columnName}" = ${sqlValue} WHERE "${CS_ID_COLUMN}" = '${csId}'`)
  return true
}

/**
 * Cleanup all timeline snapshots for a table
 * Called when a table is deleted
 * Handles both in-memory and Parquet snapshots
 */
export async function cleanupTimelineSnapshots(tableId: string): Promise<void> {
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  const { deleteParquetSnapshot } = await import('@/lib/opfs/snapshot-storage')

  // Try to delete by tableName-based snapshot (current naming scheme)
  // This handles cases where the timeline store was reset but OPFS files still exist
  if (timeline?.tableName) {
    try {
      const sanitizedTableName = timeline.tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      await deleteParquetSnapshot(`original_${sanitizedTableName}`)
      console.log(`[Timeline] Deleted Parquet snapshot by tableName: original_${sanitizedTableName}`)
    } catch (e) {
      // Expected if file doesn't exist
    }
  }

  if (!timeline) return

  // Drop original snapshot (using stored name, may use old naming schemes)
  try {
    if (timeline.originalSnapshotName.startsWith('parquet:')) {
      const snapshotId = timeline.originalSnapshotName.replace('parquet:', '')
      const sanitizedTableName = timeline.tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      // Skip if it's the tableName-based snapshot (already deleted above)
      if (snapshotId !== `original_${sanitizedTableName}`) {
        await deleteParquetSnapshot(snapshotId)
        console.log(`[Timeline] Deleted Parquet original snapshot: ${snapshotId}`)
      }
    } else if (timeline.originalSnapshotName) {
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

  // MUTEX: Check if initialization is already in flight for this tableId
  // This prevents race conditions from React Strict Mode double-renders or HMR remounts
  const existingPromise = initializationInFlight.get(tableId)
  if (existingPromise) {
    console.log('[INIT_TIMELINE] Initialization already in flight, waiting...', { tableId })
    return existingPromise
  }

  // Create and store the promise BEFORE any async operations
  // This ensures subsequent calls will wait for this one
  const initPromise = initializeTimelineInternal(tableId, tableName)
  initializationInFlight.set(tableId, initPromise)

  try {
    return await initPromise
  } finally {
    // Clean up the mutex entry after completion (success or failure)
    initializationInFlight.delete(tableId)
  }
}

/**
 * Internal implementation of timeline initialization (called by mutex wrapper)
 */
async function initializeTimelineInternal(
  tableId: string,
  tableName: string
): Promise<string> {
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
      // Check if original snapshot still exists (handle both Parquet and in-memory)
      let exists = false
      const snapshotName = existing.originalSnapshotName

      if (snapshotName.startsWith('parquet:')) {
        // Check OPFS using helper (maintains abstraction)
        const snapshotId = snapshotName.replace('parquet:', '')
        exists = await checkSnapshotFileExists(snapshotId)
      } else {
        // Check DuckDB for in-memory table
        exists = await tableExists(snapshotName)
      }

      console.log(
        '[INIT_TIMELINE] Original snapshot exists:',
        exists,
        `(type: ${snapshotName.startsWith('parquet:') ? 'Parquet' : 'table'})`
      )

      if (!exists) {
        console.error('[INIT_TIMELINE] CRITICAL: Original snapshot file missing!', snapshotName)
        console.error('[INIT_TIMELINE] This may indicate a cleanup bug or storage corruption')
        console.error('[INIT_TIMELINE] Timeline has', existing.commands.length, 'commands - diff functionality may be compromised')
        // DO NOT recreate from current state - that would destroy diff accuracy
        // The snapshot name stays in timeline for reference, but diffs will fail with clear error
      }
    } else {
      // No original snapshot name set, create one
      console.log('[INIT_TIMELINE] No original snapshot name, creating one...')
      const snapshotName = await createTimelineOriginalSnapshot(tableName, existing.id, tableId)
      store.updateTimelineOriginalSnapshot(tableId, snapshotName)
    }
    return existing.id
  }

  // CRITICAL: Check for existing Parquet snapshot using tableName BEFORE creating new timeline
  // This handles page reloads and HMR scenarios where the timeline store was reset but OPFS files still exist
  // Using sanitized tableName ensures same file loaded twice uses same snapshot
  const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  const potentialSnapshotId = `original_${sanitizedTableName}`
  const existingParquetSnapshot = await checkSnapshotFileExists(potentialSnapshotId)
  if (existingParquetSnapshot) {
    // SIMPLIFIED APPROACH: For now, always delete existing snapshots on timeline init
    // This ensures _cs_id values always match (fresh snapshot from current table)
    // Trade-off: Loses original state on page reload, but prevents stale snapshot bugs
    //
    // TODO: Implement metadata-based validation (store first N _cs_id values in a sidecar file)
    // to enable safe snapshot reuse without complex Parquet queries
    console.log('[INIT_TIMELINE] Found existing Parquet snapshot, deleting to ensure fresh state:', potentialSnapshotId)
    const { deleteParquetSnapshot } = await import('@/lib/opfs/snapshot-storage')
    await deleteParquetSnapshot(potentialSnapshotId)
    // Fall through to create new snapshot below
  }

  console.log('[INIT_TIMELINE] Creating new timeline...')
  // Create timeline with a temporary empty snapshot name
  const timelineId = store.createTimeline(tableId, tableName, '')

  // Create original snapshot using tableName for cross-session resilience
  console.log('[INIT_TIMELINE] Creating original snapshot...')
  const originalSnapshotName = await createTimelineOriginalSnapshot(tableName, timelineId, tableId)
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
