# Plan: Fix Diff Tables Persisting and Audit Log Disappearing

**Status: ✅ IMPLEMENTED**

## Problems

### Problem 1: Diff Tables Appearing in Table Dropdown
When running diff comparisons on large datasets (>=100k rows), the diff engine exports temporary diff tables to Parquet files in OPFS. When the user closes the diff view, cleanup should remove these files. However, cleanup can fail silently or the user may refresh before cleanup completes, leaving orphaned `_diff_*.parquet` files.

On next page load, these orphaned files get imported back into DuckDB and added to the tableStore, causing `_diff_*` tables to appear in the table dropdown.

### Problem 2: Audit Log Empty After Refresh
When `_diff_*` Parquet files exist and get restored, there's a race condition between:
1. `runFullInitialization()` in useDuckDB.ts - sets `__CLEANSLATE_SAVED_TABLE_IDS__`
2. `hydrate()` in usePersistence.ts - reads `__CLEANSLATE_SAVED_TABLE_IDS__`

If hydration runs before the saved table IDs are set:
- Tables get restored with their NAME as the tableId (fallback)
- But timelines are keyed by the ORIGINAL tableId from app-state.json
- Result: Timeline lookup fails -> Empty audit log

## Root Cause Analysis

**Issue 1:** The persistence layer filters out internal tables (`original_*`, `snapshot_*`, `_timeline_*`) but does NOT filter out `_diff_*` tables.

**Issue 2:** `usePersistence.hydrate()` calls `await initDuckDB()` which only waits for the DuckDB engine, NOT for `runFullInitialization()` which sets `__CLEANSLATE_SAVED_TABLE_IDS__`. This creates a race condition.

## Solution

### Fix 1: Filter `_diff_*` Tables + Cleanup at Startup

**File: `src/hooks/usePersistence.ts` (line ~128)**

Add `_diff_` to the filter list:

```typescript
.filter(name => {
  if (name.startsWith('original_')) return false
  if (name.startsWith('snapshot_')) return false
  if (name.startsWith('_timeline_')) return false
  if (name.startsWith('_diff_')) return false  // ADD THIS
  return true
})
```

**File: `src/lib/persistence/state-persistence.ts` (line ~197)**

Add filter to exclude `_diff_*` tables from DuckDB reconciliation:

```sql
AND table_name NOT LIKE '_diff%'
```

**File: `src/lib/opfs/snapshot-storage.ts`**

Add startup cleanup function to delete orphaned diff files:

```typescript
export async function cleanupOrphanedDiffFiles(): Promise<void> {
  // Delete any _diff_*.parquet files from OPFS snapshots directory
}
```

Call this in `usePersistence.ts` after `cleanupCorruptSnapshots()`.

### Fix 2: Synchronize State Restoration with Parquet Hydration

**File: `src/hooks/useDuckDB.ts`**

Export a promise that usePersistence can await:

```typescript
// Add at module level
export let stateRestorationPromise: Promise<void> | null = null

// In runFullInitialization(), after setting __CLEANSLATE_SAVED_TABLE_IDS__:
// Signal that state restoration is complete
```

**File: `src/hooks/usePersistence.ts`**

In `hydrate()`, wait for state restoration before reading saved table IDs:

```typescript
const hydrate = async () => {
  const db = await initDuckDB()

  // Wait for app state restoration (sets __CLEANSLATE_SAVED_TABLE_IDS__)
  const { stateRestorationPromise } = await import('@/hooks/useDuckDB')
  if (stateRestorationPromise) {
    await stateRestorationPromise
  }

  // Now safe to read __CLEANSLATE_SAVED_TABLE_IDS__
  const savedTableIds = window.__CLEANSLATE_SAVED_TABLE_IDS__
  // ...
}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/hooks/usePersistence.ts` | Add `_diff_` filter, call cleanup, wait for state restoration |
| `src/lib/persistence/state-persistence.ts` | Add `_diff_` filter in reconciliation query |
| `src/lib/opfs/snapshot-storage.ts` | Add `cleanupOrphanedDiffFiles()` function |
| `src/hooks/useDuckDB.ts` | Export state restoration promise for synchronization |

## Verification

1. Import a large dataset (1M+ rows)
2. Run a diff comparison (will create `_diff_*.parquet` files)
3. Close diff view, then immediately refresh the page
4. Verify:
   - No `_diff_*` tables appear in the table dropdown
   - Original tables appear correctly
   - Audit log shows all previous operations
   - Changes are preserved
5. Check browser console for any restoration errors

## Implementation Summary

### Changes Made

**1. `src/hooks/usePersistence.ts`**
- Added `_diff_` filter to hydration filter list (line ~137)
- Added `_diff_` filter to auto-save filter list (line ~377)
- Added import for `cleanupOrphanedDiffFiles`
- Added call to `cleanupOrphanedDiffFiles()` after `cleanupCorruptSnapshots()`
- Added await for `stateRestorationPromise` before reading saved table IDs

**2. `src/lib/persistence/state-persistence.ts`**
- Added `AND table_name NOT LIKE '_diff%'` to DuckDB reconciliation query

**3. `src/lib/opfs/snapshot-storage.ts`**
- Added new `cleanupOrphanedDiffFiles()` function to delete orphaned `_diff_*.parquet` files at startup

**4. `src/hooks/useDuckDB.ts`**
- Added `stateRestorationPromise` export (module-level promise)
- Created promise in `runFullInitialization()` before state restoration
- Resolved promise after setting `__CLEANSLATE_SAVED_TABLE_IDS__`
- Added error handling to still resolve promise on error (prevents deadlock)
