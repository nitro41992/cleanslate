# Fix: Diff View Scroll Stalling Issue

## Problem Summary

When scrolling through large diff results, the grid stops loading rows after a few seconds. The console shows:
```
[Diff] Parquet snapshot original_raw_data_hf_v6 already registered, skipping
```

## Root Cause Analysis

### Comparison with Working Main DataGrid

The main `DataGrid.tsx` uses the **exact same data replacement pattern** (lines 234-264) and works fine. The key difference is:

| Aspect | Main DataGrid | Diff Grid |
|--------|---------------|-----------|
| Data source | In-memory DuckDB table | Parquet files via OPFS |
| Query complexity | Simple SELECT | 3-way JOIN (diff + source + target) |
| Per-page latency | ~10-50ms | ~100-500ms due to OPFS |

### Primary Issue: OPFS Access on Every Scroll (`diff-engine.ts:36-47`)

When `resolveTableRef()` is called for an already-registered snapshot, it **still accesses OPFS** to check if the file is chunked vs single:

```typescript
if (registeredParquetSnapshots.has(snapshotId)) {
  console.log(`[Diff] Parquet snapshot ${snapshotId} already registered, skipping`)

  // STILL ACCESSES OPFS TO CHECK IF CHUNKED - THIS IS THE BUG!
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
  try {
    await snapshotsDir.getFileHandle(`${snapshotId}_part_0.parquet`, { create: false })
    return `read_parquet('${snapshotId}_part_*.parquet')`
  } catch {
    return `read_parquet('${snapshotId}.parquet')`
  }
}
```

This OPFS access:
- Adds ~10-50ms latency per scroll page
- Compounds during rapid scrolling (multiple concurrent OPFS calls)
- Can cause file handle contention/errors

### Secondary Issue: No Fetch Locking

Multiple rapid scroll events can trigger concurrent `fetchDiffPage` calls that complete out of order. Without proper serialization, this can corrupt the loaded range state.

---

## Implementation Plan

### Task 1: Cache Resolved Parquet Expressions (Primary Fix)

**File:** `src/lib/diff-engine.ts`

Add a cache to store the resolved SQL expression when first computed, eliminating OPFS access on subsequent calls:

```typescript
// Add at line ~10 (after registeredDiffTables):
const resolvedExpressionCache = new Map<string, string>()

// Modify resolveTableRef() at line ~33 - completely replace the "already registered" branch:
if (registeredParquetSnapshots.has(snapshotId)) {
  // CRITICAL FIX: Return cached expression instead of re-checking OPFS
  const cachedExpr = resolvedExpressionCache.get(snapshotId)
  if (cachedExpr) {
    console.log(`[Diff] Using cached expression for ${snapshotId}`)
    return cachedExpr
  }
  // This shouldn't happen, but log if it does
  console.warn(`[Diff] Snapshot ${snapshotId} registered but no cached expression`)
}

// After single file registration (line 83), cache the expression:
const expr = `read_parquet('${exactFile}')`
resolvedExpressionCache.set(snapshotId, expr)
registeredParquetSnapshots.add(snapshotId)
console.log(`[Diff] Cached expression for ${snapshotId}: ${expr}`)
return expr

// After chunked file registration (line 121), cache the expression:
const chunkExpr = `read_parquet('${snapshotId}_part_*.parquet')`
resolvedExpressionCache.set(snapshotId, chunkExpr)
registeredParquetSnapshots.add(snapshotId)
console.log(`[Diff] Cached expression for ${snapshotId}: ${chunkExpr}`)
return chunkExpr
```

Also clear the cache when cleaning up source files (`cleanupDiffSourceFiles()`):
```typescript
// Add at line ~1020:
resolvedExpressionCache.delete(snapshotId)
```

**Why this is the primary fix:** The main DataGrid works because it queries in-memory tables (~10ms). The diff grid becomes slow because OPFS access on every scroll adds ~50ms+ latency per page. Caching the expression eliminates this.

---

### Task 2: Add Fetch Locking (Secondary Fix)

**File:** `src/components/diff/VirtualizedDiffGrid.tsx`

Add a fetch lock to prevent concurrent requests (matching the pattern that works in the main DataGrid):

```typescript
// Add refs at component level (after line 79):
const fetchLockRef = useRef(false)

// Modify onVisibleRegionChanged (lines 178-196):
const onVisibleRegionChanged = useCallback(
  async (range: Rectangle) => {
    if (!diffTableName || totalRows === 0) return

    // Skip if a fetch is already in progress
    if (fetchLockRef.current) return

    const needStart = Math.max(0, range.y - PAGE_SIZE)
    const needEnd = Math.min(totalRows, range.y + range.height + PAGE_SIZE)

    if (needStart < loadedRange.start || needEnd > loadedRange.end) {
      fetchLockRef.current = true
      try {
        const newData = await fetchDiffPage(...)
        setData(newData)
        setLoadedRange({ start: needStart, end: needStart + newData.length })
      } catch (err) {
        console.error('Error loading diff page:', err)
      } finally {
        fetchLockRef.current = false
      }
    }
  },
  [...]
)
```

**Note:** This is a simpler approach than queuing - it just drops scroll events during a fetch. The main DataGrid doesn't need this because its fetches are fast enough that concurrent requests rarely happen.

---

## Files to Modify

1. **`src/lib/diff-engine.ts`** (Primary fix)
   - Add `resolvedExpressionCache` Map at module level
   - Update `resolveTableRef()` to use cache on "already registered" branch
   - Update registration code paths to populate cache
   - Update `cleanupDiffSourceFiles()` to clear cache entry

2. **`src/components/diff/VirtualizedDiffGrid.tsx`** (Secondary fix)
   - Add `fetchLockRef` to prevent concurrent fetches
   - Update `onVisibleRegionChanged` to check lock before fetching

---

## Verification

1. **Manual Test:**
   - Load a large table (10k+ rows)
   - Apply a transformation (e.g., uppercase a column)
   - Open diff view
   - Scroll rapidly through the entire diff
   - **Expected:** Rows continue loading smoothly without stalling

2. **Console Check:**
   - **Before fix:** Repeated "Parquet snapshot X already registered, skipping" during scroll
   - **After fix:** Should see "Using cached expression for X" instead (fast path)

3. **Run Existing E2E Tests:**
   ```bash
   npm run test:e2e
   ```
   - All diff-related tests should pass
   - No regressions in other features
