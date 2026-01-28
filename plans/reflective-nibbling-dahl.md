# Incremental Persistence for Large Datasets (1M+ Rows)

## Implementation Status: ✅ COMPLETE

**Completed:** 2026-01-28

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Non-Blocking Persistence | ✅ Complete | Added "dirty" indicator, cell edits mark table clean via changelog |
| Phase 2: OPFS JSONL Changelog | ✅ Complete | Created `changelog-storage.ts` with full API |
| Phase 3: Split Persistence Paths | ✅ Complete | Cell edits → changelog, transforms → Parquet |
| Phase 4: Changelog Compaction | ✅ Complete | 30s idle / 1000 entries / beforeunload triggers |
| Phase 5: Testing & Edge Cases | ✅ Complete | 4 new E2E tests, all 19 persistence tests pass |

### Files Created
- `src/lib/opfs/changelog-storage.ts` - OPFS JSONL changelog storage with abstraction layer
- `e2e/tests/changelog-persistence.spec.ts` - E2E tests for changelog persistence

### Files Modified
- `src/hooks/usePersistence.ts` - Added changelog replay, compaction scheduler, cell edit functions
- `src/components/grid/DataGrid.tsx` - Save cell edits to changelog after batch flush
- `src/components/common/PersistenceIndicator.tsx` - Added "dirty" state indicator

---

## Problem Statement

After the recent commit (`03f1e29`), every cell edit and transformation triggers a **full Parquet snapshot export** of the entire table. For a 1M+ row table (~27MB compressed), this means:
- **Cell edits**: User changes 1 cell → exports 1,010,000 rows in 5 chunks
- **Transformations**: Apply to 1 column → exports entire table twice (step snapshot + final state)
- **Concurrent edits during transforms**: Deferred edits flush after transform, triggering another full export

**Console evidence:**
```
[Persistence] Cell edit save: Raw_Data_HF_V6
[Snapshot] Exporting Raw_Data_HF_V6 (1,010,000 rows) to OPFS...
[Snapshot] Using chunked Parquet export for large table
[Snapshot] Exported 5 chunks to Raw_Data_HF_V6_part_*.parquet
```

This repeats for every change, causing:
1. **Poor UX**: User waits for exports to complete
2. **Blocking main thread**: DuckDB WASM is single-threaded
3. **Excessive I/O**: Rewriting 27MB for a single cell change
4. **Competing saves**: Multiple debounce paths (Effect 6 + Effect 6b) can cause redundant exports

---

## Current Architecture Pain Points

| Pain Point | Location | Impact |
|-----------|----------|--------|
| No delta/incremental save | `snapshot-storage.ts:187-382` | Every save = full export |
| Two competing debounce paths | `usePersistence.ts:471-621` (Effect 6) + `623-736` (Effect 6b) | Unpredictable timing, potential double-saves |
| No row-level change tracking | N/A | Can't identify what changed |
| Parquet chunks are slices, not deltas | `snapshot-storage.ts:213-290` | All chunks rewritten every time |
| Immediate dirty marking | `executor.ts:178-181` | Triggers save even when previous export in progress |

---

## Industry Solutions (2025/2026)

### Option A: Hybrid Storage (OPFS Changelog + Periodic Parquet) ✓ SELECTED

**How it works:**
- Store incremental changes (cell edits) as append-only JSONL entries in OPFS
- Periodically (e.g., every 30s or on idle) compact changelog into Parquet snapshot
- On page load: restore from Parquet, replay changelog

**Architecture:**
```
Cell Edit → OPFS changelog.jsonl (instant) → [background] → Parquet compaction
Transform → Parquet snapshot (blocking for Tier 3 only)
```

**Storage layout:**
```
/cleanslate/
├── app-state.json          (existing)
├── changelog.jsonl         (NEW - append-only cell edits)
└── snapshots/
    └── *.parquet           (existing)
```

**Pros:**
- **Single storage system** (OPFS only) - no IndexedDB
- Fast enough for edit workloads (~2-3ms per write)
- Uses existing `src/lib/opfs/` patterns
- Simple restore logic (read file, split lines, parse each)
- Compaction is trivial (delete file after Parquet export)

**Cons:**
- Slightly slower than IndexedDB for very high edit volumes (>10k edits)
- Need explicit file locking for concurrent tab safety

**Migration path:** If performance proves insufficient, can migrate to IndexedDB later by swapping the storage implementation behind an abstraction layer.

**Industry examples:**
- [LokiJS incremental-indexeddb-adapter](https://rxdb.info/slow-indexeddb.html)
- [IDBSideSync oplog approach](https://github.com/clintharris/IDBSideSync)

---

### Option B: Delta Store Pattern (In-Memory + Lazy Merge)

**How it works:**
- Keep a "delta store" of uncommitted changes in memory
- Periodically merge delta into main Parquet storage
- UI reads from merged view (main + delta)

**Architecture:**
```
Cell Edit → Delta Store (memory) → [lazy merge] → Parquet
Transform → Apply to main table → Clear delta → Parquet snapshot
```

**Pros:**
- No I/O for cell edits until merge
- Fast user experience (changes visible immediately)
- Used by columnar databases like [SAP HANA, Vertica](https://motherduck.com/learn-more/columnar-storage-guide/)

**Cons:**
- Risk of data loss on browser crash (no durability until merge)
- Complex merge logic needed
- Memory pressure for large deltas

---

### Option C: Row Group Granularity (Partial Parquet Rewrite)

**How it works:**
- Parquet files are organized into row groups (typically 50K-100K rows)
- Track which row groups are "dirty"
- Only rewrite affected row groups, preserve clean ones

**Architecture:**
```
Cell Edit at row 50,001 → Mark row group 2 dirty → Rewrite only chunk 2
```

**Pros:**
- Reduces I/O proportionally (1 chunk vs 5 for 1M rows)
- Stays within Parquet ecosystem
- [Delta Lake uses this with deletion vectors](https://duckdb.org/docs/stable/core_extensions/delta)

**Cons:**
- DuckDB WASM doesn't support partial Parquet writes natively
- Would need custom chunking logic (already partially exists)
- Row group boundaries must be stable (inserts break this)

---

### Option D: Append-Only Operation Log (CRDT-style)

**How it works:**
- Never modify data directly; store operations as an append-only log
- Materialize view by replaying ops from last snapshot
- [Automerge/Yjs pattern](https://stack.convex.dev/automerge-and-convex)

**Architecture:**
```
Cell Edit → Append op {type: 'edit', row: 5, col: 'name', value: 'John'}
Transform → Append op {type: 'transform', kind: 'trim', column: 'email'}
Materialize → Replay ops from snapshot to get current state
```

**Pros:**
- Full history/audit trail built-in
- Natural undo/redo (already have timeline system!)
- [SQLite Sync uses this](https://www.sqlite.ai/sqlite-sync)

**Cons:**
- Replay can be slow for large op logs
- Need periodic checkpointing (snapshot + truncate ops)
- Current DuckDB-in-memory model doesn't fit naturally

---

### Option E: Non-Blocking Background Persistence

**How it works:**
- Decouple UI from persistence entirely
- Queue saves to background (Web Worker or scheduled idle)
- UI never waits for persistence

**Architecture:**
```
Cell Edit → Apply to DuckDB (instant) → Queue save → [background worker] → OPFS
User continues working → Background catches up
```

**Pros:**
- Best UX (zero blocking)
- Current persistence logic mostly unchanged
- [PowerSync uses this pattern](https://www.powersync.com/blog/sqlite-persistence-on-the-web)

**Cons:**
- Data loss window (changes in memory not yet persisted)
- Need "unsaved changes" indicator
- DuckDB WASM is single-threaded (worker can't share connection)

---

## Recommendation: Option A (OPFS Hybrid) + Option E (Non-Blocking)

**Rationale:**
1. **Cell edits** → OPFS JSONL changelog (instant, durable, no Parquet I/O)
2. **Transformations** → Continue using Parquet snapshots (correctness > speed)
3. **Background compaction** → Merge changelog into Parquet on idle/interval
4. **Deferred persistence** → Never block UI for persistence operations
5. **Single storage system** → OPFS only, no IndexedDB (simpler maintenance)
6. **Migration path** → Abstraction layer allows IndexedDB swap if needed later

### Phase 1: Non-Blocking Persistence (Quick Win)

**Changes:**
1. Move Parquet export to `requestIdleCallback` or `setTimeout(..., 0)`
2. Show "Saving..." indicator instead of blocking
3. Coalesce multiple dirty marks into single save

**Files to modify:**
- `src/hooks/usePersistence.ts` - Use idle callback
- `src/stores/useUIStore.ts` - Add `isSaving` indicator
- `src/components/layout/StatusBar.tsx` - Show save status

### Phase 2: IndexedDB Changelog for Cell Edits

**Changes:**
1. Create `src/lib/opfs/changelog-storage.ts` - IndexedDB ops
2. Cell edits write to changelog instead of triggering Parquet export
3. Add `mergeChangelog()` function to apply ops to DuckDB then Parquet
4. Restore flow: Parquet → DuckDB → Apply changelog → Ready

**Files to create/modify:**
- `src/lib/opfs/changelog-storage.ts` (new)
- `src/hooks/usePersistence.ts` - Split cell edit path from transform path
- `src/lib/persistence/state-persistence.ts` - Include changelog in restore

### Phase 3: Intelligent Snapshot Strategy

**Changes:**
1. Transforms continue using Parquet (Tier 3 needs snapshots for undo)
2. Skip intermediate Parquet saves during rapid edits
3. Compact changelog into Parquet only when:
   - Changelog exceeds 1000 ops
   - User is idle for 30s
   - User triggers export/download
   - Browser beforeunload event

---

## Technical Tradeoffs Summary

| Solution | Persistence Speed | Durability | Complexity | Memory Use |
|----------|------------------|------------|------------|------------|
| **A: Hybrid (OPFS JSONL + Parquet)** | Fast (~3ms/edit) | High | Low | Low |
| B: Delta Store | Instant | Low (crash risk) | High | High |
| C: Row Groups | Medium | High | High | Low |
| D: Op Log | Fast | High | Very High | Medium |
| **E: Non-Blocking** | Same | Same | Low | Same |

**Selected combination: A (OPFS variant) + E** provides the best balance of:
- User experience (non-blocking)
- Data safety (OPFS is durable)
- Implementation complexity (single storage system)
- Compatibility with existing OPFS architecture
- Migration path (abstraction allows IndexedDB swap later)

---

## Implementation Plan

### Phase 1: Non-Blocking Persistence (Quick Win)

**Goal:** Stop blocking UI during Parquet exports

**Files:**
- `src/hooks/usePersistence.ts` - Wrap export in `requestIdleCallback`
- `src/stores/useUIStore.ts` - Add `persistenceStatus: 'idle' | 'saving' | 'saved'`
- `src/components/layout/StatusBar.tsx` - Show save indicator

**Changes:**
```typescript
// usePersistence.ts - Replace blocking save with non-blocking
const saveTable = async (tableName: string) => {
  setUIStore.persistenceStatus('saving')
  requestIdleCallback(async () => {
    await exportTableToParquet(tableName)
    setUIStore.persistenceStatus('saved')
  }, { timeout: 2000 }) // Force within 2s if not idle
}
```

---

### Phase 2: OPFS JSONL Changelog for Cell Edits

**Goal:** Instant persistence for cell edits without Parquet I/O

**Files to create:**
- `src/lib/opfs/changelog-storage.ts` - OPFS JSONL operations

**Storage format:** JSON Lines (one entry per line, append-only)
```
{"tableId":"Raw_Data","rowId":5,"column":"name","oldValue":"Jon","newValue":"John","ts":1706450000000}
{"tableId":"Raw_Data","rowId":10,"column":"email","oldValue":"","newValue":"john@example.com","ts":1706450001000}
```

**Schema:**
```typescript
interface ChangelogEntry {
  tableId: string      // Which table
  ts: number           // Timestamp (milliseconds)
  rowId: number        // _cs_id of edited row
  column: string       // Column name
  oldValue: unknown    // For potential undo
  newValue: unknown    // New cell value
}
```

**API (with abstraction for potential migration to IndexedDB):**
```typescript
// changelog-storage.ts
interface ChangelogStorage {
  appendEdit(entry: ChangelogEntry): Promise<void>
  getChangelog(tableId: string): Promise<ChangelogEntry[]>
  clearChangelog(tableId: string): Promise<void>
  getChangelogCount(tableId: string): Promise<number>
}

// Default implementation: OPFS JSONL
export function createOPFSChangelogStorage(): ChangelogStorage

// Future: IndexedDB if needed
// export function createIndexedDBChangelogStorage(): ChangelogStorage
```

**Files to modify:**
- `src/components/grid/DataGrid.tsx` - Write to changelog instead of triggering Parquet
- `src/hooks/usePersistence.ts` - Restore: load Parquet, then replay changelog
- `src/lib/commands/cell-edit.ts` - Emit to changelog

---

### Phase 3: Split Persistence Paths

**Goal:** Cell edits use changelog, transforms use Parquet

**Decision tree:**
```
Is this a cell edit?
  YES → appendEdit() to IndexedDB (instant)
        → Schedule compaction check
  NO (transform) → Continue current Parquet flow
```

**Files:**
- `src/hooks/usePersistence.ts` - Unify Effect 6 + Effect 6b into single path
- `src/stores/editBatchStore.ts` - Route edits to changelog instead of executor

---

### Phase 4: Changelog Compaction

**Goal:** Periodically merge changelog into Parquet to keep reload fast

**Triggers:**
1. User idle for 30 seconds
2. Changelog exceeds 1000 entries
3. User exports/downloads table
4. Browser `beforeunload` event

**Compaction flow:**
```typescript
async function compactChangelog(tableId: string) {
  const changelog = await changelogStorage.getChangelog(tableId)
  if (changelog.length === 0) return

  // Apply ops to DuckDB (already in memory from restore)
  for (const entry of changelog) {
    await applyChangelogEntry(entry) // SQL UPDATE
  }

  // Export to Parquet
  await exportTableToParquet(tableId)

  // Clear changelog (delete the JSONL file)
  await changelogStorage.clearChangelog(tableId)
}
```

**Concurrent tab safety:**
- Use Web Locks API (`navigator.locks.request()`) to prevent multiple tabs from compacting simultaneously
- During compaction, other tabs' writes append to a new changelog file
- After compaction, merge any concurrent writes

```typescript
await navigator.locks.request(`cleanslate-compact-${tableId}`, async () => {
  await compactChangelog(tableId)
})
```

**Files:**
- `src/hooks/usePersistence.ts` - Add idle detection, compaction scheduler
- `src/lib/opfs/changelog-storage.ts` - Add compaction function with locking

---

### Phase 5: Testing & Edge Cases

**Test scenarios:**
1. Edit 100 cells, refresh → all edits preserved
2. Edit cell during transform → deferred correctly
3. Large changelog (1000+ ops) → auto-compaction triggers
4. Export while changelog has entries → compacts first
5. Crash recovery (kill tab, reopen) → data intact
6. Concurrent tabs → only one compacts, others append correctly

**Files:**
- `e2e/tests/persistence-changelog.spec.ts` (new)
- `e2e/tests/cell-edit-persistence.spec.ts` (modify existing)

---

## Verification Plan

### Manual Testing

1. **Edit persistence:**
   - Load 1M row table
   - Edit 5 cells
   - Check DevTools → Application → OPFS for `changelog.jsonl`
   - Refresh page → edits should persist

2. **Non-blocking UI:**
   - Edit cell during Parquet export
   - UI should not freeze
   - Console shows `[Persistence] Saving in background...`

3. **Compaction:**
   - Make 10 edits, wait 30s
   - `changelog.jsonl` should be deleted
   - Parquet snapshot updated

4. **Large table performance:**
   - Edit cell on 1M row table
   - Should complete in <100ms (vs current 10-30s)

### Automated Tests

```bash
npm run test e2e/tests/persistence-changelog.spec.ts
```

### Console Logging

Expect these log patterns:
```
[Changelog] Appended edit: {tableId: 'X', rowId: 5, column: 'name'}
[Changelog] Entries: 10, compacting...
[Persistence] Compaction complete, cleared changelog
```

---

## Confirmed Design Decisions

1. **Data loss window:** 0-2 seconds (IndexedDB is durable immediately - no actual data loss risk)

2. **Compaction triggers:** 1000 ops OR 30 seconds idle OR export/download OR browser close

3. **Implementation scope:** All phases (complete solution before shipping)

4. **Transform handling:** Transforms remain on Parquet snapshots (needed for Tier 3 undo)

---

## Key Clarification: Durability Model

**IndexedDB writes are immediately durable.** The changelog is NOT a volatile cache - it's persistent storage that survives browser refresh/crash.

| Action | Where It's Stored | Durable? | Speed |
|--------|------------------|----------|-------|
| Cell edit | IndexedDB changelog | Yes, immediately | ~1ms |
| Transform | Parquet snapshot | Yes, after export | ~10-30s for 1M rows |

**Restore flow after page refresh:**
```
1. Load Parquet snapshot (base state)
2. Read IndexedDB changelog (recent edits)
3. Replay changelog ops against DuckDB
4. User sees fully up-to-date data
```

The "compaction" step merges changelog INTO Parquet - but edits are safe in IndexedDB the moment they're made.

---

## Sources

- [RxDB Write-Ahead Logging](https://rxdb.info/rx-storage-indexeddb.html)
- [OPFS vs IndexedDB Performance](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html)
- [Offline-first frontend apps in 2025](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/)
- [DuckDB Delta Extension](https://duckdb.org/docs/stable/core_extensions/delta)
- [Delta Lake vs Parquet](https://medium.com/@kamalnahak22/why-delta-lake-is-not-just-parquet-with-versioning-9dfac45800d0)
- [PowerSync SQLite Persistence](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- [Local-First Apps 2025](https://debugg.ai/resources/local-first-apps-2025-crdts-replication-edge-storage-offline-sync)
- [IDBSideSync CRDT Sync](https://github.com/clintharris/IDBSideSync)
