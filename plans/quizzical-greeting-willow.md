# Plan: Fix Persistence of Manual Edits, Transforms, and Undo/Redo Across Refreshes

## Problem Summary

After page refresh, undo/redo doesn't work even though:
1. Table data IS correctly restored from Parquet
2. Timeline commands ARE restored from `app-state.json`

**Root Causes:**

1. **CommandExecutor maintains separate state**: The executor has its own `tableTimelines` Map that is NOT persisted. After refresh, this Map is empty, so `executor.canUndo()` returns false.

2. **Original snapshots deleted on init**: `initializeTimeline()` in `timeline-engine.ts` (line 1243-1246) deletes existing Parquet snapshots before creating fresh ones. This means after refresh, the "original" snapshot contains the MODIFIED state, not the true original.

3. **Dual timeline systems out of sync**: The executor's internal `tableTimelines` and `useTimelineStore` track the same information independently, leading to synchronization issues after restore.

## Solution

### Phase 1: Remove snapshot deletion on init (Critical Fix)

**File:** `src/lib/timeline-engine.ts`

Currently on lines 1239-1247:
```typescript
if (existingParquetSnapshot) {
  console.log('[INIT_TIMELINE] Found existing Parquet snapshot, deleting...')
  await deleteParquetSnapshot(potentialSnapshotId)
}
```

**Change:** Remove this deletion. If a snapshot exists and matches the tableName, reuse it. The snapshot represents the true original state.

### Phase 2: Make CommandExecutor use timelineStore as source of truth

**File:** `src/lib/commands/executor.ts`

The executor maintains `tableTimelines` internally. Change these methods to delegate to `timelineStore`:

1. **`canUndo(tableId)`** - Read from `timelineStore.getTimeline(tableId)?.currentPosition >= 0`
2. **`canRedo(tableId)`** - Read from `timelineStore.getTimeline(tableId)?.currentPosition < commands.length - 1`
3. **`getTimelinePosition(tableId)`** - Read from `timelineStore`
4. **`getDirtyCells(tableId)`** - Already uses `timelineStore` (line 796-798), good

Remove or deprecate the internal `tableTimelines` Map and `getTimeline()` helper since timelineStore is the persisted source of truth.

### Phase 3: Ensure proper timeline restoration sequence

**File:** `src/hooks/useDuckDB.ts`

The restoration sequence is:
1. `initDuckDB()` completes
2. `restoreAppState()` loads timelines into `timelineStore`
3. `usePersistence` hydrates tables from Parquet

This is correct, but we need to ensure:
- When first edit occurs after restore, `initializeTimeline()` does NOT delete the existing snapshot
- The restored timeline's `originalSnapshotName` matches what exists in OPFS

### Phase 4: Verify timeline-table ID mapping after restore

**File:** `src/hooks/usePersistence.ts`

When hydrating tables from Parquet, the tableId is set to the tableName (line 117):
```typescript
addTable(tableName, cols, rowCount, tableName)
```

The serialized timeline also uses `tableId`. After restore, ensure these match:
- Timeline's `tableId` should match the restored table's `id`
- Timeline's `tableName` should match the actual table name in DuckDB

## Files to Modify

1. **`src/lib/timeline-engine.ts`**
   - Remove snapshot deletion in `initializeTimelineInternal()` (lines 1239-1247)
   - Add validation to reuse existing snapshot when timeline is already in store

2. **`src/lib/commands/executor.ts`**
   - Refactor `canUndo()`, `canRedo()`, `getTimelinePosition()` to read from `timelineStore`
   - Remove internal `tableTimelines` tracking (or mark as cache-only for current session)

3. **`src/hooks/useDuckDB.ts`** (minor)
   - Add logging to verify timeline restoration matches table IDs

## Verification

After changes, test this flow:

1. Load a CSV file
2. Make a manual cell edit
3. Apply a transform (e.g., trim whitespace)
4. Undo the transform - verify it works
5. **Refresh the page**
6. Verify data is restored
7. Verify undo button is enabled
8. Undo the transform - verify original data is restored
9. Redo - verify transform is reapplied

## Risk Assessment

- **Low risk**: Changes are isolated to persistence/timeline code
- **Backwards compatible**: Existing app-state.json format unchanged
- **Testing**: Can be verified manually through the UI

---

## Implementation Status

### ✅ Phase 1: Completed
**File:** `src/lib/timeline-engine.ts` (lines 1230-1260)

Changed `initializeTimelineInternal()` to:
- Check if a restored timeline exists in `timelineStore` (from `app-state.json`)
- If timeline exists AND Parquet snapshot exists → **reuse the snapshot**
- Only delete snapshot if it's stale (no timeline restored)

```typescript
// New logic:
if (existingParquetSnapshot && restoredTimeline && restoredTimeline.commands.length > 0) {
  // REUSE: Timeline was restored, snapshot file exists
  console.log('[INIT_TIMELINE] Reusing existing Parquet snapshot for restored timeline')
  return restoredTimeline.id
}

if (existingParquetSnapshot && !restoredTimeline) {
  // STALE: Snapshot exists but no timeline - delete and recreate
  await deleteParquetSnapshot(potentialSnapshotId)
}
```

### ✅ Phase 2: Completed
**File:** `src/lib/commands/executor.ts`

Changed `canUndo()`, `canRedo()`, `getTimelinePosition()` to:
- Read from `timelineStore` FIRST (persisted, survives page refresh)
- Fall back to internal `tableTimelines` for backwards compatibility

Also updated `undo()` and `redo()` methods to:
- Check `timelineStore` first before checking internal timeline
- Handle case where internal timeline is empty but `timelineStore` has restored data

### Phase 3: Already Correct
The restoration sequence in `useDuckDB.ts` is correct:
1. `initDuckDB()` completes
2. `restoreAppState()` loads timelines into `timelineStore`
3. `usePersistence` hydrates tables from Parquet

### Phase 4: Already Correct
The `useUnifiedUndo.ts` hook already uses `timelineStore` as source of truth (not executor).
