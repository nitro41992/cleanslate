# Zero-Resident Architecture: Implementation Plan

## Context

CleanSlate Pro is hitting hard memory ceilings with 1M+ row datasets because the active table lives fully in DuckDB-WASM's heap. Loading full snapshots for Diffs, Joins, or Transforms causes OOM crashes. Individual patches are no longer viable — we need a structural shift.

**The mandate**: Treat RAM as a scarce cache. No feature loads a full table into WASM at once. All operations use Stream/Batch/Throttle with OPFS as primary storage. One code path for all file sizes (10 rows or 10M).

**Delivery order**: Foundation (Storage + ChunkManager) → Diff Engine PoC → Future engines

---

## Current State vs Target

| Aspect | Current | Target |
|--------|---------|--------|
| Active table | Fully in DuckDB (~500MB-1GB for 1M rows) | Only loaded shards in DuckDB (~25-50MB) |
| Snapshot chunks | 100k rows/chunk, no manifest | 50k rows/shard, `_manifest.json` per snapshot |
| Diff creation | FULL OUTER JOIN on all columns (2GB peak) | Index-first JOIN on IDs only (280MB peak) |
| Chunk discovery | File probing (`_part_0`, `_part_1`...) | Manifest-driven (instant metadata) |
| Grid rendering | Already keyset-paginated (500 rows) | No change needed |

---

## Sprint 1: Micro-Shard Storage Standard

**Goal**: Every snapshot is a collection of 50k-row shards with a manifest. No probing.

### 1A. Manifest System — New file: `src/lib/opfs/manifest.ts`

```typescript
interface ShardInfo {
  index: number          // 0, 1, 2...
  fileName: string       // "my_table_shard_0.arrow"
  rowCount: number       // Exact rows in this shard
  byteSize: number       // File bytes
  minCsId: number | null // Min _cs_id (for range lookups)
  maxCsId: number | null // Max _cs_id
}

interface SnapshotManifest {
  version: 1
  snapshotId: string
  totalRows: number
  totalBytes: number
  shardSize: number         // 50_000
  shards: ShardInfo[]
  columns: string[]         // Column names for metadata-only hydration
  orderByColumn: string     // "_cs_id" or "sort_key"
  createdAt: number
}

// CRUD operations
readManifest(snapshotId): Promise<SnapshotManifest | null>
writeManifest(manifest): Promise<void>
deleteManifest(snapshotId): Promise<void>
```

Stored at `cleanslate/snapshots/{snapshotId}_manifest.json`. Atomic writes via `.tmp` rename (same pattern as Arrow IPC).

### 1B. Refactor `src/lib/opfs/snapshot-storage.ts`

| Change | Detail |
|--------|--------|
| `CHUNK_THRESHOLD` 100k → 50k | Align with `LARGE_DATASET_THRESHOLD` in `constants.ts` |
| File naming: `_part_N` → `_shard_N` | Distinguish new format from legacy |
| Always shard + write manifest | Even 100-row tables get 1 shard + manifest (one code path) |
| New: `importSingleShard()` | Load ONE shard into DuckDB as a temp table (key enabler) |
| Legacy fallback in `importTableFromSnapshot()` | If no manifest found, use existing `_part_N` probing |

**New function** (the key enabler for everything downstream):
```typescript
async function importSingleShard(
  db: AsyncDuckDB, conn: AsyncDuckDBConnection,
  snapshotId: string, shardIndex: number,
  tempTableName: string
): Promise<void>
// Reads ONE shard file → insertArrowFromIPCStream → temp table
// Memory: ~25-50MB per shard (vs 500MB-1GB for full table)
```

**Schema handling** for multi-shard imports into the same temp table:
```typescript
// Shard 0: establish schema
CREATE TABLE tempTable AS SELECT * FROM shard_0_data LIMIT 0  // schema only
INSERT INTO tempTable SELECT * FROM shard_0_data

// Shard 1+: append into existing schema
INSERT INTO tempTable SELECT * FROM shard_n_data
```
This avoids type mismatches when DuckDB infers slightly different types across shards.

### 1C. Startup Migration

New function `migrateLegacySnapshots()` in `usePersistence.ts` startup path (after `cleanupCorruptSnapshots()`):
- Detects legacy snapshots (no `_manifest.json`)
- Writes a manifest from existing `_part_N` files (reads file sizes + row counts)
- Does NOT re-chunk yet — manifest can describe 100k-row legacy parts
- Re-chunking to 50k happens lazily on next export

### Files Modified
- `src/lib/opfs/snapshot-storage.ts` — shard size, naming, manifest writes, `importSingleShard()`
- `src/hooks/usePersistence.ts` — startup migration call
- `src/lib/constants.ts` — add `SHARD_SIZE = 50_000` (or reuse `LARGE_DATASET_THRESHOLD`)

### Files Created
- `src/lib/opfs/manifest.ts` — manifest types + CRUD

---

## Sprint 2: ChunkManager (Smart Pointer Utility)

**Goal**: Shared utility all engines use to access chunk-backed data without full loads.

### New file: `src/lib/opfs/chunk-manager.ts`

```typescript
class ChunkManager {
  // Dynamic row-budget LRU (not fixed shard count)
  private static SAFE_ROW_LIMIT = 150_000
  private currentResidentRows: number = 0
  private lru: Map<string, { tableName: string; rowCount: number; lastAccess: number }>

  // Core API
  async mapChunks<T>(snapshotId, callback: (tempTable, shard, index) => Promise<T>): MapChunkResult<T>
  async getRows(snapshotId, startRow, endRow): Promise<{ tempTable, localOffset, localLimit }>
  async loadShard(snapshotId, shardIndex): Promise<string>  // returns DuckDB temp table name
  async evictShard(key): Promise<void>                       // DROP TABLE
  async evictAll(): Promise<void>                            // cleanup on operation end
  async getManifest(snapshotId): Promise<SnapshotManifest>   // metadata only
}
```

**Key behaviors**:

**Dynamic Row-Budget LRU** (mitigates legacy chunk risk):
```typescript
// Eviction based on total resident rows, NOT shard count.
// Handles legacy 100k-250k chunks safely — only 1 legacy chunk loaded at a time.
async loadShard(shard) {
  while (currentResidentRows + shard.rowCount > SAFE_ROW_LIMIT && lru.size > 0) {
    await evictOldest()
  }
  // load shard...
  currentResidentRows += shard.rowCount
}
```
For standard 50k shards: holds ~3 shards (150k rows). For legacy 250k chunks: holds 1 at a time. Safe either way.

**Aggressive Yielding** (mitigates DuckDB single-thread blocking):
- `scheduler.yield()` between every shard load/evict in `mapChunks`
- Allows browser event loop to service high-priority reads (viewport renders) between batch writes
- Grid must handle "Loading..." states gracefully when the Worker is busy with batch operations

**Other behaviors**:
- Mutex per-shard, NOT held across entire `mapChunks` loop (allows grid queries to interleave)
- Temp table naming: `__chunk_{snapshotId}_{shardIndex}` (prefixed for cleanup identification)
- Registers with `memory-manager.ts` — all cached shards evicted during memory pressure

**Where it lives**: `src/lib/opfs/chunk-manager.ts` — Level 1 (OPFS layer), below commands and stores.

### Files Created
- `src/lib/opfs/chunk-manager.ts`

---

## Sprint 3: Batched Diff Engine (Phase 1 Proof of Concept)

**Goal**: Diff creation drops from ~2GB peak to ~280MB peak for 1M-row tables. One code path for all sizes.

### Strategy: Index-First Diff

Instead of a FULL OUTER JOIN on all 60+ columns, we:
1. Build lightweight ID-only index tables (~36 MB each for 1M rows)
2. JOIN the indexes (cheap) to determine added/removed/potentially-modified
3. Batch-compare actual column values for "potentially modified" rows (50k at a time)

### Algorithm (4 phases inside `runDiff`)

#### Phase 1: Build Key Index Tables
For each snapshot (source / target), extract only join-relevant columns shard-by-shard:

```
For each shard of Source:
  loadShard(shard_i) → temp table
  INSERT INTO __diff_idx_a SELECT _cs_id, _cs_origin_id, ROW_NUMBER() FROM temp
  evictShard(shard_i)

For each shard of Target:
  (same pattern → __diff_idx_b)
```

Memory: ~36 MB per index table (UUID + BIGINT for 1M rows). 72 MB total.
For small tables (1 shard): loop runs once, <5ms.

#### Phase 2: Index JOIN → Narrow Diff Table

```sql
CREATE TEMP TABLE __diff_narrow AS
SELECT
  COALESCE(a._cs_id, b._cs_id) as row_id,
  a._cs_id as a_row_id,  b._cs_id as b_row_id,
  a._cs_origin_id as a_origin_id,  b._cs_origin_id as b_origin_id,
  COALESCE(b._row_num, a._row_num + 1000000000) as sort_key,
  CASE
    WHEN a._cs_origin_id IS NULL THEN 'added'
    WHEN b._cs_origin_id IS NULL THEN 'removed'
    ELSE 'pending_compare'
  END as diff_status
FROM __diff_idx_a a
FULL OUTER JOIN __diff_idx_b b ON a._cs_origin_id = b._cs_origin_id
```

Memory: +58 MB for narrow table. Running total: ~130 MB.
The `pending_compare` status means "keys matched, need column-by-column check."

#### Phase 3: Batched Column Comparison (Bulk UPDATE via JOIN)

Process `pending_compare` rows in batches of 50k. Each batch is a single SQL bulk UPDATE — no row-by-row JS loops.

```
For offset = 0; offset < pending_count; offset += 50_000:
  1. Get batch of pending row IDs from __diff_narrow (LIMIT/OFFSET)
  2. Load source shard(s) containing those row IDs (via ChunkManager)
  3. Load target shard(s) containing those row IDs (via ChunkManager)
  4. Single bulk UPDATE:
```

```sql
UPDATE __diff_narrow
SET diff_status = CASE
  WHEN (
    CAST(src."col1" AS VARCHAR) IS DISTINCT FROM CAST(tgt."col1" AS VARCHAR)
    OR CAST(src."col2" AS VARCHAR) IS DISTINCT FROM CAST(tgt."col2" AS VARCHAR)
    -- ... generated for each shared value column
  ) THEN 'modified'
  ELSE 'unchanged'
END
FROM __chunk_source_N src, __chunk_target_N tgt
WHERE __diff_narrow.a_row_id = src._cs_id
  AND __diff_narrow.b_row_id = tgt._cs_id
  AND __diff_narrow.diff_status = 'pending_compare'
```

```
  5. Evict loaded shards, CHECKPOINT, yield()
```

Memory per batch: +150 MB transient (50k rows × 60 columns during JOIN). Released after each batch.
Peak: ~280 MB. Between batches: ~130 MB.

#### Phase 4: Summary + Storage (unchanged from current)
- COUNT with FILTER for summary
- If total diff rows ≥ 100k → export narrow table to OPFS
- Drop index tables, CHECKPOINT
- Return `DiffConfig` (same schema as today)

### Memory Budget

| Phase | Peak | vs Current |
|-------|------|------------|
| 1: Build indexes | 72 MB | n/a (new) |
| 2: Index JOIN | 130 MB | vs ~2 GB |
| 3: Batch compare (per batch) | 280 MB | vs ~2 GB |
| Between batches | 130 MB | — |
| After cleanup | ~26 MB (narrow table only) | same |

### Progress Reporting

New state in `diffStore.ts`:
```typescript
diffProgress: { phase: 'indexing' | 'joining' | 'comparing' | 'summarizing'; current: number; total: number } | null
```

| Phase | UI Message |
|-------|-----------|
| indexing | "Building row index... (1/3)" |
| joining | "Matching rows... (2/3)" |
| comparing | "Comparing values: 50,000 / 500,000 (3/3)" |

For small tables (<50k rows), all phases complete in <200ms — user sees no progress bar.

### Edge Cases

| Case | Handling |
|------|---------|
| Empty tables | Return zero summary immediately, no temp tables |
| 0 matches | All added/removed, Phase 3 skipped (0 pending) |
| Column-only changes | All rows pending_compare, modification detected via new/removed column expressions |
| Table under 1 shard | Loop runs once, same code path, <5ms overhead |

### Backward Compatibility
- `runDiff()` signature unchanged (add optional progress callback as last param)
- `DiffConfig` return type unchanged
- `fetchDiffPage()` / `fetchDiffPageWithKeyset()` unchanged (narrow table schema identical)
- `VirtualizedDiffGrid` requires no changes

### Pagination Change for Source Data

Current `resolveTableRef()` materializes full snapshot into DuckDB temp table for pagination JOINs. Replace with ChunkManager-based shard loading:

```typescript
// Current: loads entire snapshot (~500MB)
await importTableFromSnapshot(db, conn, snapshotId, tempTableName)

// New: loads only shard(s) containing the 500 rows being paginated (~25-50MB)
const chunkMgr = getDiffChunkManager()
const tempTable = await chunkMgr.loadShard(snapshotId, shardIndex)
```

### Files Modified
- `src/lib/diff-engine.ts` — replace `runDiff` internals with index-first algorithm, update `resolveTableRef` to use ChunkManager
- `src/stores/diffStore.ts` — add `diffProgress` state
- `src/components/diff/DiffView.tsx` — wire progress callback, render progress indicator

---

## Known Risks & Ceilings

### Risk A: Legacy Chunk Trap — MITIGATED
Legacy snapshots may have 100k-250k row chunks. Loading 3 legacy chunks = 750k rows → OOM.
**Mitigation**: ChunkManager uses dynamic row-budget LRU (150k row cap), not fixed shard count. With 250k-row legacy chunks, it holds only 1 at a time. See Sprint 2 above.

### Risk B: DuckDB Stop-the-World — MITIGATED
The bulk UPDATE in Phase 3 blocks the single DuckDB thread. Grid reads queue behind it → UI feels frozen during batch comparison.
**Mitigation**: `scheduler.yield()` between every batch. Grid renders "Loading..." skeleton state during worker-busy windows. Progress indicator shows which batch is processing so the user knows the system isn't hung.

### Risk C: Narrow Table Ceiling — ACCEPTED for Phase 1
The `__diff_narrow` table holds 1M rows at ~130MB. For 5M-row tables, this grows to ~650MB — approaching the danger zone.
**Accept for now**: 130MB is safe for the 1M-row target. If we later target >2M rows, the narrow index itself will need to be sharded to OPFS. Don't build that complexity yet, but be aware of the ceiling.

---

## Remaining Future Phases

### Phase 2: Transform Engine — SHIPPED (see Implementation Progress)
### Phase 3: Combiner Engine — SHIPPED (see Implementation Progress)

### Phase 4: Active Table Rework — NOT STARTED
- Active table no longer fully resident in DuckDB
- Only viewport shard(s) loaded for display
- Cell edits target specific shard → load, edit, write back, evict
- This is the final step to achieve true zero-resident architecture

### Shard-Level `fetchDiffPage` — DEFERRED
- Requires `minCsId`/`maxCsId` in manifests during export
- Current pre-materialization workaround is sufficient for 1M-row target

---

## OPFS Layout After Implementation

```
cleanslate/
  app-state.json
  changelog.jsonl
  snapshots/
    my_table_manifest.json          # NEW: manifest
    my_table_shard_0.arrow          # NEW: 50k-row shards
    my_table_shard_1.arrow
    my_table_shard_2.arrow
    old_table_part_0.arrow          # LEGACY: still supported via fallback
    old_table_part_1.arrow
    _diff_narrow_xxx.arrow          # Diff results (existing pattern)
```

---

## Verification Plan

### Unit/Integration Testing
1. **Manifest round-trip**: Write manifest → read → verify all fields
2. **importSingleShard()**: Export 3-shard table → import shard 1 only → verify row count
3. **ChunkManager LRU**: Load 4 shards with maxResident=3 → verify oldest evicted
4. **Legacy fallback**: Table with `_part_N` files (no manifest) → import succeeds

### E2E Testing
5. **Small table diff** (<50k): Upload basic CSV → diff → verify results match current behavior
6. **Large table diff** (>100k): Upload large fixture → diff → verify peak memory stays <300MB via `logMemoryUsage()`
7. **Diff progress UI**: Large diff → verify progress indicator appears and advances
8. **Startup migration**: Create legacy snapshot → reload → verify manifest created

### Manual Verification
9. **200ms rule**: Upload 100-row CSV → run diff → should feel instant (no progress bar visible)
10. **1M-row stress test**: Import large dataset → compare preview → should complete without OOM

---

## Critical Files

| File | Action | Sprint |
|------|--------|--------|
| `src/lib/opfs/manifest.ts` | Create | 1 | DONE |
| `src/lib/opfs/snapshot-storage.ts` | Modify (shard size, naming, manifest, importSingleShard) | 1 | DONE |
| `src/lib/constants.ts` | Modify (add SHARD_SIZE if needed) | 1 | DONE |
| `src/hooks/usePersistence.ts` | Modify (startup migration) | 1 | DONE |
| `src/lib/opfs/chunk-manager.ts` | Create | 2 | DONE |
| `src/lib/memory-manager.ts` | Modify (register ChunkManager cleanup) | 2 | DONE |
| `src/lib/diff-engine.ts` | Modify (index-first algorithm, ChunkManager integration) | 3 | DONE |
| `src/stores/diffStore.ts` | Modify (add diffProgress) | 3 | DONE |
| `src/components/diff/DiffView.tsx` | Modify (progress callback + UI) | 3 | DONE |
| `src/lib/commands/batch-utils.ts` | Modify (shard-based transform path) | Phase 2 | DONE |
| `src/lib/commands/executor.ts` | Modify (shard path selection) | Phase 2 | DONE |
| `src/lib/commands/types.ts` | Modify (shardParallel flag) | Phase 2 | DONE |
| `src/lib/combiner-engine.ts` | Modify (shard-based stack/join) | Phase 3 | DONE |
| `src/lib/commands/combine/join.ts` | Modify (shard-based join command) | Phase 3 | DONE |
| `src/lib/commands/combine/stack.ts` | Modify (shard-based stack command) | Phase 3 | DONE |
| `src/components/panels/CombinePanel.tsx` | Modify (progress UI) | Phase 3 | DONE |
| `src/stores/combinerStore.ts` | Modify (progress state) | Phase 3 | DONE |

---

## Implementation Progress (2026-02-06 → 2026-02-07)

### Sprint 1: Micro-Shard Storage — COMPLETE (commit 5cfc697)
- Manifest system, importSingleShard, 50k shards, legacy migration all shipped.

### Sprint 2: ChunkManager — COMPLETE (commit 5cfc697)
- Row-budget LRU (150k cap), mapChunks, aggressive yielding, memory-manager integration.

### Sprint 3: Diff Engine — COMPLETE

#### 3A. Index-First Diff Algorithm — COMPLETE (commit 5cfc697)
- Phase 1-4 implemented: ID-only index tables → index JOIN → batched column comparison → cleanup.
- Peak memory during `runDiff` dropped from ~2GB to ~280MB.

#### 3B. ChunkManager Integration in `runDiff` — COMPLETE (commit db75dc0)
- `runDiff()` now uses ChunkManager for snapshot sources instead of full materialization via `resolveTableRef()`.
- Schema discovery + origin ID validation use shard 0 (then evict).
- Phase 1 index building uses `mapChunks()` with cumulative `globalRowOffset` for globally-unique row numbers.
- Phase 3 column comparison uses `mapChunks()` — JOIN naturally scopes UPDATE to matching shard rows.
- After all computation, source is pre-materialized via `resolveTableRef()` for the diff view cache.
- Non-snapshot sources (normal DuckDB tables) are completely untouched.

#### Bugs Found & Fixed During Integration (commit db75dc0)

**Bug 1: Table alias prefix in index creation queries (pre-existing)**
- `aOriginIdSelect` and `bOriginIdSelect` had `a.`/`b.` table alias prefixes but were used in `SELECT ... FROM "table"` queries without aliases.
- Previously untriggered because `_cs_origin_id` wasn't present in both tables during earlier testing.
- Fix: Removed alias prefixes — these variables are only used in single-table index creation queries.

**Bug 2: Hardcoded VARCHAR for `_cs_id` in pre-created index table**
- The shard-level path pre-creates `__diff_idx_a` with explicit DDL. `_cs_id` was hardcoded as `VARCHAR`, but the actual column type is `BIGINT`.
- Phase 2's `COALESCE(a._cs_id, b._cs_id)` failed because `__diff_idx_b` (created via `CREATE TABLE AS SELECT`) had `_cs_id` as `BIGINT`.
- Fix: Look up actual `_cs_id` type from `information_schema.columns` via `colsAAll`.

**Bug 3: Memory cleanup thrash loop during diff viewing (pre-existing, newly exposed)**
- `clearDiffCaches()` was registered as a memory-manager cleanup callback. During diff viewing of large tables, memory pressure triggered cleanup → dropped source table + diff index + expression cache → diff view re-materialized everything → memory pressure → cleanup → repeat → OOM.
- Fix: Replaced aggressive `clearDiffCaches` memory callback with lightweight version that only clears pending registrations. Active diff state is cleaned up by the DiffView lifecycle (`cleanupDiffTable`, `cleanupMaterializedDiffView`, `cleanupDiffSourceFiles`).

#### 3C. Shard-Level `fetchDiffPage` — DEFERRED
- `fetchDiffPage` still calls `resolveTableRef()` which materializes the full source snapshot.
- Pre-materialization after `runDiff` (added in 3B) ensures this doesn't cause OOM by loading the source while memory pressure is minimal.
- True shard-level `fetchDiffPage` requires populating `minCsId`/`maxCsId` in manifests during export. Deferred to future sprint.

### Phase 2: Shard-Based Transform Engine — COMPLETE (commit ccd66b2)

Drop-and-rebuild strategy for transforms on large tables. Instead of holding source + staging copy in DuckDB (~1GB), the live table is DROPped and 50k-row OPFS shards are processed one-by-one (load → transform → export → evict → next), then rebuilt from the new shards.

**Key details:**
- Automatic selection: shard-parallel commands (`trim`, `replace`, `cast_type`, etc.) use the new path when an OPFS manifest exists
- Cross-row commands (`remove_duplicates`, `fill_down`) and tables without snapshots fall back to the existing OFFSET batch path
- Peak memory drops from ~1GB to ~150MB for 1M+ row tables (~85% reduction)
- Files modified: `src/lib/commands/batch-utils.ts`, `src/lib/commands/executor.ts`, `src/lib/commands/types.ts`, `src/lib/opfs/snapshot-storage.ts`

### Phase 3: Shard-Based Combiner Engine — COMPLETE (commit 0b400f0)

Stack (UNION ALL) and Join operations now work shard-by-shard via ChunkManager, enabling combines even when tables are frozen to OPFS (not resident in DuckDB).

**Key details:**
- `resolveSource()` detects DuckDB-resident vs OPFS-frozen tables
- `stackTablesSharded()`: iterates source shards → writes output shards → imports result
- `joinTablesSharded()`: index-first algorithm (build key indexes → JOIN keys → hydrate matching rows in batches) — same pattern as diff engine
- Fast path preserved: both tables in DuckDB and ≤50k combined rows bypass sharding
- Structured progress reporting wired end-to-end (engine → `combinerStore` → `CombinePanel` UI)
- Empty join early return prevents crash on 0 matches
- E2E test fixed: dialog name mismatch + gap-based `_cs_id` assertions
- Files modified: `src/lib/combiner-engine.ts`, `src/lib/commands/combine/join.ts`, `src/lib/commands/combine/stack.ts`, `src/components/panels/CombinePanel.tsx`, `src/stores/combinerStore.ts`, `e2e/tests/combiner-csid.spec.ts`

### Memory Profile (1M rows, 30 columns)

| Phase | Before Zero-Resident | After All Phases |
|-------|---------------------|-----------------|
| `runDiff` peak | ~2GB (full source + indices + diff) | ~280MB (shards + indices + diff) |
| Transform peak | ~1GB (source + staging copy) | ~150MB (1 shard + transform output) |
| Stack/Join peak | ~1GB+ (both tables fully resident) | ~150MB (shard-by-shard processing) |
| After `runDiff` | ~1GB (source cached + target) | ~1GB (source pre-materialized + target) |
| `fetchDiffPage` | Source cached (free), load diff | Source cached (free), load diff |
| Diff view scrolling | Stable (~1.2GB) | Stable (~1.2GB, no cleanup thrashing) |

---

## Phase 4 Completion: Cell Edit Gating + E2E Coverage (2026-02-07)

### Gap A: Cell Edit Materialization Gating — COMPLETE

Three-layer defense preventing silent edit failures on frozen tables:

1. **`DataGrid.tsx` `onCellEdited`**: Checks `frozenTables`/`materializingTables` before processing. Shows toast, waits for materialization, then proceeds.
2. **`editBatchStore.ts` flush**: Defense-in-depth for edge case where table becomes frozen between edit and flush.
3. **`executor.ts` gate**: Enhanced to check `frozenTables` (previously only checked `materializingTables`). Triggers `backgroundMaterialize` if needed.

### Bug Fixes Discovered During E2E

1. **`backgroundMaterialize` state leak** (`snapshot-storage.ts`): When table already existed in DuckDB, returned `true` without calling `markTableMaterialized()`, leaving tables permanently stuck in `materializingTables`. Fixed by adding `markTableMaterialized()` in early-exit path.

2. **Combiner source table dematerialization** (`combiner-engine.ts`): Both `stackTables` and `joinTables` dematerialized the active table without checking if it was a source table for the operation. This dropped a needed table from DuckDB mid-operation. Fixed by adding safety check (matching the diff engine's existing pattern) — skip dematerialization when active table is a source.

### Gap C: E2E Test Coverage — COMPLETE (11 tests, all passing)

| # | Test | What It Validates |
|---|------|-------------------|
| 1 | shard + manifest files written to OPFS | Storage layer basics |
| 2 | manifest metadata matches imported data | Manifest integrity |
| 3 | table switch restores frozen table | Freeze/thaw cycle |
| 4 | transform after table switch | Phase 4 executor gate |
| 5 | cell edit after table switch | Gap A — materialization gating |
| 6 | CommandExecutor gate allows transform | Gap A — executor layer |
| 7 | materialization indicator appears | UI feedback during switch |
| 8 | sort works after table switch | Data integrity post-thaw |
| 9 | stack with frozen source | Phase 3 combiner + frozen source |
| 10 | join with frozen source | Phase 3 combiner join path |
| 11 | diff with shard-backed snapshots | Phase 2 diff + frozen source |

### Deferred

- **Gap B: Shard-level `fetchDiffPage`** — memory optimization (~300-400MB savings during diff). Infrastructure ready (minCsId/maxCsId in manifests, ChunkManager APIs). Not needed for 1M-row target.
