# Memory Optimization Plan: JS Heap Reduction

## Problem Statement

- DuckDB reports 119 MB usage, but JS Heap is **2.95 GB**
- WASM memory cannot shrink (browser limitation)
- Current "Compact Memory" restarts worker but doesn't reduce JS Heap
- Cleanup loop only clears diff-engine (which is empty)

## Root Cause Analysis

**Primary Cause:** Timeline commands accumulate unbounded with large arrays:
- `affectedRowIds: string[]` - up to 10,000 entries per command (line 1462 in executor.ts)
- `cellChanges: CellChange[]` - can have 50k+ entries for batch edits
- No pruning - all commands persisted to `app-state.json`

**Secondary Causes:**
- Only diff-engine registered for memory cleanup
- DataGrid/DiffGrid caches not cleaned on memory pressure
- Column version store never cleaned

---

## Implementation Plan

### Phase 1: Reduce Memory at Source (High Impact, Low Effort)

#### 1.1 Reduce MAX_HIGHLIGHT_ROWS
**File:** `src/lib/commands/executor.ts:1462`

```typescript
// Change from 10000 to 1000
const MAX_HIGHLIGHT_ROWS = 1000
```

1000 rows is sufficient for UI highlighting patterns.

#### 1.2 Clear Large Arrays Before Persist
**File:** `src/lib/persistence/state-persistence.ts`

In `saveAppState()`, compact old commands:
- Keep `affectedRowIds` and `cellChanges` only for last 10 commands
- Store `rowsAffected` count for display purposes
- Clear arrays from older commands

---

### Phase 2: Add Timeline Pruning (High Impact, Medium Effort)

#### 2.1 Add Pruning Action to TimelineStore
**File:** `src/stores/timelineStore.ts`

Add new action:
```typescript
pruneTimeline: (tableId: string, keepCount: number) => void
```

Strategy:
- Keep commands from `currentPosition - keepCount` to `currentPosition`
- Remove future commands (beyond currentPosition) - they're orphaned after new actions
- Clear large arrays (`affectedRowIds`, `cellChanges`) from commands older than 5 positions

#### 2.2 Prune Before Persist
**File:** `src/lib/persistence/state-persistence.ts`

Call pruning before serialization to reduce `app-state.json` size.

---

### Phase 3: Register More Cleanup Callbacks (Medium Impact, Low Effort)

#### 3.1 Register DataGrid Cache
**File:** `src/components/grid/DataGrid.tsx`

```typescript
useEffect(() => {
  registerMemoryCleanup(`datagrid-${tableId}`, () => {
    pageCacheRef.current.clear()
  })
  return () => unregisterMemoryCleanup(`datagrid-${tableId}`)
}, [tableId])
```

#### 3.2 Register Timeline Store Cleanup
**File:** `src/stores/timelineStore.ts`

At module level:
```typescript
registerMemoryCleanup('timeline-store', () => {
  // Prune all timelines to last 20 commands
  for (const [tableId] of get().timelines) {
    get().pruneTimeline(tableId, 20)
  }
})
```

#### 3.3 Register Column Version Cleanup
**File:** `src/lib/commands/context.ts`

Clean up orphaned entries when tables don't exist.

---

### Phase 4: Add Soft Eviction (Medium Impact, Medium Effort)

#### 4.1 Add Soft Threshold
**File:** `src/lib/memory-manager.ts`

```typescript
SOFT: 1.0 * GB,    // Start soft eviction
WARNING: 1.5 * GB, // Show warning (existing)
```

#### 4.2 Trigger Soft Eviction in refreshMemory
**File:** `src/stores/uiStore.ts`

Before critical threshold, clear caches proactively.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/commands/executor.ts` | Reduce MAX_HIGHLIGHT_ROWS to 1000 |
| `src/stores/timelineStore.ts` | Add `pruneTimeline()` action, register cleanup |
| `src/lib/persistence/state-persistence.ts` | Compact commands before save |
| `src/components/grid/DataGrid.tsx` | Register cache cleanup callback |
| `src/lib/memory-manager.ts` | Add soft eviction threshold |
| `src/stores/uiStore.ts` | Trigger soft eviction |
| `src/lib/commands/context.ts` | Register column version cleanup |

---

## Verification

1. **Unit test:** Timeline pruning preserves undo/redo functionality
2. **Manual test:**
   - Load 114k row dataset
   - Apply 20+ transforms
   - Verify JS Heap stays under 1.5 GB
   - Verify highlighting still works
3. **Persistence test:** Verify `app-state.json` size reduced after compaction
4. **E2E test:** Memory doesn't grow unbounded during long session

---

## Backwards Compatibility

- Old `app-state.json` files will load normally (arrays just won't be compacted)
- Highlighting gracefully degrades when `affectedRowIds` is undefined (shows all rows affected)
- `rowsAffected` count preserved for audit display

---

## Summary

| Priority | Task | Impact | Effort | Status |
|----------|------|--------|--------|--------|
| 1 | Reduce MAX_HIGHLIGHT_ROWS to 1000 | High | Low | ✅ Done |
| 2 | Compact timelines before persist | High | Low | ✅ Done |
| 3 | Add timeline pruning action | High | Medium | ✅ Done |
| 4 | Register DataGrid cleanup | Medium | Low | ✅ Done |
| 5 | Register timeline cleanup | Medium | Low | ✅ Done |
| 6 | Add soft eviction | Medium | Medium | ✅ Done |
| 7 | Register column version cleanup | Low | Low | ✅ Done |

## Implementation Notes (2026-01-30)

### Changes Made

1. **executor.ts:1462** - Changed `MAX_HIGHLIGHT_ROWS` from 10000 to 1000
2. **timelineStore.ts** - Added `pruneTimeline()` action + registered cleanup callback
3. **state-persistence.ts** - Added `compactTimelines()` function that clears large arrays from old commands
4. **DataGrid.tsx** - Registered page cache cleanup with `registerMemoryCleanup`
5. **memory-manager.ts** - Added `SOFT: 1.0 * GB` threshold + `soft` health level
6. **uiStore.ts** - Updated `refreshMemory()` to trigger cleanup at soft/warning/critical/danger levels
7. **context.ts** - Added `cleanupOrphanedColumnVersions()` + registered cleanup callback

### Build Status
- ✅ TypeScript compilation passes
- ✅ Production build successful
- ✅ Changelog persistence tests pass (4/4)
