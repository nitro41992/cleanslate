# Plan: Fix Redundant Snapshots on Data Load

## Problem Summary

When loading a 1M row file, **three full-table Parquet exports** happen instead of two:

| Snapshot | Source | Purpose | Redundant? |
|----------|--------|---------|------------|
| `original_raw_data_hf_v6` | `initializeTimeline()` | Undo/redo baseline | No |
| `Raw_Data_HF_V6` | `exportTableToParquet()` in loadFile | Persistence | No |
| `Raw_Data_HF_V6` (again) | Debounced save from subscription | Race condition bug | **YES** |

### Root Cause

The `recentlySavedTables` flag is a `Set<string>` that gets **deleted immediately** on the first subscription call (line 771). When the Zustand subscription fires multiple times (due to React batching or multiple state updates), the second call doesn't see the flag and triggers a redundant save.

Evidence from logs:
```
tableStore.ts:198 [TableStore] State changed, triggering debounced save: {tables: 1, activeTableId: 'bdm1vaj'}
usePersistence.ts:770 [Persistence] Skipping Raw_Data_HF_V6 - was just saved during import  ← First call
usePersistence.ts:783 [Persistence] New table detected: Raw_Data_HF_V6                       ← Second call (flag gone!)
```

Both messages appearing confirms the subscription fires twice - the flag is consumed on the first call.

## Proposed Fix

Change `recentlySavedTables` from a one-shot `Set<string>` to a **timestamp-based `Map<string, number>`** with a time window (5 seconds). This allows multiple subscription calls to see the "recently saved" status.

### Files to Modify

1. **`src/hooks/usePersistence.ts`**
   - Change `recentlySavedTables` from `Set<string>` to `Map<string, number>`
   - Add `wasRecentlySaved()` helper that checks timestamp window
   - Update the subscription to use `wasRecentlySaved()` instead of `has()` + `delete()`

### Code Changes

**Before:**
```typescript
const recentlySavedTables = new Set<string>()

export function markTableAsRecentlySaved(tableId: string): void {
  recentlySavedTables.add(tableId)
}

// In subscription:
if (recentlySavedTables.has(table.id)) {
  recentlySavedTables.delete(table.id)  // Consumed immediately!
  continue
}
```

**After:**
```typescript
const recentlySavedTables = new Map<string, number>()
const RECENTLY_SAVED_WINDOW_MS = 5_000

export function markTableAsRecentlySaved(tableId: string): void {
  recentlySavedTables.set(tableId, Date.now())
}

function wasRecentlySaved(tableId: string): boolean {
  const savedAt = recentlySavedTables.get(tableId)
  if (!savedAt) return false
  if (Date.now() - savedAt > RECENTLY_SAVED_WINDOW_MS) {
    recentlySavedTables.delete(tableId)  // Expired
    return false
  }
  return true  // Still valid - don't delete!
}

// In subscription:
if (wasRecentlySaved(table.id)) {
  continue  // Skip - flag persists for subsequent calls
}
```

## Verification

1. **Manual test**: Load a large file (>100k rows) and check console for redundant saves
   - Before fix: Should see 3 snapshots
   - After fix: Should see only 2 snapshots (original + persistence)

2. **Log verification**: After loading a file, logs should show:
   ```
   [Persistence] Skipping Raw_Data_HF_V6 - was just saved during import
   ```
   But NOT:
   ```
   [Persistence] New table detected: Raw_Data_HF_V6
   ```

3. **E2E tests**: Run existing persistence tests to ensure no regressions
   ```bash
   npm run test -- --grep "persistence"
   ```
