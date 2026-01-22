# Snapshot System Consolidation Plan

## Problem Statement

Two parallel snapshot systems exist:
1. **Old system**: `_original_${tableName}` - used by `transformations.ts` and diff
2. **Timeline system**: `_timeline_original_${timelineId}` - used by standardization, manual edits

This causes:
- Standardization not recognized in "Compare with Preview" diff
- Inconsistent undo/redo behavior across operations
- Potential orphaned snapshots and storage waste

## Goal

Consolidate to the **timeline system exclusively** while maintaining performance for 2M+ row datasets.

---

## Performance Analysis for Large Datasets

### Current Approach (Both Systems)
- **Snapshot creation**: `CREATE TABLE AS SELECT * FROM` - O(n) full copy
- **2M rows**: ~2-5 seconds for snapshot creation (acceptable for "before operation" save)
- **Storage**: Each snapshot = full data copy

### Timeline System Advantages for Large Data
1. **Selective snapshots**: Only creates snapshots before "expensive" operations
2. **Nearest-snapshot replay**: Minimizes commands to replay (O(k) where k = commands since last snapshot)
3. **Progress callbacks**: UI can show progress during long replays

### Mitigation Strategies
1. **Keep snapshot limit**: Max snapshots per timeline (configurable, currently based on expensive ops)
2. **Lazy snapshot creation**: Don't snapshot on every operation, only expensive ones
3. **Cleanup on branch**: When user undoes and takes new action, delete orphaned future snapshots

---

## Implementation Plan

### Phase 1: Update Diff to Use Timeline Snapshots ✅ DONE

**Files**: `src/components/diff/DiffConfigPanel.tsx`, `src/components/diff/DiffView.tsx`

Already implemented in current session:
- `hasOriginalSnapshot` check now looks at both old and timeline snapshots
- `handleRunDiff` now falls back to timeline snapshot if old doesn't exist

**IMPORTANT**: Uses `timeline.originalSnapshotName` (the TRUE original from initialization), NOT step snapshots:
- `originalSnapshotName` = `_timeline_original_${timelineId}` → Initial state before ANY modifications
- `snapshots` Map = Step snapshots created before expensive ops (NOT used for diff)

---

### Phase 2: Migrate transformations.ts

**File**: `src/lib/transformations.ts`

**Current** (line 409):
```typescript
await createOriginalSnapshot(tableName)
```

**Change**: Remove this call. Timeline initialization happens via `initializeTimeline()` which is called by `recordCommand()`.

---

### Phase 3: Ensure CleanPanel Initializes Timeline BEFORE Transform

**File**: `src/components/panels/CleanPanel.tsx`

**Current flow**:
1. `applyTransformation()` called → creates old snapshot internally
2. `recordCommand()` called → creates timeline snapshot (too late - captures post-transform state)

**New flow**:
1. `initializeTimeline()` called FIRST → creates timeline snapshot of PRE-transform state
2. `applyTransformation()` called → no snapshot creation
3. `recordCommand()` called → records command, timeline already initialized

**Code change** (around line 100, before `applyTransformation`):
```typescript
import { initializeTimeline, recordCommand } from '@/lib/timeline-engine'

// In handleApply:
// 1. Initialize timeline BEFORE transform (captures pre-state)
await initializeTimeline(activeTable.id, activeTable.name)

// 2. Apply transformation (no snapshot here anymore)
const result = await applyTransformation(activeTable.name, step)

// 3. Record command (won't duplicate snapshot since timeline exists)
await recordCommand(...)
```

---

### Phase 4: Remove Old Snapshot from DataGrid

**File**: `src/components/grid/DataGrid.tsx`

**Current** (line 279):
```typescript
await createOriginalSnapshot(tableName)
```

**Change**: Remove this line. The `initializeTimeline()` call already creates the snapshot.

**CRITICAL ORDERING**: The sequence MUST be:
```typescript
// 1. FIRST: Create original snapshot (idempotent - only creates once)
await initializeTimeline(tableId, tableName)

// 2. THEN: Mutate the data
await updateCell(tableName, ...)

// 3. THEN: Record the command
await recordCommand(...)
```

**Why ordering matters**: If `initializeTimeline` runs after or parallel to `updateCell`, the "original" snapshot will contain the edited value, and diff will show "No Changes".

---

### Phase 5: Remove Old Snapshot from transformations.ts

**File**: `src/lib/transformations.ts`

**Current** (line 409):
```typescript
await createOriginalSnapshot(tableName)
```

**Change**: Delete this line entirely.

---

### Phase 6: Add Snapshot Cleanup on Table Deletion

**File**: `src/stores/tableStore.ts` or `src/hooks/useDuckDB.ts`

When a table is deleted, clean up its timeline snapshots:
```typescript
import { cleanupTimelineSnapshots } from '@/lib/timeline-engine'

// In removeTable or deleteTable:
await cleanupTimelineSnapshots(tableId)
```

---

### Phase 7: Deprecate Old Snapshot Functions (Optional)

**File**: `src/lib/duckdb/index.ts`

Keep functions but add deprecation comments:
- `createOriginalSnapshot()` - no longer called, mark deprecated
- `getOriginalSnapshotName()` - still used by diff fallback
- `hasOriginalSnapshot()` - still used by diff fallback
- `deleteOriginalSnapshot()` - keep for cleaning up legacy snapshots

---

## Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `src/components/panels/CleanPanel.tsx` | Add `initializeTimeline()` before transform | **HIGH** |
| `src/lib/transformations.ts` | Remove `createOriginalSnapshot` call | **HIGH** |
| `src/components/grid/DataGrid.tsx` | Remove redundant `createOriginalSnapshot` | **HIGH** |
| `src/stores/tableStore.ts` | Add snapshot cleanup on table deletion | **MEDIUM** |
| `src/lib/duckdb/index.ts` | Add deprecation comments | **LOW** |
| `src/components/diff/DiffConfigPanel.tsx` | ✅ Already updated | DONE |
| `src/components/diff/DiffView.tsx` | ✅ Already updated | DONE |

---

## Verification

### Test Cases

1. **Transform → Diff**:
   - Load CSV → Apply trim transform → Open Delta Inspector
   - Expected: "Original snapshot available" shows, diff works correctly

2. **Standardize → Diff**:
   - Load CSV → Apply standardize → Open Delta Inspector
   - Expected: "Original snapshot available" shows, diff works correctly

3. **Manual Edit → Diff**:
   - Load CSV → Edit cell → Open Delta Inspector
   - Expected: "Original snapshot available" shows, diff works correctly

4. **Undo/Redo Chain**:
   - Load CSV → Trim → Uppercase → Undo → Undo
   - Expected: Data returns to original state correctly

5. **Large Dataset (2M rows)**:
   - Load 2M row CSV → Apply transform
   - Expected: Snapshot creation completes without memory errors
   - Performance target: < 10 seconds for snapshot

6. **Table Deletion Cleanup**:
   - Load CSV → Apply transforms → Delete table
   - Verify: No orphaned `_timeline_*` tables remain

### SQL Verification
```sql
-- After testing, check for orphaned snapshots:
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE '_timeline%' OR table_name LIKE '_original%'
```

---

## Rollback Plan

If issues arise:
1. Old snapshot functions remain (just deprecated, not deleted)
2. Diff still checks both systems as fallback
3. Can restore `createOriginalSnapshot` calls if needed
