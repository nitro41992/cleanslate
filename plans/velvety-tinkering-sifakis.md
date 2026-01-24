# Cold Storage Snapshots: Parquet-Based Undo History

**Status:** 🎯 ARCHITECTURE UPGRADE - READY TO IMPLEMENT
**Branch:** `opfs-ux-polish`
**Date:** January 23, 2026

## Problem Statement

After successful batching implementation, 1M row datasets work but consume 2.7GB RAM due to in-memory snapshot tables:

- Base table: ~1.5GB (1M rows × 30 cols)
- Snapshot 1: ~1.5GB (Pad Zeros)
- Snapshot 2: ~1.5GB (Standardize Date)
- Snapshot 3: ~1.5GB (Standardize Date)

**Issue:** Snapshots stored as DuckDB tables (`_cmd_snapshot_...`) live in active memory, limiting scale.

**Solution:** Move snapshots from **RAM (hot storage)** to **OPFS Disk (cold storage)** using Parquet files.

---

## Architecture Change: Hot → Cold Snapshot Storage

### Current (Hot Storage)
```typescript
// In executor.ts
private async createSnapshot(ctx: CommandContext): Promise<string> {
  const snapshotName = `_cmd_snapshot_${ctx.table.id}_${Date.now()}`
  await duplicateTable(ctx.table.name, snapshotName, true)  // Lives in RAM
  return snapshotName
}
```

**Cost:** ~1.5GB RAM per snapshot

### New (Cold Storage)
```typescript
private async createSnapshot(ctx: CommandContext): Promise<SnapshotMetadata> {
  const snapshotId = `snapshot_${ctx.table.id}_${Date.now()}`

  // For large tables (>500k), use Parquet cold storage
  if (ctx.table.rowCount > 500_000) {
    const parquetPath = `snapshots/${snapshotId}.parquet`

    // Export to Parquet in OPFS
    await this.exportTableToParquet(ctx.table.name, parquetPath)

    return {
      storageType: 'parquet',
      path: parquetPath,
      id: snapshotId
    }
  }

  // For small tables (<500k), use in-memory table (fast undo)
  const snapshotName = `_cmd_snapshot_${ctx.table.id}_${Date.now()}`
  await duplicateTable(ctx.table.name, snapshotName, true)

  return {
    storageType: 'table',
    tableName: snapshotName,
    id: snapshotId
  }
}
```

**Cost:** ~5MB OPFS disk per snapshot (compressed Parquet)

**Benefit:** **500x memory reduction** (1.5GB → 5MB)

---

## Implementation Plan

### Step 1: Add Snapshot Metadata Types

**File:** `src/lib/commands/executor.ts` (top of file)

```typescript
// Add after MAX_SNAPSHOTS_PER_TABLE constant (~line 55)

/**
 * Snapshot storage types
 * - table: In-memory DuckDB table (fast undo, high RAM)
 * - parquet: OPFS Parquet file (slow undo, low RAM)
 */
type SnapshotStorageType = 'table' | 'parquet'

/**
 * Metadata for a snapshot, tracking its storage location
 */
interface SnapshotMetadata {
  id: string
  storageType: SnapshotStorageType
  tableName?: string  // For 'table' storage
  path?: string       // For 'parquet' storage
}

// Update TableCommandTimeline interface (line 65)
interface TableCommandTimeline {
  commands: TimelineCommandRecord[]
  position: number
  snapshots: Map<number, SnapshotMetadata>  // Changed from Map<number, string>
  snapshotTimestamps: Map<number, number>
  originalSnapshot?: SnapshotMetadata       // Changed from string
}
```

### Step 2: Add Parquet Export/Import Utilities

**New File:** `src/lib/opfs/snapshot-storage.ts`

```typescript
/**
 * OPFS Parquet Snapshot Storage
 *
 * Provides cold storage for large table snapshots using Parquet compression.
 * Reduces RAM usage from ~1.5GB (in-memory table) to ~5MB (compressed file).
 *
 * CRITICAL: Uses DuckDB's opfs:// protocol to write directly to OPFS disk,
 * bypassing JavaScript heap entirely. This prevents OOM crashes.
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

/**
 * Export a table to Parquet file in OPFS
 *
 * Uses DuckDB's COPY TO with opfs:// protocol for direct disk writes.
 * Data never touches JavaScript heap - flows from WASM to OPFS disk.
 *
 * @param conn - Active DuckDB connection (for transaction consistency)
 * @param tableName - Source table to export
 * @param snapshotId - Unique snapshot identifier (e.g., "snapshot_abc_1234567890")
 *
 * Performance: ~2-3 seconds for 1M rows (includes compression)
 */
export async function exportTableToParquet(
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string
): Promise<void> {
  const parquetPath = `opfs://cleanslate/snapshots/${snapshotId}.parquet`

  console.log(`[Snapshot] Exporting ${tableName} to OPFS...`)

  // Direct write to OPFS - data stays in WASM layer
  // ZSTD compression: ~10x reduction (1.5GB → 150MB)
  await conn.query(`
    COPY "${tableName}" TO '${parquetPath}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
  `)

  console.log(`[Snapshot] Exported to ${parquetPath}`)
}

/**
 * Import a table from Parquet file in OPFS
 *
 * Uses DuckDB's read_parquet() to load directly from OPFS.
 * Data never touches JavaScript heap - flows from OPFS disk to WASM.
 *
 * @param conn - Active DuckDB connection (for transaction consistency)
 * @param snapshotId - Unique snapshot identifier
 * @param targetTableName - Name for the restored table
 *
 * Performance: ~2-5 seconds for 1M rows (includes decompression)
 */
export async function importTableFromParquet(
  conn: AsyncDuckDBConnection,
  snapshotId: string,
  targetTableName: string
): Promise<void> {
  const parquetPath = `opfs://cleanslate/snapshots/${snapshotId}.parquet`

  console.log(`[Snapshot] Importing from ${parquetPath}...`)

  // Create table from Parquet - direct read from OPFS
  await conn.query(`
    CREATE OR REPLACE TABLE "${targetTableName}" AS
    SELECT * FROM read_parquet('${parquetPath}')
  `)

  console.log(`[Snapshot] Restored ${targetTableName} from OPFS`)
}

/**
 * Delete a Parquet snapshot from OPFS
 *
 * Uses File System Access API to directly remove file.
 */
export async function deleteParquetSnapshot(snapshotId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    await snapshotsDir.removeEntry(`${snapshotId}.parquet`)

    console.log(`[Snapshot] Deleted ${snapshotId}.parquet`)
  } catch (err) {
    console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
  }
}

/**
 * List all Parquet snapshots in OPFS
 */
export async function listParquetSnapshots(): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    const entries: string[] = []

    for await (const [name, _handle] of (snapshotsDir as any).entries()) {
      if (name.endsWith('.parquet')) {
        entries.push(name.replace('.parquet', ''))
      }
    }

    return entries
  } catch {
    return []
  }
}
```

**Key Implementation Details:**

1. **Direct OPFS Protocol:** `opfs://cleanslate/snapshots/` path writes directly to OPFS without JavaScript intermediary
2. **Connection Parameter:** Accepts `AsyncDuckDBConnection` to ensure transaction consistency (critical for undo/redo)
3. **No JavaScript Heap Usage:** Data flows WASM → OPFS (export) and OPFS → WASM (import), never through JS heap
4. **Compression:** ZSTD provides ~10x reduction (1.5GB → 150MB) with fast decompression

**Prerequisites:**
- DuckDB initialized with OPFS support (already done in app)
- OPFS directory `cleanslate/snapshots/` created on first use (auto-created by DuckDB)

### Step 3: Modify `createSnapshot()`

**File:** `src/lib/commands/executor.ts` (line 627)

**Current:**
```typescript
private async createSnapshot(ctx: CommandContext): Promise<string> {
  const snapshotName = `_cmd_snapshot_${ctx.table.id}_${Date.now()}`
  await duplicateTable(ctx.table.name, snapshotName, true)
  return snapshotName
}
```

**New:**
```typescript
private async createSnapshot(ctx: CommandContext): Promise<SnapshotMetadata> {
  const timestamp = Date.now()
  const snapshotId = `snapshot_${ctx.table.id}_${timestamp}`

  // For large tables (>500k rows), use Parquet cold storage
  if (ctx.table.rowCount > 500_000) {
    console.log(`[Snapshot] Creating Parquet snapshot for ${ctx.table.rowCount.toLocaleString()} rows...`)

    await exportTableToParquet(ctx.table.name, snapshotId)

    return {
      id: snapshotId,
      storageType: 'parquet',
      path: `${snapshotId}.parquet`
    }
  }

  // For small tables (<500k rows), use in-memory table (fast undo)
  const snapshotName = `_cmd_snapshot_${ctx.table.id}_${timestamp}`
  await duplicateTable(ctx.table.name, snapshotName, true)

  return {
    id: snapshotId,
    storageType: 'table',
    tableName: snapshotName
  }
}
```

### Step 4: Modify `restoreFromSnapshot()`

**File:** `src/lib/commands/executor.ts` (line 702)

**Current:**
```typescript
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
```

**New:**
```typescript
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

    await dropTable(tableName)
    await importTableFromParquet(snapshot.id, tableName)

    console.log(`[Snapshot] Restored ${tableName} from cold storage`)
  } else {
    throw new Error(`Unknown snapshot storage type: ${snapshot.storageType}`)
  }
}
```

### Step 5: Modify `pruneOldestSnapshot()`

**File:** `src/lib/commands/executor.ts` (line 637)

**Current:**
```typescript
private async pruneOldestSnapshot(timeline: TableCommandTimeline): Promise<void> {
  if (timeline.snapshots.size < MAX_SNAPSHOTS_PER_TABLE) return

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
```

**New:**
```typescript
private async pruneOldestSnapshot(timeline: TableCommandTimeline): Promise<void> {
  if (timeline.snapshots.size < MAX_SNAPSHOTS_PER_TABLE) return

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
    const snapshot = timeline.snapshots.get(oldestPosition)
    if (snapshot) {
      // Delete based on storage type
      if (snapshot.storageType === 'table') {
        await dropTable(snapshot.tableName!).catch(() => {})
      } else if (snapshot.storageType === 'parquet') {
        await deleteParquetSnapshot(snapshot.id)
      }

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
```

### Step 6: Update All Callsites

**Files to update:**
1. `executor.ts` line 171 - `snapshotTableName = await this.createSnapshot(ctx)` → `const snapshotMetadata = await this.createSnapshot(ctx)`
2. `executor.ts` line 235 - `await this.restoreFromSnapshot(ctx.table.name, snapshotTableName)` → `await this.restoreFromSnapshot(ctx.table.name, snapshotMetadata)`
3. `executor.ts` line 308 - Update `recordTimelineCommand()` signature to accept `SnapshotMetadata`
4. `executor.ts` line 443 - `await this.restoreFromSnapshot(ctx.table.name, commandRecord.snapshotTable)` → Accept metadata
5. Update all references to `timeline.originalSnapshot` from `string` to `SnapshotMetadata`

### Step 7: Fix Undo for Batched Tier 1 Commands

**File:** `src/lib/commands/executor.ts` (line 418)

**Add snapshot fallback for batched commands:**

```typescript
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
```

### Step 8: Fix Diff NaN Error

**File:** `src/lib/diff-engine.ts` (line 115)

**Replace:**
```typescript
// Check available memory (70% threshold for safety)
const memStatus = await getMemoryStatus()
const availableBytes = memStatus.limitBytes - memStatus.usedBytes
const threshold = availableBytes * 0.7
```

**With:**
```typescript
// Use 2GB fallback to avoid NaN errors from memory detection
const FALLBACK_LIMIT_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
let availableBytes = FALLBACK_LIMIT_BYTES

try {
  const memStatus = await getMemoryStatus()
  if (memStatus.limitBytes > 0 && !isNaN(memStatus.limitBytes)) {
    availableBytes = Math.max(
      memStatus.limitBytes - memStatus.usedBytes,
      FALLBACK_LIMIT_BYTES * 0.3 // Minimum 600MB available
    )
  }
} catch (err) {
  console.warn('[Diff] Memory status unavailable, using 2GB fallback:', err)
}

const threshold = availableBytes * 0.7
```

---

## Critical Blocker: DuckDB Virtual Filesystem Access

The Parquet export/import approach requires accessing DuckDB-WASM's virtual filesystem to:
1. Export table to `/tmp/snapshot.parquet` in virtual FS
2. Read the Parquet bytes from virtual FS
3. Write bytes to OPFS
4. Reverse for import: Read from OPFS → Write to virtual FS → Load table

**Investigation needed:**
- Does DuckDB-WASM expose a filesystem API (e.g., `db.fs.readFile()`)?
- Can we use `COPY TO` with OPFS paths directly?
- Alternative: Export via `SELECT * FROM table` and manually write Parquet (complex)

**Fallback if no FS access:**
- Use CSV export instead of Parquet (larger files, ~500MB vs 150MB)
- Still achieves cold storage goal (disk vs RAM)

---

## Verification Plan

### Test 1: Small Table (<500k rows) - Should Use Hot Storage

1. Load 100k row CSV
2. Run Tier 3 transformation (creates snapshot)
3. Verify: Console shows "Creating in-memory snapshot" (not Parquet)
4. Click Undo
5. Verify: Instant undo (<100ms)

### Test 2: Large Table (>500k rows) - Should Use Cold Storage

1. Load 1M row CSV
2. Run 3 Tier 3 transformations (Pad Zeros, Standardize Date ×2)
3. Verify: Console shows "Creating Parquet snapshot for 1,010,000 rows"
4. Check RAM usage: Should be **<1GB** (vs 2.7GB before)
5. Click Undo (3 times)
6. Verify: Each undo takes 2-5 seconds (loading from disk)
7. Verify: Data reverts correctly
8. Verify: No "undefined column" errors

### Test 3: Diff After Undo

1. After Test 2, click Diff button
2. Verify: No NaN errors
3. Verify: Diff completes successfully

### Expected Console Logs

```
[Executor] Large operation (1,010,000 rows), using batch mode
[Snapshot] Creating Parquet snapshot for 1,010,000 rows...
[Snapshot] Exported to OPFS: snapshot_abc123_1234567890.parquet (142MB)
[Executor] Undo: Restoring from Parquet snapshot...
[Snapshot] Restoring from Parquet: snapshot_abc123_1234567890.parquet
[Snapshot] Restored my_table from cold storage (2.3s)
```

---

## Files to Create/Modify

### New Files
1. **`src/lib/opfs/snapshot-storage.ts`** (~200 lines)
   - `exportTableToParquet()`
   - `importTableFromParquet()`
   - `deleteParquetSnapshot()`
   - Virtual FS access helpers

### Modified Files
1. **`src/lib/commands/executor.ts`**
   - Add `SnapshotMetadata` types (~15 lines)
   - Modify `createSnapshot()` (~25 lines)
   - Modify `restoreFromSnapshot()` (~20 lines)
   - Modify `pruneOldestSnapshot()` (~10 lines)
   - Fix Tier 1 undo fallback (~10 lines)
   - Update callsites (~10 lines)
   - **Total:** ~90 lines changed

2. **`src/lib/diff-engine.ts`**
   - Fix NaN error with fallback (~15 lines)

**Total:** 1 new file + 2 modified files, ~300 lines

---

## Performance Impact

### Memory Reduction
| Dataset | Before (Hot Storage) | After (Cold Storage) | Savings |
|---------|---------------------|----------------------|---------|
| 1M rows × 30 cols | 2.7GB RAM | **<1GB RAM** | **1.7GB** |
| 3 snapshots | 4.5GB RAM | **<1GB RAM** | **3.5GB** |

### Undo Speed Trade-off
| Storage Type | Undo Time | Memory Cost |
|--------------|-----------|-------------|
| Hot (in-memory table) | <100ms | 1.5GB |
| Cold (OPFS Parquet) | 2-5 seconds | 5MB |

**Acceptable trade-off:** For datasets >500k rows, 2-5 second undo is reasonable to enable unlimited scale.

---

## Risk Assessment

### High Risk
- **DuckDB virtual FS access** - May not be exposed by DuckDB-WASM
  - **Mitigation:** Use CSV export fallback if Parquet not feasible

### Medium Risk
- **Parquet write performance** - May be slower than expected
  - **Mitigation:** Show progress indicator during snapshot creation

### Low Risk
- **OPFS browser compatibility** - Already used elsewhere in app
- **Type signature changes** - Confined to executor.ts

---

## Rollback Plan

If critical issues arise:
1. Revert to `string` snapshot type (remove `SnapshotMetadata`)
2. Keep hot storage only (in-memory tables)
3. Restore old `createSnapshot()` / `restoreFromSnapshot()` implementations

**Fast rollback:** All changes confined to 2 files, single commit.

---

## Next Steps

1. **Investigate DuckDB-WASM virtual filesystem API** (30 min)
   - Check DuckDB-WASM documentation
   - Test if `COPY TO '/tmp/file.parquet'` works
   - Determine if we can read bytes from virtual FS

2. **Implement snapshot-storage.ts** (2 hours)
   - Export/import functions
   - OPFS file management
   - Error handling

3. **Update executor.ts** (2 hours)
   - Modify snapshot methods
   - Update type signatures
   - Fix callsites

4. **Testing** (2 hours)
   - Verify hot/cold storage decision
   - Test undo on 1M rows
   - Validate memory usage
   - Test diff functionality

**Total Estimate:** 6-8 hours implementation + testing
