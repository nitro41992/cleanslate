# Memory Optimization Plan: Reduce RAM from 4.5GB to <2.5GB

## Problem Analysis

Based on the user's logs and code analysis, peak RAM reaches 4.5GB and settles to 3.5GB with a 1M row, 30 column table. Target is <2.5GB.

### Root Cause: Concurrent Parquet Exports from Dual Save Effects

The exact timing analysis reveals:

```
T=0s:     Transform starts
          └─ Step snapshot export (~500MB COPY TO) [awaited]

T=2-3s:   Transform executes
          └─ DuckDB table (~1.5GB with versioned rows)

T=10s:    Transform completes, executor returns
          ├─ requestPrioritySave(tableId) [non-blocking flag]
          ├─ dataVersion++ triggers Effect 6
          └─ Effect 6a sees priority flag

T=10s+:   CONCURRENT EXPORTS START
          ├─ Effect 6a: saveTable() → exportTableToParquet() [+500MB]
          └─ Effect 6: saveTable() → exportTableToParquet() [+500MB]

TOTAL:    1.5GB (table) + 500MB (snapshot) + 500MB (save #1) + 500MB (save #2)
          = ~3GB peak + browser overhead = 4.5GB observed
```

**The Bug**: `usePersistence.ts` has TWO independent effects that can both trigger saves:
- **Effect 6a** (lines 918-971): Watches `prioritySaveTableIds`, calls `saveTable()` immediately
- **Effect 6** (lines 731-916): Watches `dataVersion`, calls `saveTable()` after debounce

Both fire for the same table change and don't coordinate through a shared queue. The `saveInProgress` Map only prevents concurrent saves **within the same effect**, not across effects.

## Proposed Solution

### Phase 1: Unify Save Effects (HIGH IMPACT - Fixes Root Cause)

**Goal**: Prevent Effect 6 and Effect 6a from both triggering saves for the same table

**File**: `src/hooks/usePersistence.ts`

**Option A (Recommended): Make Effect 6 the single coordinator**

Remove Effect 6a entirely. Modify Effect 6 to check for priority saves and bypass debounce:

```typescript
// In Effect 6 (lines 731-916), add priority check:
if (priorityTables.length > 0) {
  // Skip debounce, save immediately (but through same queue)
  if (saveTimeout) clearTimeout(saveTimeout)
  executeSave(priorityTables, 'Priority save', maxRowCount)
  return
}
// ... existing debounce logic for non-priority tables
```

**Option B: Shared lock between effects**

Add a shared lock that both effects respect:

```typescript
// Module-level lock
const saveOperationInFlight = new Map<string, Promise<void>>()

// Both effects check before starting:
if (saveOperationInFlight.has(tableId)) {
  await saveOperationInFlight.get(tableId)
}
```

**I recommend Option A** - cleaner, eliminates the duplicate effect entirely.

### Phase 2: Global Export Queue (MEDIUM IMPACT)

**Goal**: Serialize ALL Parquet exports (snapshots + persistence + compaction)

**File**: `src/lib/opfs/snapshot-storage.ts`

Add a global queue that all exports must go through:

```typescript
// Global export serialization - prevents concurrent COPY TO operations
let globalExportLock: Promise<void> = Promise.resolve()

export async function exportTableToParquet(...) {
  // Wait for any in-flight export
  const previousExport = globalExportLock

  // Chain this export
  globalExportLock = previousExport.then(async () => {
    // ... existing export logic ...
  }).catch(() => {})  // Don't propagate errors to next export

  await globalExportLock
}
```

This prevents:
- Step snapshot + persistence save running together
- Compaction + any other export running together

### Phase 3: Explicit Buffer Release (LOW IMPACT - Defense in Depth)

**Goal**: Help GC reclaim buffers faster

**File**: `src/lib/opfs/snapshot-storage.ts`

After each chunk write, explicitly null the buffer:

```typescript
// In chunked export loop (around line 244):
let buffer: Uint8Array | null = await db.copyFileToBuffer(duckdbTempFile)
await writable.write(buffer)
await writable.close()

// Explicit release for GC
buffer = null

// Already calls yieldToMain() at line 288
```

### Phase 4: CHECKPOINT After Exports (LOW IMPACT)

**Goal**: Release DuckDB buffer pool after large exports

**File**: `src/lib/opfs/snapshot-storage.ts`

Add CHECKPOINT after successful export:

```typescript
// At end of exportTableToParquet, before releasing lock:
if (rowCount > 100_000) {
  try {
    const conn = await getConnection()
    await conn.query('CHECKPOINT')
    console.log('[Snapshot] CHECKPOINT after large export')
  } catch { /* non-fatal */ }
}
```

## Files to Modify

| File | Change | Impact |
|------|--------|--------|
| `src/hooks/usePersistence.ts` | Unify Effects 6 & 6a (remove 6a, merge into 6) | **Critical** |
| `src/lib/opfs/snapshot-storage.ts` | Global export queue, buffer release, CHECKPOINT | High |

## Implementation Order

### Step 1: Unify Save Effects (Critical Fix)

**File**: `src/hooks/usePersistence.ts`

1. Remove Effect 6a entirely (lines 918-971)
2. Modify Effect 6 (lines 731-916) to:
   - Check for priority saves at the START of the handler
   - If priority save requested → skip debounce, execute immediately
   - This keeps all save coordination in ONE effect

**Code change sketch:**
```typescript
// At start of Effect 6's unsubscribe handler (around line 758):
const { useUIStore } = await import('@/stores/uiStore')
const prioritySaveIds = useUIStore.getState().getPrioritySaveTables()
const priorityTables = filteredTables.filter(t => prioritySaveIds.includes(t.id))

if (priorityTables.length > 0) {
  // Clear debounce, execute immediately
  if (saveTimeout) clearTimeout(saveTimeout)
  if (maxWaitTimeout) clearTimeout(maxWaitTimeout)

  for (const table of priorityTables) {
    useUIStore.getState().clearPrioritySave(table.id)
  }

  executeSave(priorityTables, 'Priority save (transform completed)', maxRowCount)

  // Continue with remaining non-priority tables through normal debounce
  const remainingTables = filteredTables.filter(t => !priorityTables.some(p => p.id === t.id))
  if (remainingTables.length > 0) {
    // ... existing debounce logic ...
  }
  return
}
```

3. Delete Effect 6a (lines 918-971) - no longer needed

### Step 2: Global Export Queue

**File**: `src/lib/opfs/snapshot-storage.ts`

Add at module level (around line 43):
```typescript
// Global export queue - only one COPY TO at a time
let globalExportChain: Promise<void> = Promise.resolve()

async function withGlobalExportLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousExport = globalExportChain
  let resolve: () => void
  globalExportChain = new Promise(r => { resolve = r })

  try {
    await previousExport
    return await fn()
  } finally {
    resolve!()
  }
}
```

Wrap `exportTableToParquet` body:
```typescript
export async function exportTableToParquet(...): Promise<void> {
  return withGlobalExportLock(async () => {
    // ... existing implementation ...
  })
}
```

### Step 3: Buffer Release & CHECKPOINT

**File**: `src/lib/opfs/snapshot-storage.ts`

In chunked export loop (around line 244):
```typescript
let buffer: Uint8Array | null = await db.copyFileToBuffer(duckdbTempFile)
// ... write to OPFS ...
buffer = null  // Explicit release
```

At end of export (before releasing lock):
```typescript
// After line 376 (single file) and 291 (chunked):
if (rowCount > 100_000) {
  try {
    await conn.query('CHECKPOINT')
  } catch { /* non-fatal */ }
}
```

## Verification

1. **Before changes**: Load 1M row dataset, apply transform, note peak memory
2. **After changes**: Same test, verify peak < 2.5GB
3. **Functional tests**:
   - Transform applies correctly
   - Undo/redo works
   - Persistence survives page refresh
   - Cell edits during transform are deferred and applied

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Remove Effect 6a | Low - functionality moves to Effect 6 | Test priority saves still trigger immediate |
| Global export queue | Medium - adds latency | Serialized exports already work, just formalized |
| Buffer null | None | Already GC'd, just explicit |
| CHECKPOINT | Low | Only >100k rows, ~100ms |

## Expected Results

| Metric | Before | After |
|--------|--------|-------|
| Peak RAM | 4.5GB | ~2.0-2.5GB |
| Settled RAM | 3.5GB | ~1.5-2.0GB |
| Save latency | ~3s (concurrent) | ~3s (sequential) |

The main win is eliminating the duplicate 500MB COPY TO that happens when both effects fire.

## Cleanup: Remove Diagnostic Logging

As part of this work, remove the diagnostic logging added during previous debugging:

1. **`src/lib/commands/executor.ts`** (lines 1461-1485): Remove `[EXECUTOR] syncExecuteToTimelineStore` logs
2. **`src/stores/timelineStore.ts`**: Remove `[TimelineStore] appendCommand` logs
3. **`src/components/layout/AuditSidebar.tsx`** (lines 31-38): Remove `[AuditSidebar] Computing entries` logs
4. **`src/stores/uiStore.ts`** (line 151): Remove stack trace logging in `setSkipNextGridReload`

These were added for debugging and are no longer needed.
