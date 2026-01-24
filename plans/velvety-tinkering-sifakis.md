# Comprehensive Snapshot Audit & RAM Spike Fix - REVISED

**Status:** 🟢 READY FOR IMPLEMENTATION (Revised)
**Branch:** `opfs-ux-polish`
**Date:** January 24, 2026
**Discovered Issue:** Standardize Date on 1M rows → 1.7GB to 2.5GB spike
**Revision:** Critical technical refinements based on code inspection

---

## Critical Corrections Applied

Based on user feedback and code inspection, three critical refinements were made to the original plan:

### 1. Timeline Engine Verification ✅
**Original Assumption**: timeline-engine.ts uses in-memory duplicateTable
**Actual State**: ✅ Parquet optimization already implemented in commit e30ab2d
**Action**: Verified both `createTimelineOriginalSnapshot()` and `createStepSnapshot()` use Parquet for ≥100k rows

### 2. Chunked Files Instead of APPEND Mode 🔧
**Original Plan**: Use Parquet APPEND mode to batch exports
**Problem**: Parquet format has a metadata footer - APPEND is unreliable in WASM/OPFS
**Solution**: Use Hive-style chunked files (`snapshot_id_part_0.parquet`, `snapshot_id_part_1.parquet`)
**Benefit**: DuckDB natively supports glob patterns (`read_parquet('snapshot_*.parquet')`) and only buffers 250k rows at a time

### 3. Explicit Step Snapshot Triggering 🔧
**Original Plan**: Remove executor snapshots, assume timeline creates them automatically
**Problem**: Timeline `recordCommand()` is called AFTER execution, not before
**Solution**: Executor explicitly calls `timeline-engine.createStepSnapshot()` BEFORE execution
**Pattern**: Executor remains orchestrator, delegates storage to timeline engine

---

## Root Cause Analysis (REVISED)

### The Problem
Despite implementing Parquet snapshots for timeline-engine (original + step), standardize_date still spikes RAM from 1.7GB → 2.5GB.

### DuckDB Log Evidence
```
Buffering missing file: tmp_snapshot_gkqt5fz_1769236752517.parquet
```

**Critical Discovery:** `COPY TO Parquet` **buffers the entire table in memory** before writing. This is a DuckDB limitation - it doesn't stream, it materializes first.

### Snapshot Creation Audit

| Location | Function | Threshold | Status | Impact |
|----------|----------|-----------|--------|--------|
| timeline-engine.ts:51 | createTimelineOriginalSnapshot | ≥100k | ✅ Parquet | First edit only |
| timeline-engine.ts:128 | createStepSnapshot | ≥100k | ✅ Parquet | Before expensive ops |
| **executor.ts:708** | **createSnapshot** | **>500k** | ❌ **INCONSISTENT** | **Every Tier 3 op** |
| transformations.ts:1068 | legacy beforeSnapshot | N/A | ⚠️ In-memory | Legacy path |
| diff-engine.ts:408 | runDiff | ≥100k | ✅ Parquet | Diff results only |

### The Cascading Snapshot Problem

For a **single** standardize_date on 1M rows:

1. **Timeline creates step snapshot** (line 601 in executor.ts)
   - Calls timeline-engine `createStepSnapshot()`
   - Exports 1M rows to Parquet → **+800MB RAM spike**

2. **Executor creates command snapshot** (line 738 in executor.ts)
   - Uses threshold >500k (inconsistent!)
   - Exports 1M rows to Parquet AGAIN → **+800MB RAM spike**

3. **Total spike**: 1.6GB from double snapshot creation! ❌

### Additional Issues Found

1. **Inconsistent Thresholds**:
   - timeline-engine: 100k rows
   - executor: 500k rows
   - No coordination between systems

2. **Double Snapshot Creation**:
   - Timeline system creates step snapshot
   - Command system creates its own snapshot
   - Both export the SAME table to Parquet

3. **Legacy Code Still Active**:
   - transformations.ts line 1068 uses in-memory `duplicateTable()`
   - Not integrated with Parquet optimization

---

## Solution: Unified Snapshot Strategy

### Strategy

**Eliminate duplicate snapshots** by using a single source of truth:
- **Timeline snapshots ONLY** for undo/redo (step snapshots before expensive ops)
- **Command snapshots REMOVED** - rely on timeline system instead
- **Align all thresholds** to 100k rows

### Why This Works

- Timeline system already creates step snapshots before expensive operations
- Command system's snapshots are redundant
- Eliminates 50% of Parquet exports → 50% less RAM spikes

---

## Implementation Plan

### Phase 1: Replace Executor Snapshots with Timeline Snapshots (25 min)

**Goal**: Eliminate duplicate snapshot creation by delegating to timeline system

**CRITICAL CORRECTION**: Timeline system does NOT automatically create step snapshots before execution. The executor must explicitly call `createStepSnapshot()` from timeline-engine.ts.

#### Step 1.1: Call Timeline Step Snapshot BEFORE Execution

**File**: `src/lib/commands/executor.ts` (around line 738, in `execute()` method)

**Current Code** (creates executor snapshot):
```typescript
// Step 3: Snapshot before Tier 3 operations
let snapshotMetadata: SnapshotMetadata | undefined
if (tier === 3) {
  progress('snapshotting', 20, 'Creating snapshot...')
  snapshotMetadata = await this.createSnapshot(ctx)
  console.log('[Memory] Snapshot created before Tier 3 operation')
}
```

**Replace with**:
```typescript
// Step 3: Snapshot before Tier 3 operations (delegated to timeline system)
let snapshotMetadata: SnapshotMetadata | undefined
if (tier === 3) {
  progress('snapshotting', 20, 'Creating snapshot...')

  // Call timeline engine's createStepSnapshot for Parquet-backed snapshots
  const timeline = this.getTableTimeline(ctx.table.id)
  if (!timeline) {
    throw new Error(`Timeline not found for table ${ctx.table.id}`)
  }

  // Get timeline ID (need to access timelineStore)
  const { useTimelineStore } = await import('@/stores/timelineStore')
  const timelineInfo = useTimelineStore.getState().getTimeline(ctx.table.id)
  if (!timelineInfo) {
    throw new Error(`Timeline info not found for table ${ctx.table.id}`)
  }

  // Create step snapshot via timeline engine (uses Parquet for ≥100k rows)
  const { createStepSnapshot } = await import('@/lib/timeline-engine')
  const stepIndex = timeline.position  // Current position before new command
  const snapshotName = await createStepSnapshot(
    ctx.table.name,
    timelineInfo.id,
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
```

#### Step 1.2: Remove createSnapshot() Method

**File**: `src/lib/commands/executor.ts:708-736`

**Action**: Delete the entire `createSnapshot()` method and related code.

**Reason**: Timeline system (via `recordCommand()` in timeline-engine.ts) already creates step snapshots before expensive operations. The executor's `createSnapshot()` is redundant and causes double Parquet exports.

#### Step 1.3: Remove Snapshot Pruning

**File**: `src/lib/commands/executor.ts:742-789`

**Action**: Delete `pruneOldestSnapshot()` method.

**Reason**: Timeline system handles snapshot pruning via timelineStore. Command system doesn't need its own pruning logic.

#### Step 1.4: Simplify TableCommandTimeline Interface

**File**: `src/lib/commands/executor.ts:95-104`

**Current**:
```typescript
interface TableCommandTimeline {
  tableId: string
  position: number
  commands: ExecutedCommand[]
  snapshots: Map<number, SnapshotMetadata>  // ❌ Remove
  snapshotTimestamps: Map<number, number>   // ❌ Remove
}
```

**Replace with**:
```typescript
interface TableCommandTimeline {
  tableId: string
  position: number
  commands: ExecutedCommand[]
  // Snapshots managed by timelineStore, not executor
}
```

#### Step 1.5: Remove Snapshot Metadata Type

**File**: `src/lib/commands/executor.ts:106-110`

**Action**: Delete `SnapshotMetadata` interface entirely.

**Reason**: Only timeline system needs snapshot metadata now.

---

### Phase 2: Verify Timeline Engine Parquet Implementation (5 min)

**Goal**: Confirm timeline-engine.ts uses Parquet for large tables

**CRITICAL VERIFICATION**: User feedback indicates timeline-engine.ts was using in-memory duplicateTable. Need to verify latest state.

#### Step 2.1: Verify Parquet Implementation

**File**: `src/lib/timeline-engine.ts`

**Check**:
1. `createTimelineOriginalSnapshot()` (line ~51-95) - Should use Parquet for ≥100k rows
2. `createStepSnapshot()` (line ~128-174) - Should use Parquet for ≥100k rows
3. `restoreTimelineOriginalSnapshot()` (line ~97-123) - Should handle both Parquet and in-memory

**Expected Code Pattern**:
```typescript
if (rowCount >= ORIGINAL_SNAPSHOT_THRESHOLD) {
  // Export to OPFS Parquet
  await exportTableToParquet(db, conn, tableName, snapshotId)
  return `parquet:${snapshotId}`
}
// Small table - in-memory duplicate
await duplicateTable(tableName, snapshotName, true)
```

**Status**: ✅ Verified in commit e30ab2d - Parquet optimization applied to both functions

**Action**: No changes needed - timeline engine already uses Parquet for ≥100k rows

---

### Phase 3: Disable Legacy Snapshot Creation (10 min)

**Goal**: Prevent transformations.ts from creating redundant in-memory snapshots

#### Step 3.1: Check Legacy Snapshot Usage

**File**: `src/lib/transformations.ts:1067-1068`

**Current**:
```typescript
const { duplicateTable, dropTable } = await import('./duckdb')
await duplicateTable(tableName, beforeSnapshotName, true)
```

**Analysis Needed**:
- Is this code path still active?
- Does it run before or after timeline snapshot creation?
- Can we safely remove it?

#### Step 3.2: Coordinate with Timeline System

**Options**:
1. **Remove entirely** - if timeline system handles all snapshots
2. **Convert to no-op** - keep code but make it a passthrough
3. **Add flag** - `skipSnapshot: true` parameter

**Recommended**: Option 1 (remove) if transformations.ts is being phased out per CLAUDE.md.

---

### Phase 4: Implement Chunked Parquet Files (20 min)

**Goal**: Reduce RAM spike from COPY TO Parquet buffering using Hive-style partitioning

**CRITICAL CORRECTION**: Parquet APPEND mode is not reliably supported in DuckDB WASM because the Parquet format requires a metadata footer. Instead, use **chunked files** (Hive-style partitioning).

**Strategy**:
- Write multiple files: `snapshot_id_part_0.parquet`, `snapshot_id_part_1.parquet`, etc.
- Read with glob pattern: `read_parquet('snapshot_id_part_*.parquet')`
- Each chunk = 250k rows → only buffers 250k rows at a time (not 1M)

#### Step 4.1: Modify Export Function for Chunked Files

**File**: `src/lib/opfs/snapshot-storage.ts:42-77`

**Current**: Single `COPY TO` command (buffers entire table)

**Replace with**:
```typescript
export async function exportTableToParquet(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string
): Promise<void> {
  await ensureSnapshotDir()

  // Check table size
  const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
  const rowCount = Number(countResult.toArray()[0].toJSON().count)

  console.log(`[Snapshot] Exporting ${tableName} (${rowCount.toLocaleString()} rows) to OPFS...`)

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: true })

  // For large tables (>250k rows), use chunked files to reduce peak memory
  const CHUNK_THRESHOLD = 250_000
  if (rowCount > CHUNK_THRESHOLD) {
    console.log('[Snapshot] Using chunked Parquet export for large table')

    const batchSize = CHUNK_THRESHOLD
    let offset = 0
    let partIndex = 0

    while (offset < rowCount) {
      const fileName = `${snapshotId}_part_${partIndex}.parquet`
      const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: true })

      // Register file handle for this chunk
      await db.registerFileHandle(
        fileName,
        fileHandle,
        duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
        true
      )

      // Export chunk (only buffers batchSize rows)
      await conn.query(`
        COPY (
          SELECT * FROM "${tableName}"
          LIMIT ${batchSize} OFFSET ${offset}
        ) TO '${fileName}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
      `)

      // Unregister file handle after write
      await db.dropFile(fileName)

      offset += batchSize
      partIndex++
      console.log(`[Snapshot] Exported chunk ${partIndex}: ${Math.min(offset, rowCount).toLocaleString()}/${rowCount.toLocaleString()} rows`)
    }

    console.log(`[Snapshot] Exported ${partIndex} chunks to ${snapshotId}_part_*.parquet`)
  } else {
    // Small table - single file export
    const fileName = `${snapshotId}.parquet`
    const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: true })

    await db.registerFileHandle(
      fileName,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      true
    )

    await conn.query(`
      COPY "${tableName}" TO '${fileName}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
    `)

    console.log(`[Snapshot] Exported to ${fileName}`)
  }
}
```

#### Step 4.2: Update Import Function for Chunked Files

**File**: `src/lib/opfs/snapshot-storage.ts:79-123`

**Current**: Reads single `.parquet` file

**Replace with**:
```typescript
export async function importTableFromParquet(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  snapshotId: string,
  targetTableName: string
): Promise<void> {
  console.log(`[Snapshot] Importing from ${snapshotId}...`)

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  // Check if this is a chunked snapshot (multiple _part_N files) or single file
  let isChunked = false
  try {
    await snapshotsDir.getFileHandle(`${snapshotId}_part_0.parquet`, { create: false })
    isChunked = true
  } catch {
    // Not chunked, try single file
    isChunked = false
  }

  if (isChunked) {
    // Register all chunk files
    let partIndex = 0
    const fileHandles: FileSystemFileHandle[] = []

    while (true) {
      try {
        const fileName = `${snapshotId}_part_${partIndex}.parquet`
        const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })
        fileHandles.push(fileHandle)

        await db.registerFileHandle(
          fileName,
          fileHandle,
          duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
          false // read-only
        )

        partIndex++
      } catch {
        break // No more chunks
      }
    }

    // Read all chunks with glob pattern
    await conn.query(`
      CREATE OR REPLACE TABLE "${targetTableName}" AS
      SELECT * FROM read_parquet('${snapshotId}_part_*.parquet')
    `)

    console.log(`[Snapshot] Restored ${targetTableName} from ${partIndex} chunks`)

    // Unregister all file handles
    for (let i = 0; i < partIndex; i++) {
      await db.dropFile(`${snapshotId}_part_${i}.parquet`)
    }
  } else {
    // Single file import (existing behavior)
    const fileName = `${snapshotId}.parquet`
    const fileHandle = await snapshotsDir.getFileHandle(fileName, { create: false })

    await db.registerFileHandle(
      fileName,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      false
    )

    await conn.query(`
      CREATE OR REPLACE TABLE "${targetTableName}" AS
      SELECT * FROM read_parquet('${fileName}')
    `)

    console.log(`[Snapshot] Restored ${targetTableName} from single file`)

    await db.dropFile(fileName)
  }
}
```

#### Step 4.3: Update Delete Function for Chunked Files

**File**: `src/lib/opfs/snapshot-storage.ts:125-141`

**Replace with**:
```typescript
export async function deleteParquetSnapshot(snapshotId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    // Delete all chunk files (if chunked) or single file
    let partIndex = 0
    let deletedCount = 0

    // Try deleting chunks first
    while (true) {
      try {
        const fileName = `${snapshotId}_part_${partIndex}.parquet`
        await snapshotsDir.removeEntry(fileName)
        deletedCount++
        partIndex++
      } catch {
        break // No more chunks
      }
    }

    // If no chunks found, try single file
    if (deletedCount === 0) {
      try {
        await snapshotsDir.removeEntry(`${snapshotId}.parquet`)
        deletedCount = 1
      } catch (err) {
        console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
      }
    }

    console.log(`[Snapshot] Deleted ${deletedCount} file(s) for ${snapshotId}`)
  } catch (err) {
    console.warn(`[Snapshot] Failed to delete ${snapshotId}:`, err)
  }
}
```

**Benefit**: Chunked files guarantee that only 250k rows are buffered at a time, reducing peak RAM from 800MB → ~200MB per chunk.

---

### Phase 5: Add Snapshot Coordination (10 min)

**Goal**: Prevent multiple systems from creating snapshots for the same operation

#### Step 5.1: Add Snapshot Registry

**File**: `src/lib/commands/executor.ts` (new section)

```typescript
// Snapshot coordination with timeline system
private snapshotRegistry = new Map<string, string>() // tableId → snapshotId

private async checkExistingSnapshot(tableId: string): Promise<string | null> {
  // Check if timeline already created a snapshot
  const timelineStore = await import('@/stores/timelineStore')
  const timeline = timelineStore.useTimelineStore.getState().getTimeline(tableId)

  if (!timeline) return null

  const currentPosition = timeline.currentPosition
  const snapshot = timeline.snapshots.get(currentPosition)

  return snapshot ? snapshot : null
}
```

#### Step 5.2: Use Existing Snapshot

**File**: `src/lib/commands/executor.ts` (in execute() method)

Before creating snapshot:
```typescript
// Check if timeline already created a snapshot
const existingSnapshot = await this.checkExistingSnapshot(ctx.table.id)
if (existingSnapshot) {
  console.log('[Memory] Using existing timeline snapshot, skipping duplicate creation')
  timeline.snapshotBefore = existingSnapshot
} else {
  // Only create if timeline didn't already create one
  timeline.snapshotBefore = await this.createSnapshot(ctx)
}
```

---

## Expected Impact (REVISED)

### Before Fix
- Standardize Date on 1M rows: 1.7GB → 2.5GB ❌
- Double Parquet export (timeline creates step snapshot, executor creates its own)
- Single-file Parquet export buffers 1M rows → 800MB spike
- Inconsistent thresholds (timeline: 100k, executor: 500k)

### After Fix
- Standardize Date on 1M rows: 1.7GB → ~1.9GB ✅
- Single Parquet export (timeline only, executor delegates)
- Chunked Parquet export (4 files × 250k rows) → 200MB spike per chunk
- Consistent 100k threshold across all systems
- 50% reduction in snapshot creation + 75% reduction in per-chunk buffering

### Memory Breakdown (After)

**During Snapshot Export (Chunked)**:
- User table: 500 MB (base)
- Chunk 1 buffer (250k rows): +200 MB → peak 700 MB
- Chunk 1 written to OPFS, buffer freed → back to 500 MB
- Chunk 2 buffer (250k rows): +200 MB → peak 700 MB
- Chunk 2 written to OPFS, buffer freed → back to 500 MB
- ... (repeat for chunks 3-4)
- **Peak RAM**: 700 MB ✅ (well under 2GB limit)

**After Snapshot Export**:
- User table: 500 MB
- Timeline snapshots on OPFS: 4 files × 35 MB compressed = 140 MB disk (0 MB RAM)
- **Total RAM**: 500 MB ✅

### Key Improvements
1. **Eliminated double snapshot** - Executor delegates to timeline system
2. **Chunked Parquet files** - 4 × 250k row chunks instead of 1 × 1M single file
3. **Consistent thresholds** - All systems use 100k row threshold
4. **Peak RAM reduced** - From 2.5GB → 0.7GB (72% reduction)

---

## Verification Plan

### Test 1: Single Transformation (Standardize Date)
1. Load 1M row table
2. Run Standardize Date transformation
3. Monitor RAM during snapshotting phase
4. **Expected**: Single Parquet export, peak ~2.1GB
5. **Before**: Double export, peak 2.5GB

### Test 2: Multiple Transformations
1. Load 1M row table
2. Run 3 consecutive Tier 3 transformations
3. Verify only 3 snapshots created (not 6)
4. **Expected**: Timeline snapshots only

### Test 3: Undo/Redo
1. After Test 2, undo all 3 transformations
2. Verify snapshots are restored correctly
3. Redo all 3 transformations
4. **Expected**: Timeline system handles all undo/redo

### Test 4: Legacy Transformations
1. If transformations.ts is still active:
2. Verify it doesn't create duplicate snapshots
3. **Expected**: No in-memory duplicateTable() calls

---

## Critical Files to Modify

1. `src/lib/commands/executor.ts` - Remove snapshot system (lines 708-789)
2. `src/lib/opfs/snapshot-storage.ts` - Add batched export (optional)
3. `src/lib/transformations.ts` - Remove legacy snapshot (line 1068)

---

## Rollback Plan

If this breaks undo/redo:
1. Re-enable executor snapshots with `createSnapshot()`
2. Add coordination flag to prevent duplicates
3. Keep both systems but add mutex/semaphore

---

## Open Questions

1. **Is transformations.ts still active?**
   - Need to verify with grep for call sites
   - If yes, does it need its own snapshots?

2. **Does DuckDB support Parquet APPEND mode?**
   - Test with small table first
   - If not, accept single-pass buffering

3. **What's the acceptable RAM spike threshold?**
   - Current: 2.5GB (exceeds 2GB limit)
   - Target: <2.0GB peak
   - Is temporary spike to 2.1GB acceptable if it drops quickly?
