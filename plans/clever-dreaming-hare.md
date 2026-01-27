# Performance Optimization: Large Dataset Persistence

## Problem Statement
With large datasets (1M+ rows), manual edits and auto-saving are slow because:
1. **Each cell edit triggers full table Parquet export** (~50MB for 1M rows)
2. **No save coalescing** - concurrent saves race (visible as `temp_` and `tmp_temp_` prefixes)
3. **2-second debounce too short** - user continues editing during save, triggering another full export
4. **High memory pressure** during exports, triggering snapshot pruning

## 2025/2026 Research Findings

### Industry Patterns
- **Google Sheets**: Every keystroke saved instantly - but uses dedicated cloud infrastructure, not client-side storage
- **OPFS is 4x faster than IndexedDB** for large datasets ([RxDB benchmarks](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html))
- **IndexedDB bottleneck is transactions**, not throughput - bulk writes help ([Nolan Lawson](https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/))
- **Chrome's "relaxed" durability** mode can improve write performance ([Chrome DevDocs](https://developer.chrome.com/docs/chromium/indexeddb-storage-improvements))

### DuckDB-WASM Specific (2025)
- **Native OPFS support merged Jan 2025** - eliminates Parquet workaround for persistence ([MotherDuck blog](https://motherduck.com/blog/duckdb-wasm-in-browser/))
- **Ideal pattern: "base db + WAL"** rather than re-exporting entire Parquet after each change ([GitHub Discussion #1433](https://github.com/duckdb/duckdb-wasm/discussions/1433))
- **WASM mode limitations**: Sandboxed, single-threaded by default, not full feature parity

### Local-First Architecture
- **CRDTs track operations**, not full state - enables offline editing with merge on reconnect
- **Hybrid approach (Linear)**: Different strategies for different data types - OT for text, CRDTs for metadata
- **WAL pattern**: Append-only log of changes, periodically checkpoint to full snapshot

## Recommended Approach: Operation Log + Batched Checkpoints

**Goal**: Make UX identical for small and large datasets - edits feel instant, persistence is invisible.

### Architecture
```
Cell Edit → DuckDB UPDATE (instant) → Operation Log (append-only, fast)
                                              ↓
                                   [Background, when idle]
                                              ↓
                              Batched Parquet checkpoint (full export)
```

### Key Insight
The current system treats every edit as requiring immediate durability via full Parquet export. Instead:
1. **Immediate**: DuckDB in-memory UPDATE (already instant)
2. **Fast append**: Log the operation to a lightweight store (IndexedDB or small Parquet)
3. **Batched checkpoint**: Full Parquet export only when truly idle or on page close

This mirrors how databases like SQLite/Postgres use WAL for durability without rewriting the full database on every write.

## Implementation Plan

### Phase 1: Save Queue with Coalescing (Prevents concurrent exports)
**File:** `src/hooks/usePersistence.ts`

```typescript
// Module-level state
let saveInProgress = new Map<string, Promise<void>>()
let pendingSave = new Map<string, boolean>()

const saveTable = async (tableName: string) => {
  // If already saving, mark for re-save after completion
  if (saveInProgress.has(tableName)) {
    pendingSave.set(tableName, true)
    return saveInProgress.get(tableName)  // Return existing promise
  }

  const savePromise = (async () => {
    try {
      await exportTableToParquet(...)
    } finally {
      saveInProgress.delete(tableName)
      if (pendingSave.get(tableName)) {
        pendingSave.delete(tableName)
        return saveTable(tableName)  // Re-save with latest
      }
    }
  })()

  saveInProgress.set(tableName, savePromise)
  return savePromise
}
```

### Phase 2: Adaptive Debounce Based on Table Size
**File:** `src/hooks/usePersistence.ts`

Scale debounce to match user's editing session, not arbitrary timeout:
```typescript
const getDebounceTime = (rowCount: number): number => {
  if (rowCount > 1_000_000) return 10_000  // 10s for >1M rows
  if (rowCount > 500_000) return 5_000     // 5s for >500k rows
  if (rowCount > 100_000) return 3_000     // 3s for >100k rows
  return 2_000                              // 2s default (unchanged)
}
```

Small datasets retain current 2s behavior. Large datasets get more time to batch edits.

### Phase 3: Operation Log for Cell Edits (Future Enhancement)
**New file:** `src/lib/opfs/operation-log.ts`

For cell edits specifically, log operations instead of triggering full export:
```typescript
interface CellOperation {
  tableId: string
  csId: string
  column: string
  value: unknown
  timestamp: number
}

// Append to IndexedDB or small Parquet file
async function logCellEdit(op: CellOperation): Promise<void>

// On page load, replay any uncommitted operations
async function replayPendingOperations(): Promise<void>

// After successful Parquet checkpoint, clear the log
async function clearOperationLog(tableId: string): Promise<void>
```

This provides WAL-like durability without full table export.

### Phase 4: Beforeunload Checkpoint Guarantee
**File:** `src/hooks/usePersistence.ts`

Force checkpoint on page close (already partially implemented in e11e728):
```typescript
useEffect(() => {
  const handleBeforeUnload = (e: BeforeUnloadEvent) => {
    const dirtyTables = getDirtyTables()
    if (dirtyTables.length > 0) {
      // Synchronous save attempt (best effort)
      // Note: async operations may not complete during unload
      dirtyTables.forEach(t => saveTable(t.name))
    }
  }
  window.addEventListener('beforeunload', handleBeforeUnload)
  return () => window.removeEventListener('beforeunload', handleBeforeUnload)
}, [])
```

## Implementation Scope: Phase 1+2

| Phase | Change | UX Impact | Risk |
|-------|--------|-----------|------|
| 1 | Save queue + coalescing | Eliminates concurrent export races | Low |
| 2 | Adaptive debounce | Large tables batch more edits per save | Low |

Phase 3 (Operation log) and Phase 4 (Beforeunload) deferred for future enhancement.

## Files to Modify

- `src/hooks/usePersistence.ts` - Save queue and adaptive debounce

## Detailed Changes

### 1. Add module-level save queue (top of file, after imports)
```typescript
// Save queue to prevent concurrent exports and coalesce rapid changes
const saveInProgress = new Map<string, Promise<void>>()
const pendingSave = new Map<string, boolean>()
```

### 2. Add adaptive debounce helper
```typescript
const getDebounceTime = (rowCount: number): number => {
  if (rowCount > 1_000_000) return 10_000  // 10s for >1M rows
  if (rowCount > 500_000) return 5_000     // 5s for >500k rows
  if (rowCount > 100_000) return 3_000     // 3s for >100k rows
  return 2_000                              // 2s default
}
```

### 3. Modify saveTable() to use queue
Wrap the existing export logic with queue check and coalescing.

### 4. Modify subscription handler to use adaptive debounce
Get row count from table and pass to `getDebounceTime()`.

## Verification

1. Load 1M+ row dataset
2. Make rapid cell edits (10+ edits in 5 seconds)
3. Verify only ONE Parquet export after edits stop (check console for `[Persistence] Saving`)
4. Verify no `tmp_temp_` prefix files in console (no concurrent exports)
5. Close tab and reopen - verify all edits persisted

## Sources

- [RxDB: LocalStorage vs IndexedDB vs OPFS](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html) - OPFS 4x faster for large datasets
- [DuckDB WASM Persistence Discussion](https://github.com/duckdb/duckdb-wasm/discussions/1433) - "base db + WAL" pattern
- [MotherDuck: DuckDB WASM in Browser](https://motherduck.com/blog/duckdb-wasm-in-browser/) - OPFS native support
- [Chrome IndexedDB Improvements](https://developer.chrome.com/docs/chromium/indexeddb-storage-improvements) - Relaxed durability, compression
- [Speeding up IndexedDB](https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/) - Transaction batching
