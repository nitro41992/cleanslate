# Plan: Fix Failing E2E Tests After Arrow IPC / Zero-Resident Architecture Migration

## Context

Branch `feat/arrow-ipc-coi-threading` introduces major architectural changes:
1. **Parquet → Arrow IPC**: Snapshot persistence uses Arrow IPC shards (`_shard_N.arrow`) + JSON manifests instead of `.parquet` files
2. **Zero-Resident Architecture**: Only one table is materialized in DuckDB at a time; other tables are "frozen" (shard-backed in OPFS)
3. **Materialization Gates**: New guards in `executor.ts`, `DataGrid.tsx`, and `editBatchStore.ts` that wait for frozen tables to materialize before allowing transforms/edits (currently **unstaged**)

The unstaged changes add frozenTable/materialization awareness to 3 files + new test cases to `zero-resident-architecture.spec.ts`. Since these are uncommitted, tests that depend on them (or code they modify) may be broken.

## Step 1: Diagnostic — Run Full Test Suite

Run all 36 E2E test files with appropriate timeouts to get a definitive list of failures:

```bash
npx playwright test --timeout=90000 --retries=0 --reporter=line 2>&1 | tee /tmp/e2e-results.txt
```

Categorize failures into:
- **A) Code bugs** — Tests that expose real issues in the application code
- **B) Test updates needed** — Tests that need updating for the new architecture
- **C) Flaky/timing** — Tests that need better wait patterns

## Step 2: Fix Known Issues

### 2a. Unstaged Code Changes — Verify Correctness

**Files with uncommitted changes:**
- `src/lib/commands/executor.ts` — Extended materialization gate to also handle `frozenTables` (not just `materializingTables`)
- `src/components/grid/DataGrid.tsx` — Added cell edit gate for frozen/materializing tables
- `src/stores/editBatchStore.ts` — Added deferred flush for frozen/materializing tables
- `e2e/tests/zero-resident-architecture.spec.ts` — Added 3 new Phase 4 tests

**Action:** Verify these changes compile and behave correctly. If any are causing regressions in existing tests, fix the logic.

### 2b. Tests Likely Needing Updates (From Analysis)

Based on code analysis, these **unmodified** test files are at risk:

| Test File | Risk | Reason |
|-----------|------|--------|
| `feature-coverage.spec.ts` | Medium | 68KB file, may do multi-table operations that hit frozen table state |
| `transformations.spec.ts` | Low-Medium | Basic transforms, but could be affected if table state is inconsistent |
| `audit-undo-regression.spec.ts` | Medium | Undo/redo with timeline changes; uses `coolHeap` for Tier 3 cleanup |
| `column-ordering.spec.ts` | Medium | Column order through snapshot restore may differ with Arrow IPC |
| `data-manipulation.spec.ts` | Low-Medium | Row insert/delete; journaled operations may affect timing |
| `diff-filtering.spec.ts` | Medium | Diff operations may need materialization waits |
| `diff-row-insertion.spec.ts` | Medium | Same as above |
| `value-standardization.spec.ts` | Medium | Clustering heavy, internal table names may differ |
| `recipe.spec.ts` | Low | Recipe replay may be affected by timeline changes |

### 2c. Common Fix Patterns

1. **Frozen table queries failing**: If a test queries a table that got frozen (second table uploaded while first was active), add `waitForMaterializationComplete()` after table switches
2. **Persistence file naming**: Any test checking for `.parquet` files needs to check for `_shard_N.arrow` + `_manifest.json` instead
3. **Save race conditions**: Tests polling `savingTables.size === 0` must also verify file size changed (per `e2e/CLAUDE.md` guidelines)
4. **Timeline/undo changes**: Tests using undo/redo may need `waitForReplayComplete()` or `waitForTimelinesRestored()`

## Step 3: Fix Each Failing Test

For each failure from Step 1, apply the appropriate fix:

- If test fails due to **frozen table not found in DuckDB**: Add `await inspector.waitForMaterializationComplete()` before operations
- If test fails due to **stale persistence assertions**: Update to Arrow IPC shard file patterns
- If test fails due to **timeout**: Increase timeout or add proper wait helpers
- If test fails due to **application code bug**: Fix the source code

## Step 4: Verification

After all fixes, run the full suite again:
```bash
npx playwright test --timeout=90000 --retries=0 --reporter=line
```

Run a second time to check for flakiness:
```bash
npx playwright test --timeout=90000 --retries=1 --reporter=line
```

## Key Files to Modify

**Application code (if needed):**
- `src/lib/commands/executor.ts` — Materialization gate logic
- `src/components/grid/DataGrid.tsx` — Cell edit gate
- `src/stores/editBatchStore.ts` — Deferred flush logic
- `src/lib/opfs/snapshot-storage.ts` — Persistence format
- `src/stores/tableStore.ts` — Frozen/materializing table state

**Test code:**
- `e2e/tests/zero-resident-architecture.spec.ts` — New Phase 4 tests
- Any other failing test files identified in Step 1
- `e2e/helpers/store-inspector.ts` — If new wait helpers needed

## Existing Functions/Utilities to Reuse

- `inspector.waitForMaterializationComplete()` — Already in `store-inspector.ts:1104`
- `inspector.waitForPersistenceComplete()` — Already in `store-inspector.ts:890`
- `inspector.waitForTransformComplete()` — Already in `store-inspector.ts:768`
- `inspector.waitForGridReady()` — Already in `store-inspector.ts:836`
- `inspector.waitForReplayComplete()` — Already in `store-inspector.ts:861`
- `inspector.flushToOPFS()` — Already in `store-inspector.ts:639`
- `inspector.saveAppState()` — Already in `store-inspector.ts:649`
- `inspector.getOPFSSnapshotFiles()` — Already in `store-inspector.ts:1066`
- `inspector.getOPFSManifest()` — Already in `store-inspector.ts:1088`
