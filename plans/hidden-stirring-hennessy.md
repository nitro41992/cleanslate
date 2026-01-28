# Plan: Non-Blocking Persistence & Transform Architecture

## Problem Summary

Heavy operations (Parquet export, diff computation, batch transforms) block the main thread for 2-5+ seconds, causing:
- Frozen scrolling during auto-save
- Unresponsive UI during transforms
- Jittery grid during diff generation

**Root Causes Identified:**
1. Parquet exports run on main thread with no yield points
2. Batch operations execute without cooperative scheduling
3. DuckDB mutex serializes all queries without priority
4. OPFS writes are synchronous within the main thread
5. No cancellation mechanism for in-flight operations

---

## Architecture Changes (Priority Order)

### 1. Dedicated Persistence Worker (Highest Impact)

**Current:** All Parquet I/O happens on main thread via DuckDB-WASM
**Proposed:** Spawn a dedicated Web Worker for persistence operations

```
Main Thread                    Persistence Worker
     │                              │
     ├─ User scrolls ───────────────┤
     │  (unblocked)                 │
     │                              │
     ├─ triggerSave() ─────────────►│
     │                              ├─ Receive table snapshot (Arrow IPC)
     │  (continues responding)      ├─ Write to OPFS via SyncAccessHandle
     │                              ├─ Report progress back
     ◄──────────────────────────────┼─ Notify completion
```

**Files to modify:**
- `src/lib/opfs/snapshot-storage.ts` - Extract to worker
- `src/hooks/usePersistence.ts` - Post messages instead of direct calls
- New: `src/workers/persistence.worker.ts`

**Key technique:** Use `FileSystemSyncAccessHandle` in worker (3-4x faster than async API per [web.dev OPFS guide](https://web.dev/articles/origin-private-file-system))

---

### 2. Cooperative Scheduling with `scheduler.yield()`

**Current:** Long loops run to completion without yielding
**Proposed:** Insert yield points to keep UI responsive

Per [Chrome's scheduler.yield() guide](https://developer.chrome.com/blog/use-scheduler-yield), this allows the browser to handle pending user input between chunks.

**Implementation pattern:**
```typescript
// Before (blocking)
for (const chunk of chunks) {
  await processChunk(chunk);
}

// After (cooperative)
for (const chunk of chunks) {
  await processChunk(chunk);
  if ('scheduler' in globalThis && 'yield' in scheduler) {
    await scheduler.yield();  // Let browser handle scrolls/clicks
  } else {
    await new Promise(r => setTimeout(r, 0));  // Fallback
  }
}
```

**Files to modify:**
- `src/lib/commands/batch-executor.ts` - Yield between batches
- `src/lib/opfs/snapshot-storage.ts` - Yield between chunk exports (if not moving to worker)
- `src/lib/duckdb/index.ts` - Yield in chunked operations

---

### 3. Priority-Based Query Queue

**Current:** Single mutex, FIFO order, no priority
**Proposed:** Multi-queue with priority levels

| Priority | Use Case | Example |
|----------|----------|---------|
| `urgent` | Grid scroll data fetch | Page 5 of visible rows |
| `user-visible` | Transform preview | First 100 affected rows |
| `background` | Persistence save | Auto-save after edit |
| `idle` | Diff computation | Post-transform comparison |

**Implementation:**
```typescript
interface PriorityQueue {
  urgent: (() => Promise<void>)[];
  userVisible: (() => Promise<void>)[];
  background: (() => Promise<void>)[];
  idle: (() => Promise<void>)[];
}

// Grid scrolling gets urgent priority
await queryWithPriority('urgent', () => fetchPage(offset, limit));

// Auto-save gets background priority
await queryWithPriority('background', () => exportToParquet());
```

**Files to modify:**
- `src/lib/duckdb/mutex.ts` - Add priority queues
- `src/lib/duckdb/index.ts` - Expose `queryWithPriority()`
- All callers updated to specify priority

---

### 4. AbortController Integration

**Current:** Operations cannot be cancelled
**Proposed:** All long operations accept AbortSignal

**Files to modify:**
- `src/lib/commands/executor.ts` - Accept signal, check before each step
- `src/lib/commands/batch-executor.ts` - Abort between batches
- `src/lib/diff-engine.ts` - Abort during diff computation
- `src/components/grid/DataGrid.tsx` - Cancel in-flight fetches on rapid scroll

---

### 5. Data Integrity on Reload/Crash

**Current:** If user reloads during save, Parquet file may be corrupted (partial write)
**Proposed:** Atomic writes + beforeunload guard

#### 5a. Atomic Writes via Temp Files

Write to temp file first, rename on success:

```typescript
// snapshot-storage.ts

async function exportTableToParquet(tableName: string): Promise<void> {
  const finalPath = `${tableName}.parquet`;
  const tempPath = `${tableName}.parquet.tmp`;

  try {
    // 1. Write to temp file
    await writeParquetChunks(tempPath, tableName);

    // 2. Atomic rename (if interrupted here, original file intact)
    await renameFile(tempPath, finalPath);

  } finally {
    // 3. Cleanup orphaned temp file if rename failed
    await deleteFileIfExists(tempPath);
  }
}
```

**Behavior on reload:**
| Scenario | Result |
|----------|--------|
| Reload during write | Temp file orphaned, original `.parquet` intact |
| Reload after rename | New file complete, temp already gone |
| Crash anytime | At worst lose *this* save, previous version safe |

**Files to modify:**
- `src/lib/opfs/snapshot-storage.ts` - Add temp file pattern
- `src/lib/opfs/opfs-helpers.ts` - Add `renameFile()` helper

#### 5b. beforeunload Warning

Warn user if save is in progress:

```typescript
// usePersistence.ts

useEffect(() => {
  const handler = (e: BeforeUnloadEvent) => {
    if (savesInProgress.size > 0) {
      e.preventDefault();
      return 'Changes are being saved. Leave anyway?';
    }
  };

  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}, [savesInProgress]);
```

**Files to modify:**
- `src/hooks/usePersistence.ts` - Add beforeunload listener

---

### 6. Diff Engine Optimization

**Current:** Diff table (1M rows) exported to OPFS, re-read on every scroll page
**Proposed:** Keep diff IDs in memory, join on-demand

Instead of:
```sql
-- Current: Full diff table in OPFS, 4.5MB
SELECT * FROM read_parquet('_diff_*.parquet') WHERE _cs_id IN (visible_ids)
```

Do:
```sql
-- Proposed: Only store modified row IDs (8 bytes each), join live
SELECT t.* FROM current_table t
WHERE t._cs_id IN (SELECT id FROM diff_ids)
LIMIT 500 OFFSET :page
```

**Files to modify:**
- `src/lib/diff-engine.ts` - Store only IDs, not full rows
- `src/features/diff/DiffView.tsx` - Fetch display data on-demand

---

## Implementation Phases

### Phase 0: Critical Bug Fix - Cell Edits Not Saving ✅ COMPLETE

**Problem:** Cell edits after the first one don't trigger autosave. Only app-state.json is saved, not the Parquet data.

**Root Cause:** Cell edits skip `dataVersion` increment (to preserve scroll position), but persistence only watches `dataVersion`.

**Fix implemented:** Added effect 6b in `usePersistence.ts` that:
1. Subscribes to `UIStore.dirtyTableIds` changes
2. Tracks `lastSeenDataVersions` to detect cell-edit-only changes (where `dataVersion` didn't change)
3. Only triggers saves for the "cell edit case" - when a table is newly dirty but `dataVersion` stayed the same
4. For structural transforms where `dataVersion` changes, effect 6 still handles it (prevents double saves)

**Key implementation details:**
- Uses Zustand subscribe pattern (not React useEffect dependencies) to watch UIStore
- Filters to only handle cell edits: `currentVersion === lastVersion`
- Uses same debounce logic as effect 6 for consistency
- Properly cleans up subscription on unmount

**Files modified:**
- `src/hooks/usePersistence.ts` - Added effect 6b (lines 464-558)

---

### Phase 1: Quick Wins (No Architecture Change) ✅ COMPLETE

1. ✅ Add `scheduler.yield()` to batch-executor.ts loop
2. ✅ Add `scheduler.yield()` to snapshot-storage.ts chunk loop
3. ✅ Add AbortController to DataGrid page fetches (already existed)
4. ✅ **Atomic writes:** Temp file + rename pattern in snapshot-storage.ts
5. ✅ **beforeunload guard:** Warn if save in progress

**Files modified:**
- `src/lib/commands/batch-executor.ts` - Added `yieldToMain()` helper with scheduler.yield() fallback
- `src/lib/opfs/snapshot-storage.ts` - Added yield points, atomic writes with .tmp files
- `src/lib/opfs/opfs-helpers.ts` - New file with `deleteFileIfExists()`, `renameFile()`, `cleanupTempFiles()`
- `src/hooks/usePersistence.ts` - Added `beforeunload` event listener

**Expected improvement:** 50-70% reduction in perceived freeze time + zero data loss on reload

### Phase 2: Priority Queue
1. Refactor mutex.ts to support priority levels
2. Update grid scrolling to use `urgent` priority
3. Update auto-save to use `background` priority

**Expected improvement:** Grid scrolling responsive during saves

### Phase 3: Persistence Worker
1. Create persistence.worker.ts
2. Move Parquet export logic to worker
3. Use MessageChannel for progress updates
4. Use Transferable ArrayBuffers for data passing

**Expected improvement:** Zero main thread blocking for saves

### Phase 4: Diff Optimization
1. Refactor diff engine to store only modified IDs
2. Implement on-demand row hydration from current table
3. Add LRU cache for frequently-viewed diff pages

**Expected improvement:** 10x faster diff scrolling

---

## Critical Files

| File | Change Type | Priority |
|------|-------------|----------|
| `src/lib/commands/batch-executor.ts` | Add yield points | P1 |
| `src/lib/opfs/snapshot-storage.ts` | Yield points + atomic writes → move to worker | P1 → P3 |
| `src/lib/opfs/opfs-helpers.ts` | Add `renameFile()` helper | P1 |
| `src/hooks/usePersistence.ts` | beforeunload guard → worker messaging | P1 → P3 |
| `src/lib/duckdb/mutex.ts` | Priority queues | P2 |
| `src/lib/diff-engine.ts` | Store IDs only | P4 |
| `src/components/grid/DataGrid.tsx` | AbortController | P1 |

---

## Verification

1. **Scroll responsiveness during save:**
   - Load 1M row table
   - Trigger transform (which auto-saves)
   - Attempt to scroll immediately
   - Expected: Smooth 60 FPS scrolling

2. **Transform cancelability:**
   - Start batch transform on 500k rows
   - Press Escape or click Cancel
   - Expected: Operation stops within 500ms

3. **Diff generation non-blocking:**
   - Apply transform to 1M row table
   - Immediately try to scroll grid
   - Expected: Grid responds while diff computes in background

4. **Data integrity on reload:**
   - Load table, make edit (triggers auto-save)
   - Immediately hit Cmd+R to reload
   - Expected: Warning dialog appears ("Changes are being saved...")
   - Force reload anyway
   - Expected: Table loads with data from *before* the interrupted save (not corrupted)

5. **Atomic write verification:**
   - Check OPFS after normal save: no `.tmp` files remain
   - Check OPFS after interrupted save: `.tmp` file may exist, but `.parquet` is intact
   - On next app load: orphaned `.tmp` files cleaned up

---

## References

- [MDN: scheduler.yield()](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield)
- [Chrome: Use scheduler.yield()](https://developer.chrome.com/blog/use-scheduler-yield)
- [web.dev: Origin Private File System](https://web.dev/articles/origin-private-file-system)
- [MDN: FileSystemSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
- [LogRocket: Offline-first apps 2025](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/)
- [High-Performance JS: Workers & SharedArrayBuffer](https://dev.to/rigalpatel001/high-performance-javascript-simplified-web-workers-sharedarraybuffer-and-atomics-3ig1)
- [7 Worker & SharedArrayBuffer Tricks for Smooth UIs](https://medium.com/@jickpatel611/7-js-worker-sharedarraybuffer-tricks-for-smooth-uis-93f976cf66cb)
