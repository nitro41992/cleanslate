# Performance Optimization Plan: 1M+ Row Handling

## Problem Statement
CleanSlate Pro needs to handle 1M+ row datasets performantly across all operations (transforms, merge, diff, combine, standardize, undo/redo). Current architecture has solid foundations but several bottlenecks that compound at scale.

## Industry Context
- **DuckDB-WASM**: Single-threaded in browser, 4GB WASM memory cap, supports out-of-core for some operations
- **OPFS**: 3-4x faster than IndexedDB for large files (Notion saw 33% speedup with SQLite+OPFS)
- **Perspective (FINOS)**: Reference architecture for 1M+ streaming data in browser WASM
- **Parquet best practices**: Smaller row groups (20-50k) enable better predicate pushdown and partial reads

---

## Tier 1: Quick Wins (1-2 days total, high impact, low risk)

### 1.1 Gate Memory Diagnostics Behind Debug Flag
**File:** `src/lib/commands/executor.ts` (lines 401-471)

Every command runs `getDuckDBMemoryUsage()` + `getEstimatedTableSizes()` TWICE (before + after execution). These are 4 SQL queries purely for console logging.

**Change:** Wrap in `if (import.meta.env.DEV)` or a localStorage debug flag. Keep the `pruneSnapshotsIfHighMemory()` call but debounce it (every 30s, not every command).

**Savings:** ~100ms per command execution.

### 1.2 Make VACUUM Conditional on Actual Need
**File:** `src/lib/commands/executor.ts` (line 662)

Currently: `shouldVacuum = (tier === 3 && isDestructiveOp) || ctx.table.rowCount > 100_000`
This runs VACUUM on every Tier 1/2 transform for any table >100k rows. VACUUM is expensive (200-500ms at 1M rows).

**Change:** `const shouldVacuum = tier === 3 && isDestructiveOp`

Tier 1 (UPDATE-based) and Tier 2 (inverse SQL) don't create enough dead rows to justify VACUUM. Only Tier 3 destructive ops (remove_duplicates, filter) that rebuild tables via CTAS need it.

**Savings:** ~200-500ms per non-Tier-3 command on large tables.

### 1.3 Set DuckDB threads = 1 for WASM
**File:** `src/lib/duckdb/index.ts` (line 362)

Currently sets `threads = 2`, but DuckDB-WASM is single-threaded. Extra thread allocates per-thread sort/join buffers (~500MB wasted for 1M-row operations). The diff engine already sets `threads = 1` for its heavy operations.

**Change:** `await initConn.query('SET threads = 1')`

**Savings:** ~500MB peak memory reduction for joins and sorts.

### 1.4 Remove Debug Queries from Timeline Replay
**File:** `src/lib/timeline-engine.ts`

Three debug patterns add unnecessary DuckDB round-trips:
- `applyManualEditCommand` (line 712-736): Row existence check + post-update verify = 2 extra queries per manual_edit replay
- Replay loop (lines 1059-1074): Per-command verification query
- Post-restore debug (lines 976-983): `SELECT * LIMIT 5` + `SELECT COUNT(*)` after every snapshot restore

**Change:** Remove all three. Wrap in `import.meta.env.DEV` if you want to keep them for debugging. The `updateCellByRowId` call is a no-op if the row doesn't exist.

**Savings:** ~150-450ms for timelines with 50+ manual edits.

### 1.5 Reduce Parquet ROW_GROUP_SIZE
**File:** `src/lib/opfs/snapshot-storage.ts` (lines 349, 444)

Currently `ROW_GROUP_SIZE 100000`. Smaller groups enable better predicate pushdown during partial reads.

**Change:** Reduce to `ROW_GROUP_SIZE 50000`.

**Savings:** Better column pruning on snapshot reads. Slight file size increase (~2-5%). Preparatory for future incremental snapshots.

---

## Tier 2: Medium Effort (3-5 days total, high impact)

### 2.1 Replace OFFSET Pagination with Keyset Pagination
**File:** `src/lib/commands/batch-executor.ts`

Current OFFSET-based batching is O(N) per batch (scanning 950k rows to skip them for the last batch of 1M). The codebase already has keyset pagination for grid rendering (`getTableDataWithKeyset` in `src/lib/duckdb/index.ts`).

**Change:** Replace OFFSET loop with `WHERE _cs_id > lastSeenId`:
- First batch: `SELECT ... ORDER BY _cs_id ASC LIMIT {batchSize}`
- Subsequent: `SELECT ... WHERE _cs_id > {lastSeenId} ORDER BY _cs_id ASC LIMIT {batchSize}`
- Extract max `_cs_id` from each batch result

**Savings:** ~2-3x faster total batch execution at 1M rows.

### 2.2 Conditional Hot Snapshot Creation
**File:** `src/lib/timeline-engine.ts` (line 454-469)

`createStepSnapshot` always creates BOTH a hot (in-memory, ~150MB for 1M rows) AND cold (Parquet) snapshot. Peak = 3 copies of data in memory simultaneously.

**Change:** Only create hot snapshot when memory is healthy (< 60% usage):
```typescript
const memStatus = await getMemoryStatus()
if (tableId && memStatus.percentage < 60) {
  hotTableName = getHotSnapshotName(timelineId, stepIndex)
  // ... create hot snapshot
}
```

When memory is constrained, undo uses the cold Parquet path (2-3s instead of instant, but prevents OOM).

**Savings:** Eliminates ~150MB RAM and ~300ms per Tier 3 operation under memory pressure.

### 2.3 CHECKPOINT Consolidation
**Files:** `src/lib/commands/executor.ts`, `src/lib/opfs/snapshot-storage.ts`

CHECKPOINT fires 2-3 times in the same execution cycle (after Tier 3, after large export, after freeze). Each costs 200-500ms on 1M rows.

**Change:** Create `src/lib/duckdb/checkpoint-manager.ts` with debounced `requestCheckpoint(source)` (2s window) and `forceCheckpoint()` (for freeze/thaw only). Replace all direct `CHECKPOINT` calls.

**Savings:** Reduces CHECKPOINTs from 2-3 to 1 per Tier 3 operation.

### 2.4 Reduce Per-Command Table Scans in Executor
**File:** `src/lib/commands/executor.ts`

Currently 4-6 full table scans per command at 1M rows:
1. `command.validate()` (table exists check)
2. `command.execute()` (the actual transform)
3. `refreshTableContext()` (re-fetches columns + row count)
4. Audit capture (scans for before/after values)
5. Diff view creation (another scan)
6. Affected row extraction (yet another scan)

**Changes:**
- **Skip `refreshTableContext()` column re-fetch** when schema hasn't changed (most Tier 1/2 transforms). Reuse `ctx.table.columns` if no `newColumnNames`/`droppedColumnNames`/`renameMappings`.
- **Skip audit row-detail capture for >500k rows entirely** (early exit in `captureTier23RowDetails` before building SQL).
- **Combine idempotency check + affected count** in `Tier1TransformCommand.execute()` (`base.ts`): merge the `LIMIT 1` check and `COUNT(*)` into a single query.

**Savings:** Eliminates 2-3 redundant full-table scans per command.

---

## Tier 3: Significant Effort (1-2 weeks total, very high impact)

### 3.1 Batch Merge Duplicate Deletes
**File:** `src/lib/fuzzy-matcher.ts` (lines 1164-1240)

`mergeDuplicates()` executes individual `DELETE` statements per pair. For 5,000 pairs = 5,000 SQL round-trips.

**Change:** Collect all `_cs_id` values, batch into `DELETE FROM table WHERE _cs_id IN (id1, id2, ...)` in groups of 1,000. Same pattern for audit detail INSERTs.

**Savings:** ~10-20x faster merge for large pair sets.

### 3.2 Push Standardizer Fingerprint Clustering to SQL
**File:** `src/lib/standardizer-engine.ts`

Currently fetches ALL distinct values to JS, processes in JS. The `fingerprint` algorithm (lowercase, remove punctuation, sort tokens, join) can be expressed entirely in DuckDB SQL:

```sql
SELECT value, count,
  array_to_string(list_sort(string_split_regex(
    regexp_replace(lower(value), '[^a-z0-9\s]', '', 'g'), '\s+'
  )), ' ') as cluster_key
FROM (SELECT CAST(col AS VARCHAR) as value, COUNT(*) as count FROM table GROUP BY 1)
```

**Change:** Implement SQL-based fingerprint clustering. Raise `MAX_UNIQUE_VALUES` from 50k to 500k for fingerprint algorithm (now SQL-native). Keep phonetic algorithms in JS with 50k limit.

**Savings:** 5-10x faster fingerprint clustering. Raises practical limit from 50k to 500k unique values.

### 3.3 Batch Combine Stack Operations
**File:** `src/lib/combiner-engine.ts`

`stackTables()` does a single massive `UNION ALL` + `ROW_NUMBER()` + `gen_random_uuid()` on all rows. At 1M+1M rows, this can OOM.

**Change:** Use existing `batchExecute()` for combined row count > 500k. Process table A first (INSERT into staging), then table B. Add ID columns post-insert.

**Savings:** Prevents OOM for 1M+1M stacks. Reduces peak memory ~50%.

### 3.4 Batch Sequential Transforms During Replay
**File:** `src/lib/timeline-engine.ts`

During `replayToPosition`, commands replay one-by-one. Consecutive Tier 1 transforms on the same column (trim + lowercase + uppercase) each scan the full table separately.

**Change:** Pre-process `commandsToReplay` to identify runs of consecutive Tier 1 transforms on the same column, merge into a single compound UPDATE:
```sql
UPDATE "table" SET "col" = UPPER(LOWER(TRIM("col")))
```

**Savings:** For 5 consecutive same-column transforms, reduces 5 full-table scans to 1 (~2 seconds saved per replay at 1M rows).

### 3.5 Memory-Aware Adaptive Batch Execution
**File:** `src/lib/commands/batch-executor.ts`

Currently yields to browser between batches but doesn't check memory pressure.

**Change:** After every batch, check `getMemoryStatus()`. If `warning`, halve batch size for remaining batches. If `soft`, trigger immediate CHECKPOINT (don't wait for 5-batch interval). Add abort capability via `shouldCancel` callback.

**Savings:** Prevents OOM during complex transforms on 1M+ rows. System self-tunes batch size.

### 3.6 Lazy Field Similarity Calculation in Matcher
**File:** `src/lib/fuzzy-matcher.ts`

`calculateFieldSimilarities()` runs Jaro-Winkler on every column for every pair during matching (10k pairs x 30 columns = 300k JS string comparisons) before user sees results.

**Change:** Remove from matching loop. Add `getFieldSimilarities(pair)` computed on-demand when user clicks a pair for review. Make `fieldSimilarities` optional on `MatchPair` type.

**Savings:** Eliminates 300k+ unnecessary JS string comparisons during matching phase.

### 3.7 Proactive Hot Snapshot Eviction Under Memory Pressure
**Files:** `src/lib/timeline-engine.ts`, `src/stores/timelineStore.ts`

Hot snapshots (~150MB per 1M rows) are never evicted by memory pressure - only when a new one is created (1-slot LRU).

**Change:** Register `registerMemoryCleanup('hot-snapshots', ...)` callback that drops ALL hot snapshot tables across all timelines when memory reaches WARNING (1.5GB). Cold Parquet path remains for undo.

**Savings:** Reclaims ~150MB per hot snapshot under memory pressure.

---

## Tier 4: Future / Architectural (Multi-week)

### 4.1 Column Pruning for Tier 3 Transforms
Tier 3 commands use `SELECT *` in CTAS. For 50-column tables, this materializes all columns when only 1-2 are needed. Use `buildColumnOrderedSelect()` from `batch-utils.ts` in all modes.

### 4.2 Incremental/Delta Snapshots
Track changed row groups and export only deltas instead of full table copies. Requires manifest system, deterministic row-to-group assignment, and multi-generation snapshot composition. Depends on 1.5 (ROW_GROUP_SIZE reduction) as preparatory step.

### 4.3 Push Fuzzy Matching SQL Further
Lower oversized block threshold, use `TABLESAMPLE` instead of `ORDER BY RANDOM() LIMIT N`, add per-block SQL LIMIT reduction for strict strategy.

---

## Implementation Sequence

| Phase | Items | Effort | Risk | Dependencies |
|-------|-------|--------|------|-------------|
| **1** | 1.1, 1.2, 1.3, 1.4, 1.5 | 1-2 days | Low | None - all independent |
| **2** | 2.1, 2.2, 2.3, 2.4 | 3-5 days | Low-Med | Independent of each other |
| **3** | 3.1, 3.2, 3.6 | 3-4 days | Medium | Independent |
| **4** | 3.3, 3.4, 3.5, 3.7 | 4-6 days | Medium | 3.5 benefits from 2.3 |
| **5** | 4.1, 4.2, 4.3 | Multi-week | Higher | 4.2 depends on 1.5 |

## Critical Files

| File | Optimizations |
|------|--------------|
| `src/lib/commands/executor.ts` | 1.1, 1.2, 2.3, 2.4 |
| `src/lib/timeline-engine.ts` | 1.4, 2.2, 3.4, 3.7 |
| `src/lib/commands/batch-executor.ts` | 2.1, 3.5 |
| `src/lib/opfs/snapshot-storage.ts` | 1.5, 2.3 |
| `src/lib/duckdb/index.ts` | 1.3 |
| `src/lib/fuzzy-matcher.ts` | 3.1, 3.6 |
| `src/lib/standardizer-engine.ts` | 3.2 |
| `src/lib/combiner-engine.ts` | 3.3 |

## Verification Strategy

For each phase:
1. **Baseline:** Load 1M-row CSV, apply 5 Tier 1 + 1 Tier 3 transform, undo the Tier 3. Measure time + peak memory.
2. **Stress:** 50 alternating manual_edit + Tier 1 transforms, undo back 25 steps. Measure total replay time.
3. **Memory:** 3 tables x 500k rows, transforms on each. Verify memory stays below CRITICAL (2.5GB).
4. **Persistence:** After all operations, page reload, verify data integrity.
5. **Regression:** All existing E2E tests pass, especially `tier-3-undo-param-preservation.spec.ts`.
