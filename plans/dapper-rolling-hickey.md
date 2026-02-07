# Phase 4: Active Table Rework — Instant Thaw + Zero-Resident Operations [COMPLETED]

## Context

Phases 1-3 of the zero-resident architecture made heavy operations (diff, transform, combine) work shard-by-shard, dropping peak memory from ~2GB to ~280MB. But the active table itself is still fully loaded into the browser's memory at all times (~120MB for 1M rows). This creates two problems:

1. **Table switching is slow**: Switching from Table A to Table B takes 2-6 seconds because the browser must dump A to disk, then load B from disk — every single row.
2. **The active table wastes memory during operations**: When running a diff or combine, the active table sits idle in memory (~120MB) alongside the operation's working memory (~280MB). That's ~400MB total when only ~280MB is actually needed.

**Phase 4 eliminates both problems.** After this work:
- Table switching feels instant (data appears in <100ms, editing ready in 1-3s)
- Heavy operations get ~120MB more headroom because the active table is temporarily parked to disk

---

## How It Works (Product View)

**Before Phase 4:**
```
User clicks Table B → [2-6 second wait, blank screen] → Table B appears
```

**After Phase 4:**
```
User clicks Table B → [~100ms] → Table B data visible, scrollable
                    → [1-3s background] → "Ready to edit" indicator appears
```

The trick: instead of loading every row into memory, we read a tiny metadata file (the "manifest") and load only the ~50k rows the user can see. The full table loads in the background. The user can browse immediately; editing unlocks once the background load completes.

For heavy operations (diff, combine), the system temporarily parks the active table back to disk, runs the operation with maximum available memory, then reloads the table when done.

---

## Implementation Plan

### Sprint 4A: Populate `minCsId`/`maxCsId` in Shard Manifests

**Why**: To load the right chunk when the user scrolls to a specific position, we need to know which chunk contains which row ID ranges. Currently these fields are always `null`.

**What changes**:
- During shard export (`exportTableToSnapshot`), query `MIN(_cs_id)` and `MAX(_cs_id)` for each shard batch and write them into the manifest
- Legacy manifests without these values fall back to cumulative row-count lookup (already implemented in `ChunkManager.getRowRange()`)

**Files modified**:
- `src/lib/opfs/snapshot-storage.ts` — populate `minCsId`/`maxCsId` during export (lines ~400-408)

**Risk**: Very low. Additive change to existing export path.

---

### Sprint 4B: Shard-Backed Grid Rendering

**Why**: This is the core enabler — lets the grid display data without the full table in DuckDB.

**What changes**:

1. **New module: `src/lib/duckdb/shard-query.ts`** — Shard-aware query functions that mirror the existing query API but route through ChunkManager instead of querying a DuckDB table.

   Key functions:
   - `getShardDataArrowWithKeyset(snapshotId, manifest, cursor, limit, startRow)` — Finds the right shard via `minCsId`/`maxCsId` ranges, loads it via ChunkManager, runs the keyset query against the temp table, returns `ArrowKeysetPageResult` (same shape as current).
   - `estimateShardCsIdForRow(manifest, rowIndex)` — Finds the right shard via cumulative row counts, loads it, queries `_cs_id` at local offset.

   **Cross-shard page handling**: If a page spans two shards (e.g., user is at the boundary), both shards are loaded and a `UNION ALL` temp view is used for the query.

2. **Modify `useDuckDB.ts`** — `getDataArrowWithKeyset` checks if the table is in "shard-backed" mode (exists in `tableStore.frozenTables` but is the active table). If so, routes to `shard-query.ts`. If not, uses existing direct query.

3. **Modify `DataGrid.tsx`** — `estimateCsIdForRow` call routes through the same shard-backed check. Total row count comes from manifest instead of DuckDB `COUNT(*)`.

**How the grid knows total row count without querying DuckDB**:
- `tableStore` already tracks `rowCount` per table (set during import/thaw from manifest)
- Grid already reads `rowCount` from the store, not from a SQL query
- No change needed here

**Existing code reused**:
- `ChunkManager.loadShard()` / `evictShard()` — already handles LRU loading (`src/lib/opfs/chunk-manager.ts`)
- `ChunkManager.getRowRange()` — already maps row index → shard index (`chunk-manager.ts:308-337`)
- `readManifest()` — already reads manifest metadata (`src/lib/opfs/manifest.ts`)
- `ArrowKeysetPageResult` interface — same return type, grid component unchanged

**Files created**:
- `src/lib/duckdb/shard-query.ts`

**Files modified**:
- `src/hooks/useDuckDB.ts` — routing logic in `getDataArrowWithKeyset`
- `src/components/grid/DataGrid.tsx` — `estimateCsIdForRow` routing
- `src/lib/duckdb/index.ts` — export `estimateCsIdForRow` for override

**Risk**: Medium. New query path for grid rendering. Must handle edge cases: cross-shard pages, backward scroll, empty tables. Existing direct-query path is untouched (fallback).

---

### Sprint 4C: Instant Thaw with Background Materialization

**Why**: Makes table switching feel instant. The user sees data in ~100ms while the full table loads in background for editing.

**What changes**:

1. **Modify `thawTable()`** (`snapshot-storage.ts`) — New "lazy" mode:
   - Reads manifest only (no shard imports)
   - Returns immediately
   - Table is NOT created in DuckDB
   - Grid uses shard-backed rendering from Sprint 4B

2. **New: Background materialization** — After lazy thaw, a background task imports all shards sequentially into a DuckDB table:
   - Runs via `requestIdleCallback` / `setTimeout` to avoid blocking UI
   - Imports shards one-by-one using existing `importSingleShard()`
   - On completion: marks table as "materialized" (removes from `frozenTables`)
   - Grid seamlessly switches from shard-backed → direct DuckDB queries (no visual change)

3. **New state in `tableStore`**: `materializingTables: Set<string>` — tracks tables currently being background-materialized. UI can show subtle "Loading..." indicator.

4. **Edit gating** — If user tries to edit before materialization completes:
   - Cell edit / row ops / transforms check `materializingTables.has(tableId)`
   - If materializing: show brief toast "Table loading, please wait..." and wait for completion (with timeout)
   - If timeout: force-complete materialization synchronously

5. **Modify `switchToTable()`** (`tableStore.ts`):
   - Freeze current table: same as today (export + drop)
   - Thaw target table: lazy mode (manifest-only)
   - Start background materialization for target
   - Return immediately (UI unblocked)

**Existing code reused**:
- `importSingleShard()` — already imports one shard into DuckDB (`snapshot-storage.ts`)
- `importTableFromSnapshot()` — multi-shard import logic already exists (reuse for the background task)
- `freezeTable()` — unchanged
- Changelog replay — unchanged (runs after materialization completes)

**Files modified**:
- `src/lib/opfs/snapshot-storage.ts` — add lazy thaw mode, background materialization function
- `src/stores/tableStore.ts` — add `materializingTables` state, modify `switchToTable()`
- `src/lib/commands/executor.ts` — edit gating check before command execution
- `src/hooks/usePersistence.ts` — startup hydration uses lazy thaw for active table

**Risk**: Medium. Background materialization must handle: user switches away mid-materialization (cancel), DuckDB errors during import, memory pressure during import. Error recovery falls back to full synchronous thaw.

---

### Sprint 4D: Temporary Dematerialization During Heavy Operations

**Why**: Frees ~120MB of memory headroom during diff/combine operations. The active table is parked to disk, the operation runs with maximum available memory, then the table is restored.

**What changes**:

1. **New utility: `dematerializeActiveTable()` / `rematerializeActiveTable()`** in `snapshot-storage.ts`:
   - `dematerialize`: If table is clean (already saved to OPFS), just `DROP TABLE` + `CHECKPOINT`. If dirty, export first, then drop.
   - `rematerialize`: Import from OPFS shards back into DuckDB (same as thaw).

2. **Wire into diff engine** (`diff-engine.ts`):
   - Before `runDiff()`: call `dematerializeActiveTable()` if active table is materialized
   - After `runDiff()`: call `rematerializeActiveTable()` (the diff view needs the source pre-materialized anyway, which it already does)

3. **Wire into combiner engine** (`combiner-engine.ts`):
   - Same pattern: dematerialize before heavy combine, rematerialize after

4. **Progress indication**: During dematerialize/rematerialize, update existing progress stores so the user sees "Preparing..." / "Restoring table..." in the UI.

**Note**: Transforms already dematerialize via the Phase 2 shard-based engine (drop-and-rebuild). No change needed there.

**Files modified**:
- `src/lib/opfs/snapshot-storage.ts` — new `dematerializeActiveTable()` / `rematerializeActiveTable()`
- `src/lib/diff-engine.ts` — wrap `runDiff` with dematerialize/rematerialize
- `src/lib/combiner-engine.ts` — wrap heavy combine ops

**Risk**: Low-medium. Pattern already proven by Phase 2 transforms. Main risk is ensuring the table is cleanly saved before dropping. Error recovery: skip dematerialization and run with current memory budget (graceful degradation).

---

### Sprint 4E: Sort & Filter in Shard-Backed Mode

**Why**: When the table is in shard-backed mode (before materialization completes), the user might apply filters or sort. These require querying across all data.

**Strategy**: Filters and custom sort trigger immediate synchronous materialization. This is acceptable because:
- Materialization takes 1-3s (same as current thaw)
- Users expect a brief delay when filtering/sorting large tables
- Building cross-shard filter/sort indexes would be disproportionate complexity

**What changes**:
- `getFilteredDataWithKeyset` in `useDuckDB.ts`: If shard-backed AND filters/sort active, trigger materialization first, then query normally
- `getFilteredCount`: Same materialization trigger

**Files modified**:
- `src/hooks/useDuckDB.ts` — materialization trigger on filter/sort

**Risk**: Low. Falls back to current behavior after materialization.

---

## Delivery Order

| Sprint | Depends On | Effort | User-Visible Change |
|--------|-----------|--------|---------------------|
| 4A: Manifest minCsId/maxCsId | None | Small | None (internal) |
| 4B: Shard-backed grid rendering | 4A | Medium | None yet (wired in 4C) |
| 4C: Instant thaw + background materialization | 4A, 4B | Medium | Table switching feels instant |
| 4D: Dematerialize during operations | 4C | Small | Fewer OOM crashes on large tables |
| 4E: Sort/filter gating | 4C | Small | Sort/filter works in shard-backed mode |

**4A → 4B → 4C** is the critical path. 4D and 4E can be done in parallel after 4C.

---

## Memory Profile After Phase 4 (1M rows, 30 columns)

| Scenario | Before Phase 4 | After Phase 4 |
|----------|---------------|---------------|
| Table switching (thaw) | ~120MB for 2-6s | ~5MB instant, ~120MB after 1-3s background |
| Idle viewing (scrolling) | ~120MB constant | ~5-10MB (1-2 shards) until materialized |
| During diff operation | ~400MB peak (120 table + 280 diff) | ~280MB peak (table parked) |
| During combine operation | ~350MB+ peak | ~230MB peak (table parked) |
| Active editing | ~120MB (unchanged) | ~120MB (unchanged, table materialized) |

---

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|---------|
| User edits before materialization | Toast "Table loading...", wait for completion (max 10s timeout) |
| Background materialization fails | Fall back to synchronous thaw, log error |
| User switches away during materialization | Cancel background task, freeze target table |
| Sort/filter during shard-backed mode | Trigger synchronous materialization first |
| Legacy manifests (no minCsId/maxCsId) | Fall back to `getRowRange()` cumulative lookup |
| Memory pressure during materialization | Abort materialization, stay in shard-backed mode, show warning |
| Dematerialization fails (dirty table) | Skip dematerialization, run operation with current memory |
| Browser tab crash during dematerialization | Table safe in OPFS, restored on next load |

---

## Files Summary

| File | Action | Sprint |
|------|--------|--------|
| `src/lib/opfs/snapshot-storage.ts` | Modify (minCsId/maxCsId in export, lazy thaw, background materialize, dematerialize/rematerialize) | 4A, 4C, 4D |
| `src/lib/duckdb/shard-query.ts` | Create (shard-aware query functions) | 4B |
| `src/hooks/useDuckDB.ts` | Modify (routing logic, filter/sort gating) | 4B, 4E |
| `src/components/grid/DataGrid.tsx` | Modify (estimateCsIdForRow routing) | 4B |
| `src/lib/duckdb/index.ts` | Modify (export estimateCsIdForRow for override) | 4B |
| `src/stores/tableStore.ts` | Modify (materializingTables state, lazy switchToTable) | 4C |
| `src/lib/commands/executor.ts` | Modify (edit gating during materialization) | 4C |
| `src/hooks/usePersistence.ts` | Modify (startup hydration uses lazy thaw) | 4C |
| `src/lib/diff-engine.ts` | Modify (dematerialize wrapper around runDiff) | 4D |
| `src/lib/combiner-engine.ts` | Modify (dematerialize wrapper around heavy ops) | 4D |

---

## Verification Plan

### Automated Testing
1. **Manifest minCsId/maxCsId**: Export a multi-shard table → verify manifest has correct min/max per shard
2. **Shard-backed rendering**: Load a table in shard-backed mode → scroll through all pages → verify data matches full materialized view
3. **Cross-shard page**: Scroll to exact shard boundary → verify page renders correctly with data from both shards
4. **Instant thaw**: Switch tables → verify grid shows data in <500ms → verify editing works after background materialization
5. **Edit gating**: Switch to table → immediately try cell edit → verify toast appears → verify edit succeeds after materialization
6. **Dematerialization**: Run diff on large table → verify peak memory is ~120MB lower than without Phase 4
7. **Sort/filter in shard mode**: Apply filter before materialization completes → verify data is correct

### Manual Verification
8. **Perceived speed**: Switch between two 100k+ row tables — should feel instant (data visible immediately)
9. **200ms rule**: Small table (100 rows) — switching should feel identical to current behavior
10. **OOM stress test**: 1M-row table → run diff → should complete without OOM (was borderline before)
