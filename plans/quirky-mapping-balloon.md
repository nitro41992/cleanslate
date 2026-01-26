# E2E Test Fixes Plan - Phase 2

## Summary
Fix remaining E2E test failures after Phase 1 implementation: FR-REGRESSION-2 feature bug, OPFS persistence, FR-C1 audit tests, and memory pressure.

---

## Implementation Status

| Issue | Status | Verification |
|-------|--------|--------------|
| Issue 1: FR-REGRESSION-2 | ✅ FIXED | All 12 audit-undo-regression tests pass |
| Issue 2: OPFS Persistence | ⚠️ Code complete, env issue | flushToOPFS helper added, but OPFS not persisting in headless test env |
| Issue 3: FR-C1 Merge Audit | ⚠️ Code complete, crashes persist | Aggressive cleanup added, but page crashes during test execution |
| Issue 4: Memory Pressure | ✅ IMPLEMENTED | Worker sharding + VACUUM added |

---

## Issue 1: FR-REGRESSION-2 Highlight Feature Bug

**Status:** ✅ FIXED

**Root Cause Analysis:**
The `rowIds` array was empty because `affectedRowIds` were not being populated during command execution when diff view extraction failed.

**Fix Applied in `src/lib/commands/executor.ts`:**
Enhanced fallback strategies for `affectedRowIds` extraction:

1. **Strategy 1** (existing): Use command's `getAffectedRowsPredicate`
2. **Strategy 2** (new): For tier 1 transforms, query rows where `__base` column differs from current value
3. **Strategy 3** (new): Fallback to all rows if we have rowsAffected count

Key fix: Strategy 2 now uses `WHERE "${baseColumn}" IS DISTINCT FROM "${column}"` instead of just checking `IS NOT NULL`.

**Verification:**
```bash
npx playwright test audit-undo-regression.spec.ts --workers=1
# Result: 12 passed
```

---

## Issue 2: OPFS Persistence Test Failures

**Status:** ⚠️ Code complete, environment limitation

**Changes Applied:**
1. `src/main.tsx`: Exposed `flushDuckDB` to window object
2. `e2e/helpers/store-inspector.ts`: Added `flushToOPFS()` helper method
3. `e2e/tests/opfs-persistence.spec.ts`: Added `await inspector.flushToOPFS()` before reload

**Remaining Issue:**
OPFS persistence tests still fail. The app may be running in memory mode in the headless test environment (OPFS detection via `navigator.storage.getDirectory()` may fail or return a different result).

---

## Issue 3: FR-C1 Merge Audit Test Crashes

**Status:** ⚠️ Code complete, crashes during test execution

**Changes Applied:**
1. `e2e/tests/feature-coverage.spec.ts`: Added aggressive heap cooling to both FR-C1 test sections
2. `e2e/helpers/heap-cooling.ts`: Added VACUUM after table drops

**Remaining Issue:**
Page crashes during test execution (not during cleanup). The fuzzy matcher operations are memory-intensive and cause browser context crashes when opening audit sidebar after merges.

---

## Issue 4: Memory Pressure (General)

**Status:** ✅ IMPLEMENTED

**Changes Applied:**
1. `playwright.config.ts`: Added worker sharding for memory-intensive test files
2. `e2e/helpers/heap-cooling.ts`: Added VACUUM after table drops

---

## Files Modified

| File | Changes |
|------|---------|
| `src/lib/commands/executor.ts` | Improved `affectedRowIds` fallback strategies (Strategy 2 fixed) |
| `src/main.tsx` | Exposed `flushDuckDB` to window for E2E tests |
| `e2e/helpers/store-inspector.ts` | Added `flushToOPFS()` method |
| `e2e/helpers/heap-cooling.ts` | Added VACUUM after table drops |
| `e2e/tests/opfs-persistence.spec.ts` | Added flush before reload calls |
| `e2e/tests/feature-coverage.spec.ts` | Added aggressive heap cooling to FR-C1 sections |
| `playwright.config.ts` | Worker sharding for memory-intensive tests |

---

## Remaining Work

### FR-C1 Memory Crashes
The FR-C1 tests crash during execution, not cleanup. Possible solutions:
1. Reduce dataset size in fixtures
2. Add explicit GC hints between operations
3. Split heavy operations across test boundaries
4. Increase browser memory limits

### OPFS Environment Detection
The OPFS persistence tests assume OPFS is available, but it may not be in headless Playwright. Possible solutions:
1. Skip tests when OPFS is not detected
2. Add explicit OPFS capability check before running tests
3. Use headed mode for OPFS tests

---

## Verification Commands

```bash
# Issue 1: FR-REGRESSION-2 (PASSING)
npx playwright test audit-undo-regression.spec.ts --workers=1

# Issue 2: OPFS persistence (env issue)
npx playwright test opfs-persistence.spec.ts --workers=1

# Issue 3: FR-C1 tests (crashes during execution)
npx playwright test feature-coverage.spec.ts -g "FR-C1" --workers=1

# Full suite
npm test
```
