# Plan: Grid Scroll Performance & Auto-Save Reliability

## ✅ Implementation Complete

All fixes implemented and tested:

1. **Fix 1: maxWait Auto-Save** (`src/hooks/usePersistence.ts`)
   - Added `firstDirtyAt` tracking per table
   - Added `getMaxWaitTime()` with adaptive thresholds (15-45s based on table size)
   - maxWait timeout forces save even during continuous rapid editing
   - Debounce + maxWait timeouts properly cleaned up on unmount

2. **Fix 2a: Keyset Pagination** (`src/lib/duckdb/index.ts`)
   - Added `KeysetCursor` and `KeysetPageResult` interfaces
   - Added `getTableDataWithKeyset()` for O(1) pagination at any depth
   - Added `estimateCsIdForRow()` helper for jump-to-row

3. **Fix 2b: DataGrid LRU Cache** (`src/components/grid/DataGrid.tsx`)
   - Added `CachedPage` interface and LRU cache ref
   - `PREFETCH_BUFFER` increased from 500 to 1000 rows
   - `MAX_CACHED_PAGES = 10` (~5000 rows cached)
   - **Multi-page fetch**: Calculate which pages cover visible + buffer, fetch all missing pages
   - Merge multiple cached pages into contiguous data array for display
   - Cache cleared on data reload (table changes)
   - LRU eviction when cache exceeds limit

4. **Fix 2c: DiffGrid LRU Cache** (`src/components/diff/VirtualizedDiffGrid.tsx`)
   - Added `CachedDiffPage` interface and LRU cache ref
   - `PREFETCH_BUFFER = 1000` rows
   - `MAX_CACHED_PAGES = 8` (diff rows are larger)
   - **Multi-page fetch**: Same pattern as DataGrid - fetch all pages needed to cover range
   - Merge pages for display, same LRU eviction pattern

5. **Hook Export** (`src/hooks/useDuckDB.ts`)
   - Added `getDataWithKeyset` method for DataGrid use

**Tests Verified:**
- `persistence.spec.ts`: 6 passed
- `transformations.spec.ts`: 17 passed
- `manual-edit-undo-through-transform.spec.ts`: 1 passed

---

## Problem Summary

| Issue | Symptom | Root Cause |
|-------|---------|------------|
| Auto-save delays | Multiple rapid edits → save never happens | Debounce resets on every edit, delays indefinitely |
| Blank rows in grids | Rapid scroll shows empty cells | Prefetch buffer too small (±500 rows), scroll outpaces fetch |

## Solution Overview

### Fix 1: Trailing Debounce with maxWait

Add a maximum wait time that guarantees saves happen even during continuous editing.

**Behavior:**
- Normal debounce (2-10s) still works for typical edits
- After `maxWait` (15-45s) from first unsaved change → force save
- maxWait is adaptive to table size (larger tables get more time)

| Table Size | Debounce | maxWait |
|------------|----------|---------|
| <100k rows | 2s | 15s |
| >100k rows | 3s | 20s |
| >500k rows | 5s | 30s |
| >1M rows | 10s | 45s |

### Fix 2: LRU Page Cache + Keyset Pagination

Replace OFFSET pagination with keyset-based queries and add page caching.

**Changes:**
- **Keyset pagination:** Use `WHERE _cs_id > X` instead of `OFFSET X` for O(1) queries at any depth
- **LRU page cache:** Keep last 10 pages (5000 rows) in memory
- **Increased prefetch buffer:** ±500 → ±1000 rows
- Diff grid: Same pattern with 8 pages

**Why keyset?** 10-30% of users work with 1M+ row tables. OFFSET degrades to 2-3s per query at row 1.5M.

**Keyset tradeoff:** Jump-to-row becomes approximate if rows were deleted mid-session (acceptable for data exploration).

---

## Files to Modify

### Fix 1: Auto-Save
- `src/hooks/usePersistence.ts` - Add `firstDirtyAt` tracking and maxWait logic

### Fix 2: Grid Scrolling + Keyset Pagination
- `src/lib/duckdb/index.ts` - Add `getTableDataWithKeyset()` function
- `src/components/grid/DataGrid.tsx` - Add LRU cache, use keyset pagination
- `src/components/diff/VirtualizedDiffGrid.tsx` - Same pattern for diff grid

---

## Implementation Details

### Fix 1: usePersistence.ts

```typescript
// Module-level tracking
const firstDirtyAt = new Map<string, number>()

function getMaxWaitTime(rowCount: number): number {
  if (rowCount > 1_000_000) return 45_000
  if (rowCount > 500_000) return 30_000
  if (rowCount > 100_000) return 20_000
  return 15_000
}

// In subscribe callback, before scheduling debounced save:
if (!firstDirtyAt.has(table.id)) {
  firstDirtyAt.set(table.id, Date.now())
}

const timeSinceFirstDirty = Date.now() - (firstDirtyAt.get(table.id) ?? Date.now())
const maxWait = getMaxWaitTime(rowCount)

if (timeSinceFirstDirty >= maxWait) {
  // Force immediate save, clear firstDirtyAt after completion
  saveTable(table.name).then(() => firstDirtyAt.delete(table.id))
} else {
  // Normal debounced save (existing logic)
}
```

### Fix 2a: src/lib/duckdb/index.ts (Keyset Queries)

```typescript
// New function for keyset pagination
export async function getTableDataWithKeyset(
  tableName: string,
  cursor: { direction: 'forward' | 'backward'; csId: string | null },
  limit = 500
): Promise<{ rows: Row[], firstCsId: string, lastCsId: string }> {
  return withMutex(async () => {
    const connection = await getConnection()
    let query: string

    if (!cursor.csId) {
      // First page - no cursor
      query = `SELECT * FROM "${tableName}" ORDER BY "_cs_id" LIMIT ${limit}`
    } else if (cursor.direction === 'forward') {
      // Scroll down
      query = `SELECT * FROM "${tableName}" WHERE "_cs_id" > ${cursor.csId} ORDER BY "_cs_id" LIMIT ${limit}`
    } else {
      // Scroll up - reverse order, then flip results
      query = `SELECT * FROM "${tableName}" WHERE "_cs_id" < ${cursor.csId} ORDER BY "_cs_id" DESC LIMIT ${limit}`
    }

    const result = await connection.query(query)
    let rows = result.toArray().map(r => r.toJSON())

    // Reverse if scrolling backward
    if (cursor.direction === 'backward') {
      rows = rows.reverse()
    }

    return {
      rows,
      firstCsId: rows[0]?._cs_id,
      lastCsId: rows[rows.length - 1]?._cs_id
    }
  })
}

// Helper for jump-to-row (approximate)
export async function estimateCsIdForRow(tableName: string, rowIndex: number): Promise<string> {
  // _cs_id is sequential starting from 1, so row N ≈ _cs_id = N+1
  // This is approximate if rows were deleted
  return String(rowIndex + 1)
}
```

### Fix 2b: DataGrid.tsx (LRU Cache + Keyset)

```typescript
const PAGE_SIZE = 500
const PREFETCH_BUFFER = 1000
const MAX_CACHED_PAGES = 10

interface CachedPage {
  data: Row[]
  firstCsId: string
  lastCsId: string
  timestamp: number
}

// LRU cache keyed by firstCsId
const pageCacheRef = useRef<Map<string, CachedPage>>(new Map())

// In onVisibleRegionChanged:
// 1. Estimate target _cs_id from visible row index
// 2. Check cache for nearby pages
// 3. Fetch missing pages using keyset (forward or backward)
// 4. Evict oldest pages if over limit
// 5. Merge into data array for getCellContent
```

### Fix 2c: VirtualizedDiffGrid.tsx

Same pattern with adjusted constants:
- `MAX_CACHED_PAGES = 8` (diff rows are larger)
- `PREFETCH_BUFFER = 1000`

---

## Memory Impact

| Component | Current | After Change |
|-----------|---------|--------------|
| Main grid | ~2.5 MB (500 rows) | ~12.5 MB (10 pages) |
| Diff grid | ~5 MB (500 rows) | ~20 MB (8 pages) |
| **Total** | ~7.5 MB | ~32.5 MB |

Acceptable given 1.8GB DuckDB limit and typical machine memory.

---

## Performance at 1M-2M Rows

### Why Keyset Instead of OFFSET

Current query (slow at depth):
```sql
SELECT * FROM "table" ORDER BY "_cs_id" LIMIT 500 OFFSET 1500000
-- Scans 1.5M rows before returning 500
```

Keyset query (O(1) at any depth):
```sql
SELECT * FROM "table" WHERE _cs_id > 1500000 ORDER BY _cs_id LIMIT 500
-- Jumps directly to starting point
```

### Handling Deleted Rows

When rows are deleted (e.g., `remove_duplicates` deletes 500 rows), the `_cs_id` sequence has gaps.

**Option A: Live with gaps (recommended)**
- Jump-to-row becomes approximate: row 500k ≈ _cs_id ~500k (close enough)
- Keyset pagination still works perfectly for sequential scrolling
- No reindexing overhead

**Option B: Regenerate _cs_id after bulk deletes**
- Adds ~1-2s overhead per bulk operation for large tables
- Would break timeline/undo: commands store `csId` references that become stale
- Would require remapping all timeline entries (complex, error-prone)
- Not recommended

**Decision:** Accept gaps. Keyset handles them fine; approximate jump-to-row is acceptable.

### Issue: Long Auto-Save Times

For 2M rows: 8 chunks × 2-3s = **16-24 seconds** total save time.

**Mitigations (already in plan):**
1. `maxWait` = 45s for 1M+ rows — gives more batching time
2. `pendingSave` queue prevents concurrent exports
3. UI shows "Saving..." spinner during export

**Future optimization (out of scope):**
- Incremental Parquet writes (only changed rows)
- Background Web Worker for export (avoid main thread blocking)

---

## Cleanup: Dead Code

`src/features/diff/components/DiffGrid.tsx` is not imported anywhere. Consider removing it (separate commit).

---

## Verification

### Auto-Save (Fix 1)
1. Load a 100k+ row table
2. Make rapid edits (one per 500ms) for 25 seconds
3. Verify save completes before 20s (the maxWait for >100k rows)
4. Check persistence status indicator shows green checkmark

### Grid Scrolling (Fix 2)
1. Load a 10k+ row table
2. Scroll rapidly from top to row 5000
3. Scroll back to top
4. Verify no blank rows appear (smooth scroll, no Loading cells visible)
5. Monitor memory stays under 100MB for grid data

### E2E Tests
- Add test for maxWait behavior in `persistence.spec.ts`
- Add scroll performance test with memory monitoring

### Scale Testing (Manual)
For 1M+ rows, manually verify:
1. Scroll from row 0 to row 500k — should be <100ms per page (keyset, not OFFSET)
2. Scroll back to row 0 — cache should make this instant
3. Jump to row 1.5M — should load in <200ms (keyset advantage)
4. After `remove_duplicates`, scroll still works (gaps in _cs_id don't break keyset)
5. Make 50 rapid edits — save should trigger within maxWait (45s)
6. Monitor browser memory — should stay under 1.5GB
