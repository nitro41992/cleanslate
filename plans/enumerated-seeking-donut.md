# Zero-Resident Architecture: Complete Phase 4 + E2E Coverage

## Context

The zero-resident architecture (`plans/witty-crafting-rose.md`) is 90%+ complete. Phase 4 ("Active Table Rework") shipped the core behavior: tables freeze/thaw on switch, the grid renders from shards during background materialization, and a materialization indicator shows progress.

**The problem:** Cell edits don't wait for background materialization. If a user switches tables and immediately edits a cell, the edit silently fails because DuckDB doesn't have the table yet. Transforms and sort/filter already handle this correctly — cell edits are the gap.

**This sprint delivers two things:**

| Work | Type | Why |
|------|------|-----|
| A. Cell edit materialization gating | Bug fix | Prevents silent edit failures on frozen tables |
| C. E2E test coverage | Safety net | Phase 4 features shipped without adequate test coverage |

**Deferred:** Shard-level `fetchDiffPage` (Gap B) — a memory optimization that saves ~300-400MB during diff viewing. The existing pre-materialization workaround is sufficient for the 1M-row target. Infrastructure is ready (minCsId/maxCsId in manifests, ChunkManager APIs) when we're ready to pick it up.

---

## Gap A: Cell Edit Materialization Gating

**Problem:** When a user switches tables, the newly selected table starts frozen (shard-backed). If the user edits a cell before background materialization completes, the edit can silently fail because DuckDB doesn't have the table yet.

**What already works:** The `CommandExecutor` (executor.ts:191) checks `materializingTables` but NOT `frozenTables`. Sort/filter in `useDuckDB.ts` correctly handles both. Cell edits in `DataGrid.tsx` bypass the executor initially (they batch via `editBatchStore`).

### Changes

**1. `src/components/grid/DataGrid.tsx` ~line 2042 (after value-unchanged check)**

Add a materialization gate before any edit processing:
- Check `frozenTables.has(tableId) || materializingTables.has(tableId)`
- If materializing: show toast, `await waitForMaterialization(tableId)`
- If frozen but not materializing: trigger `backgroundMaterialize()`, then wait
- On timeout: show error toast, return without editing
- This protects both the batching path AND the legacy fallback path (line 2064)

**2. `src/stores/editBatchStore.ts` ~line 130 (flush timeout handler)**

Add materialization check before flush callback executes:
- If frozen/materializing: wait for materialization before calling `flushCallback`
- On timeout: don't clear batch (edits preserved for retry)
- This is defense-in-depth for the edge case where the table becomes frozen between edit and flush (user edits, then immediately switches tables)

**3. `src/lib/commands/executor.ts` ~line 191**

Enhance existing gate to also check `frozenTables`:
- Current: only checks `materializingTables.has(tableId)`
- New: also check `frozenTables.has(tableId)`, trigger materialization if needed
- Belt-and-suspenders for any command path, not just cell edits

### Pattern to follow

The sort/filter gate in `useDuckDB.ts:412-432` is the exact pattern — check frozen, check materializing, trigger if needed, wait, then proceed.

---

## Gap C: E2E Test Coverage

Add tests to `e2e/tests/zero-resident-architecture.spec.ts` (Tier 3 — fresh browser context per test, 120s timeout).

### High Priority

| # | Test | Validates |
|---|------|-----------|
| 1 | Cell edit after table switch waits for materialization | Gap A — executor gates edit until table ready |
| 2 | Transform on thawed table executes correctly | Gap A — CommandExecutor gate works for transforms |
| 3 | Stack with both source tables frozen | Phase 3 combiner + frozen source resolution |
| 4 | Join with one frozen source table | Phase 3 combiner join path with mixed sources |

### Medium Priority

| # | Test | Validates |
|---|------|-----------|
| 5 | Materialization indicator appears/disappears | UI feedback during table switch |
| 6 | Sort/filter works after table switch | Data integrity after freeze/thaw cycle |

### Lower Priority

| # | Test | Validates |
|---|------|-----------|
| 7 | Legacy `_part_N` snapshot migration | Backward compatibility (rename shard files, delete manifest, reload) |
| 8 | Memory measurement during table switch | `logMemoryUsage()` / `assertMemoryUnderLimit()` validation |

All tests use existing fixtures (`basic-data.csv`, `fr_e1_jan_sales.csv`, `fr_e1_feb_sales.csv`, `fr_e2_customers.csv`, `fr_e2_orders.csv`). No new fixtures needed. No new helpers needed — `waitForMaterializationComplete()`, `waitForCombinerComplete()`, `logMemoryUsage()` all exist.

---

## Implementation Order

| Step | Work | Files |
|------|------|-------|
| 1 | Cell edit materialization gating (Gap A) | `DataGrid.tsx`, `editBatchStore.ts`, `executor.ts` |
| 2 | E2E tests (Gap C) — high priority first, then medium | `zero-resident-architecture.spec.ts` |
| 3 | Update `plans/witty-crafting-rose.md` progress section | `witty-crafting-rose.md` |

---

## Verification

1. `npm run build` — no type errors
2. `npx playwright test "zero-resident-architecture.spec.ts" --timeout=90000 --retries=0 --reporter=line` — all tests pass (existing + new)
3. `npx playwright test --timeout=90000 --retries=0 --reporter=line` — full suite passes (no regressions)
4. Manual: open app, upload two CSVs, switch tables, edit a cell immediately — should see toast "Table loading..." then successful edit
