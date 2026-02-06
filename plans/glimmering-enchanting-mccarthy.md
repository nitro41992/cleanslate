# Performance Optimization Plan: 1M+ Row Handling

## Problem Statement
CleanSlate Pro needs to handle 1M+ row datasets performantly across all operations (transforms, merge, diff, combine, standardize, undo/redo). Current architecture has solid foundations but several bottlenecks that compound at scale.

## Research Findings (Feb 2026)

### Hard Constraints
- **DuckDB-WASM usable memory: ~2GB** (not 4GB — WASM module overhead + 32-bit pointer limit). Memory64 exists but has 10-100% perf penalty and DuckDB hasn't adopted it.
- **Out-of-core is broken in WASM** — spill-to-disk designed for real filesystems, not OPFS. Dataset MUST fit in memory.
- **WASM memory never shrinks** — once allocated, only freed by killing the Web Worker. Long sessions accumulate.
- **No published UPDATE benchmarks** — all DuckDB-WASM benchmarks are for SELECTs. CleanSlate's mutation workload is uncharted.
- **OPFS**: 3-4x faster reads, 2x faster writes vs IndexedDB. SyncAccessHandle only in dedicated Workers.

### Competitive Landscape
No browser-based tool credibly does 1M+ row data *transformation* in-browser:
- Google Sheets: ~100k usable | Airtable: 50k-500k (plan-gated) | Excel: 1M (desktop native)
- Quadratic: Claims "millions", no benchmarks | Perspective: Benchmarks at 864k, read-only
- Observable+DuckDB: 5.2M rows read-only | Row Zero/Gigasheet: Billions, server backends

### Practical Size Limits (After Optimizations)
| Table Shape | Raw Size | Feasibility |
|---|---|---|
| 2M × 10 cols (narrow) | ~1 GB | Comfortable |
| 2M × 20 cols (typical) | ~1.5-2 GB | Feasible for transforms, tight for merge/diff |
| 2M × 30+ cols (wide) | ~3 GB+ | At the wall — simple transforms only |
| 1M + 1M (merge/diff) | ~2 GB combined | Feasible but tight |

### COI Multi-Threading Opportunity (Investigated)
DuckDB-WASM COI build variant gives **2-5x performance** via pthreads + SIMD. Requires COOP/COEP headers.

**Codebase is already set up for COI:**
- `src/lib/duckdb/index.ts` imports all 3 bundles (MVP, EH, COI) and auto-detects via `crossOriginIsolated`
- COI pthread worker initialization path already implemented (lines 156-167)
- `SET threads = 2` already in init code (line 362), currently silently fails on EH build
- **No third-party CDN scripts, fonts, OAuth popups, or iframes** — clean for COI

**Known Blocker: DuckDB-WASM Bug #2096**
- COI bundle + DuckDB's internal OPFS VFS = `DataCloneError` (FileSystemSyncAccessHandle non-cloneable across pthread workers)
- Already referenced in `vite.config.ts` (lines 5-9) and `browser-detection.ts` (lines 47-51)
- `supportsAccessHandle` forced to `false` as workaround
- **However**: CleanSlate's Parquet snapshot persistence uses JS File System API → OPFS (not DuckDB's VFS). This path may work under COI. Needs testing.

### Defensible Product Positioning
> "Process datasets up to 2 million rows entirely in your browser — no server, no upload. Simple transforms run in seconds. Advanced operations (merge, diff, combine) optimized for up to 1 million rows."

### Key Sources
- [DuckDB-WASM Memory Discussion #1241](https://github.com/duckdb/duckdb-wasm/discussions/1241)
- [Browser Data Processing Benchmarks (1M rows)](https://github.com/timlrx/browser-data-processing-benchmarks)
- [Mozilla: Is Memory64 Worth Using?](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)
- [DuckDB-WASM Memory Leak Issue #1904](https://github.com/duckdb/duckdb-wasm/issues/1904)
- [V8: 4GB WASM Memory](https://v8.dev/blog/4gb-wasm-memory)

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

### Phase 0: COI Threading Investigation (2-3 hours, do first)

**Goal:** Determine if DuckDB-WASM multi-threaded COI build works with CleanSlate's persistence layer. This potentially gives 2-5x performance for free.

**Step 1: Add COOP/COEP headers to Vite** (5 min)
File: `vite.config.ts`
Add inline plugin with middleware setting both headers for dev + preview servers.

**Step 2: Verify COI activation** (5 min)
- Open browser console, check `crossOriginIsolated === true`
- Check DuckDB init logs for "COI" bundle selection
- Verify `SharedArrayBuffer` is available

**Step 3: Functional testing** (1-2 hours)
- Upload a CSV (100k+ rows if possible)
- Apply Tier 1 transforms (trim, replace, lowercase)
- Apply a Tier 3 transform (remove_duplicates)
- Undo the Tier 3 transform
- Verify Parquet snapshot persistence survives page reload
- Test merge, diff, combine panels

**Step 4: Performance measurement** (30 min)
- Compare transform times: COI vs EH on same dataset
- Check memory usage under COI (may be higher due to thread buffers)
- Test `SET threads = N` with different values (1, 2, 4)

**Step 5: Deployment headers** (15 min)
If COI works, add production headers for hosting platform (Vercel/Netlify/CloudFlare config).

**Decision point after Phase 0:**
- **If COI + persistence works:** Proceed with Tier 1 optimizations. Item 1.3 changes from "SET threads = 1" to "SET threads = navigator.hardwareConcurrency" (or a capped value like 4).
- **If COI breaks persistence:** Keep EH build, proceed with Tier 1 as-is. Monitor DuckDB-WASM #2096 for upstream fix.

**Files to modify:**
- `vite.config.ts` — add COOP/COEP middleware plugin
- `vercel.json` or `netlify.toml` or `_headers` — production headers (depending on hosting)
- `src/lib/duckdb/index.ts` — potentially adjust `SET threads` value based on COI availability

---

### Subsequent Phases (after Phase 0)

| Phase | Items | Effort | Risk | Dependencies |
|-------|-------|--------|------|-------------|
| **1** | 1.1, 1.2, 1.3, 1.4, 1.5 | 1-2 days | Low | None — all independent |
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
