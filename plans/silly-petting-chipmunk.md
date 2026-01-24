# Eager Timeline Initialization on CSV Upload

## Problem Statement

**Current UX:** User uploads CSV (5s) → Grid loads → User clicks Edit → **Wait 3s for snapshot** → Edit applied

**Desired UX:** User uploads CSV (5s + 3s snapshot) → Grid loads → User clicks Edit → **Instant response**

The 3-second wait happens because timeline initialization (which creates the original Parquet snapshot) only occurs on the first transformation. We should create the snapshot eagerly during upload so it's ready when the user needs it.

---

## Solution Overview

Call `initializeTimeline()` immediately after the table is created and added to the store during CSV import. This absorbs the snapshot creation delay into the upload process, which users expect to take time.

**Key Insight:** The existing `initializeTimeline()` function is already idempotent - it checks if a timeline exists and returns early if so. This means calling it during upload AND during first transformation is safe.

---

## Implementation Plan

### File to Modify

**`src/hooks/useDuckDB.ts`** (lines 75-176)

Specifically the `loadFile` function, which handles all file imports (CSV, JSON, Parquet, XLSX).

### Change Location

**Line 122:** After `addTable()` returns the `tableId`, add the timeline initialization call.

### Current Code (lines 116-127)

```typescript
// Convert result columns to ColumnInfo
const columns: ColumnInfo[] = result.columns.map((name) => ({
  name,
  type: 'VARCHAR',
  nullable: true,
}))

// Add to store
const tableId = addTable(tableName, columns, result.rowCount)

setActiveTableId(tableId)
toast.success('Table loaded successfully')
```

### New Code (with eager initialization)

```typescript
// Convert result columns to ColumnInfo
const columns: ColumnInfo[] = result.columns.map((name) => ({
  name,
  type: 'VARCHAR',
  nullable: true,
}))

// Add to store
const tableId = addTable(tableName, columns, result.rowCount)

// 🟢 NEW: Eagerly initialize timeline to create baseline snapshot
// This creates the original Parquet snapshot NOW instead of on first edit
// For large tables (≥100k rows), this adds ~3s to upload but eliminates
// the wait when user clicks their first transformation
try {
  console.log('[Import] Eagerly initializing timeline snapshot...')
  const { initializeTimeline } = await import('@/lib/timeline-engine')
  await initializeTimeline(tableId, tableName)
  console.log('[Import] Timeline snapshot created successfully')
} catch (error) {
  // Non-fatal - timeline will be created on first transformation if this fails
  console.warn('[Import] Failed to eagerly initialize timeline:', error)
}

setActiveTableId(tableId)
toast.success('Table loaded successfully')
```

### Why This Works

1. **Idempotency Safety:**
   - `initializeTimeline()` checks if timeline already exists (line 706 in timeline-engine.ts)
   - If timeline exists, returns early without creating duplicate snapshot
   - Safe to call during upload AND during first transformation

2. **Performance Impact:**
   - Small tables (<100k rows): Creates in-memory duplicate (~instant)
   - Large tables (≥100k rows): Creates Parquet snapshot (~3s)
   - Delay absorbed into upload process where users expect wait time

3. **Error Handling:**
   - Wrapped in try-catch so upload doesn't fail if snapshot creation fails
   - Falls back to original behavior (create on first transformation)
   - Console warnings for debugging

4. **Memory Efficiency:**
   - Uses same logic as transformation-time initialization
   - Tier 2 storage (Parquet) for large tables
   - Tier 1 storage (in-memory) for small tables

---

## Import Statement Location

**Option A (Dynamic Import - Recommended):**
```typescript
const { initializeTimeline } = await import('@/lib/timeline-engine')
```
- Avoids circular dependency issues
- Loads timeline engine only when needed
- Already used elsewhere in codebase

**Option B (Top-level Import):**
```typescript
// At top of file
import { initializeTimeline } from '@/lib/timeline-engine'
```
- Simpler syntax
- May cause circular dependency if timeline-engine imports from duckdb

**Use Option A** to be safe and consistent with existing patterns.

---

## Expected Behavior Changes

### Before (Current)
```
User: [Drops 1M row CSV]
System: [5 seconds - reading CSV, creating table, counting rows]
Grid: [Loads with 1M rows visible]

User: [Clicks "Trim Whitespace" on a column]
System: [3 seconds - creating original snapshot to OPFS]
System: [Executing trim transformation]
Grid: [Updates with trimmed values]
```

### After (With Eager Initialization)
```
User: [Drops 1M row CSV]
System: [5 seconds - reading CSV, creating table, counting rows]
System: [3 seconds - creating original snapshot to OPFS] ← NEW
Grid: [Loads with 1M rows visible]

User: [Clicks "Trim Whitespace" on a column]
System: [Instant - timeline already exists, skips snapshot creation]
System: [Executing trim transformation]
Grid: [Updates with trimmed values]
```

### Upload Time Impact

| Table Size | Before | After | Difference |
|------------|--------|-------|------------|
| <100k rows | ~2s | ~2s | No change (in-memory snapshot is instant) |
| 100k-500k rows | ~3s | ~5s | +2s (small Parquet snapshot) |
| 500k-1M rows | ~5s | ~8s | +3s (medium Parquet snapshot) |
| 1M+ rows | ~8s | ~11s | +3s (large Parquet snapshot) |

**User Perception:** Upload already takes time, so adding 3s is acceptable. Eliminating the wait on first edit is a much bigger UX win.

---

## Verification Testing

### Test Case 1: Small Table (No Impact)
1. Upload CSV with 10,000 rows
2. **Expected:** Grid loads in ~2 seconds (no change)
3. Click "Uppercase" transformation
4. **Expected:** Transformation applies instantly (no snapshot delay)
5. Check browser console for: `[Import] Timeline snapshot created successfully`

### Test Case 2: Large Table (Delayed Upload, Fast Edit)
1. Upload CSV with 1,000,000 rows
2. **Expected:** Grid loads in ~11 seconds (+3s from before)
3. **Expected:** Console shows `[Import] Eagerly initializing timeline snapshot...`
4. Click "Trim Whitespace" transformation
5. **Expected:** Transformation applies **instantly** (no 3s wait)
6. Open Compare with Preview diff
7. **Expected:** Shows removed/modified rows correctly (snapshot exists)

### Test Case 3: Error Handling
1. Simulate snapshot failure (disconnect from OPFS or corrupt file)
2. **Expected:** Upload still succeeds (error caught)
3. **Expected:** Console shows warning: `[Import] Failed to eagerly initialize timeline: ...`
4. Click first transformation
5. **Expected:** Falls back to creating snapshot now (original behavior)

---

## Rollback Plan

If eager initialization causes issues:

1. **Comment out the new code block** (lines 125-135 in the change)
2. **Commit with message:** "Revert eager timeline initialization"
3. System reverts to original behavior (snapshot on first transformation)

The change is isolated and easy to remove without affecting other functionality.

---

## Related Files (No Changes Needed)

These files are part of the flow but don't need modification:

1. **`src/lib/timeline-engine.ts`** (lines 697-761)
   - Contains `initializeTimeline()` function
   - Already idempotent (checks for existing timeline)
   - Already handles Parquet export for large tables

2. **`src/components/panels/CleanPanel.tsx`** (line 100)
   - Still calls `initializeTimeline()` before first transformation
   - Will return early (no-op) if timeline already exists from upload

3. **`src/lib/duckdb/index.ts`** (lines 233-292)
   - Contains `loadCSV()` function
   - Creates table with `_cs_id` column
   - No changes needed here

4. **`src/stores/tableStore.ts`** (lines 37-54)
   - Contains `addTable()` action
   - No changes needed

---

## Performance Considerations

### Parquet Snapshot Size (for 1M rows)
- Estimated: ~50-100MB depending on column count/types
- Written to OPFS (Origin Private File System) - browser's persistent storage
- Does not count against RAM limits
- Chunked writes prevent memory spikes

### Mutex Protection
- Timeline initialization already uses `withDuckDBLock()` internally
- No concurrent query issues during snapshot creation
- Safe to call during/after table creation

### Memory Safety
- Upload already does memory capacity check (line 79-97 in useDuckDB.ts)
- Snapshot creation respects same memory limits
- Parquet export streams data in chunks (no full table materialization)

---

## Alternative Approaches Considered

### ❌ Approach 1: Background Worker for Snapshot
- **Pros:** Upload returns immediately, snapshot happens in background
- **Cons:** Complex state management, race conditions if user edits before snapshot completes
- **Verdict:** Over-engineered for diminishing returns

### ❌ Approach 2: Snapshot Only on Large Tables
- **Pros:** No delay for small tables
- **Cons:** Inconsistent UX, users confused why some edits are instant and some wait
- **Verdict:** Small tables snapshot instantly anyway, so this adds complexity for no benefit

### ✅ Approach 3: Eager Initialization (Selected)
- **Pros:** Simple, consistent UX, uses existing idempotent function, easy rollback
- **Cons:** Slightly longer upload time (but acceptable trade-off)
- **Verdict:** Best balance of simplicity and user experience improvement

---

## Success Metrics

**Before Implementation:**
- Users report 3-5 second wait on first edit of large tables
- "Is it frozen?" confusion when clicking first transformation

**After Implementation:**
- First transformation applies instantly
- Upload takes slightly longer but users expect upload delay
- No confusion or "frozen" perception

**Measurement:**
- Monitor console logs: `[Import] Timeline snapshot created successfully`
- User feedback: "Edits feel instant now"
- No increase in error reports related to snapshots

---

## Dependencies

**No new dependencies required.**

All functionality already exists:
- `initializeTimeline()` from `@/lib/timeline-engine`
- `withDuckDBLock()` mutex protection
- `exportTableToParquet()` for Parquet snapshots
- OPFS storage utilities

---

## Code Review Checklist

- [ ] Dynamic import used to avoid circular dependencies
- [ ] Try-catch wraps timeline initialization (non-fatal error)
- [ ] Console logging added for debugging
- [ ] No changes to existing `initializeTimeline()` function
- [ ] No changes to CleanPanel transformation flow
- [ ] Idempotency verified (safe to call twice)
- [ ] Error handling prevents upload failure

---

## Final Notes

This is a **low-risk, high-impact UX improvement**:

1. **Low Risk:**
   - Uses existing, tested `initializeTimeline()` function
   - Idempotent design prevents duplicate snapshots
   - Error handling prevents breaking uploads
   - Easy to rollback if issues arise

2. **High Impact:**
   - Eliminates frustrating 3-second wait on first edit
   - Makes app feel significantly more responsive
   - Users expect upload to take time anyway

3. **Implementation Time:**
   - ~10 lines of code
   - Single file change
   - No new dependencies
   - Can be implemented and tested in <30 minutes
