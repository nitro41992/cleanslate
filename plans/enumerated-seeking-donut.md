# Enable Column Ordering TDD Tests

## Status: COMPLETED

## Context

Two column ordering E2E tests in `e2e/tests/column-ordering.spec.ts` were skipped during the E2E fix effort (Phase 1C) because they were written as TDD — tests-first before the feature was implemented. The column ordering infrastructure is **already complete** and was built across several prior PRs.

---

## Changes Made

### File: `e2e/tests/column-ordering.spec.ts`

**Change 1: "chained transformations preserve column order"**
- Removed `test.skip(true, 'Column ordering feature not yet implemented (TDD)')`
- Fixed test to keep panel open and use `waitForTransformComplete()` + `waitForGridReady()` between transforms (matching the proven recipe test pattern)
- Without `waitForGridReady()`, the Chromium renderer process would crash on the 3rd sequential transform apply due to DuckDB-WASM grid refresh contention

**Change 2: "transform after combiner preserves combined table order"**
- Removed `test.skip(true, 'Column ordering feature not yet implemented (TDD)')`
- Added `waitForGridReady()` after combiner close and after table switch
- Added `waitForTransformComplete()` after the trim transform

**No source code changes.** The column ordering infrastructure was already complete.

---

## Verification

Full column ordering suite: **13 passed, 1 skipped** (the >500k batched test was already skipped)

```
Running 14 tests using 1 worker
  1 skipped
  13 passed (1.3m)
```
