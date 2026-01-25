# Implementation Plan: Playwright Test Architecture Memory Optimization

**Date:** 2026-01-24
**Status:** Ready for Implementation

## Problem Statement

The current Playwright test architecture in `feature-coverage.spec.ts` causes memory crashes in CI environments after tests 8-10 due to:

1. **Shared page contexts** across 2-7 tests per serial group (13 groups, 62 tests total)
2. **DuckDB state accumulation** (snapshots, audit tables, `__base` columns, internal diff tables)
3. **No systematic cleanup** between tests (no `afterEach` patterns)
4. **Canvas grid memory** from Glide Data Grid rendering persists
5. **Store state growth** (timeline, diff stores) not cleared

**Current Memory Impact:**
- Peak memory: ~2GB (crashes after test 8-10)
- Accumulation: 100-200MB per serial group
- CI success rate: 60% (OOM kills)

**Reference:** `regression-diff-modes.spec.ts` already implements the correct `beforeEach` pattern for diff-heavy operations.

---

## Solution: Tiered Migration Strategy

Balance DuckDB initialization cost (2-10s per test) against memory savings by categorizing tests by intensity:

| Category | Serial Groups | Strategy | Memory Savings |
|----------|---------------|----------|----------------|
| **CRITICAL** | 3 groups (9 tests) | Migrate to `beforeEach` | -800MB |
| **HIGH** | 2 groups (6 tests) | Add `afterEach` cleanup | -300MB |
| **LOW/MEDIUM** | 8 groups (47 tests) | Add lightweight cleanup | -100MB |

**Expected Outcomes:**
- Peak memory: ~1.2GB (prevents crashes)
- CI success rate: 95%+
- Runtime: ~4.5min (+50% for stability)

---

## Phase 1: Create Standardized Cleanup Utilities

### File: `e2e/helpers/heap-cooling.ts` (NEW)

Create a centralized "heap cooling" utility for explicit memory cleanup between tests.

**Key Functions:**

1. **`coolHeap(page, inspector, options)`** - Aggressive cleanup for HIGH-intensity tests
   - Drops all tables (user + internal)
   - Closes panels (releases React memory)
   - Clears diff/timeline store state
   - Prunes audit log if > 100 entries

2. **`coolHeapLight(page)`** - Lightweight cleanup for LOW-intensity tests
   - Closes panels via Escape key
   - No table drops (fast tests don't accumulate much)

**Options:**
```typescript
interface HeapCoolingOptions {
  dropTables?: boolean        // Drop all DuckDB tables
  closePanels?: boolean        // Close panels via Escape
  clearDiffState?: boolean     // Reset diffStore
  clearTimelineState?: boolean // Reset timelineStore (aggressive)
  pruneAudit?: boolean         // Prune audit log if > 100 entries
}
```

**Usage:**
```typescript
test.afterEach(async () => {
  await coolHeap(page, inspector, {
    dropTables: true,
    closePanels: true,
    clearDiffState: true,
  })
})
```

---

## Phase 2: Migrate CRITICAL Groups to `beforeEach` Pattern

**Groups to Migrate:**
- **FR-B2: Visual Diff** (1 test) - Diff operations create `v_diff_*` tables
- **FR-C1: Fuzzy Matcher** (4 tests) - Pairwise comparisons (O(n²)), merge operations
- **FR-C1: Merge Audit Drill-Down** (4 tests) - Multiple matcher runs, audit details

**Location:** `e2e/tests/feature-coverage.spec.ts` lines 398-726

**Pattern (from `regression-diff-modes.spec.ts`):**

```typescript
test.describe.serial('FR-C1: Fuzzy Matcher', () => {
  let browser: Browser
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let matchView: MatchViewPage
  let inspector: StoreInspector

  test.setTimeout(90000) // Accommodate DuckDB init per test

  test.beforeAll(async ({ browser: b }) => {
    browser = b // Store browser instance
  })

  test.beforeEach(async () => {
    // Create fresh page for each test
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    matchView = new MatchViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await page.close() // Free memory after each test
  })

  // Tests here get fresh page contexts
})
```

**Changes:**
- Replace `test.beforeAll` with `beforeAll + beforeEach` split
- Remove shared page from `beforeAll`, store only `browser`
- Add `test.afterEach` to close page
- Add `test.setTimeout(90000)` to accommodate multiple DuckDB inits

**Impact:**
- 9 tests × 5s DuckDB init = 45s overhead
- Memory savings: ~800MB (prevents accumulation)

---

## Phase 3: Add `afterEach` Cleanup to HIGH-Intensity Groups

**Groups:**
- **FR-D2: Obfuscation** (4 tests) - Hash/mask/redact operations
- **FR-E2: Combiner - Join Files** (2 tests) - Left/inner joins

**Location:** `e2e/tests/feature-coverage.spec.ts` lines 727-914, 994-1181

**Pattern:**

```typescript
test.describe.serial('FR-E2: Combiner - Join Files', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Aggressive cleanup after each test
    await coolHeap(page, inspector, {
      dropTables: true,
      closePanels: true,
      clearDiffState: true,
    })
  })

  // Tests here share page but clean up aggressively
})
```

**Impact:**
- Keeps shared page context (1 DuckDB init per group)
- Aggressive cleanup prevents accumulation
- Memory savings: ~300MB

---

## Phase 4: Add Lightweight Cleanup to LOW/MEDIUM Groups

**Groups (8 total):**
- FR-A3: Text Cleaning (6 tests)
- FR-A3: Finance & Number (3 tests)
- FR-A3: Dates & Structure (3 tests)
- FR-A3: Fill Down (1 test)
- FR-A6: Ingestion Wizard (3 tests)
- FR-A4: Manual Cell Editing (3 tests)
- Persist as Table (2 tests)
- FR-E1: Combiner - Stack Files (1 test)

**Location:** `e2e/tests/feature-coverage.spec.ts` lines 19-396, 1183-1358

**Pattern:**

```typescript
test.describe.serial('FR-A3: Text Cleaning Transformations', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  // Tests remain fast
})
```

**Impact:**
- Minimal overhead (Escape key presses)
- Memory savings: ~100MB

---

## Phase 5: Optimize StoreInspector for Visual Validation (Optional)

**Problem:** Tests rely on Playwright to "see" canvas rows via `waitForSelector`, which is flaky and memory-intensive.

**Solution:** Add `getGridState()` and `getHighlightState()` methods to `StoreInspector`.

### File: `e2e/helpers/store-inspector.ts`

**Add to interface:**

```typescript
export interface GridState {
  visibleRowCount: number
  totalRowCount: number
  visibleColumns: string[]
}

export interface HighlightState {
  isActive: boolean
  rowIds: string[]
  columnNames: string[]
}

export interface StoreInspector {
  // ... existing methods
  getGridState: () => Promise<GridState>
  getHighlightState: () => Promise<HighlightState>
}
```

**Implementation:**

```typescript
async getGridState(): Promise<GridState> {
  return page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
    const tableStore = stores?.tableStore as {
      getState: () => {
        activeTableId: string | null
        tables: { id: string; rowCount: number; columns: { name: string }[] }[]
      }
    } | undefined
    const state = tableStore?.getState()
    const activeTable = state?.tables?.find(t => t.id === state.activeTableId)

    return {
      visibleRowCount: activeTable?.rowCount || 0,
      totalRowCount: activeTable?.rowCount || 0,
      visibleColumns: activeTable?.columns?.map(c => c.name) || [],
    }
  })
}

async getHighlightState(): Promise<HighlightState> {
  return page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
    const timelineStore = stores?.timelineStore as {
      getState: () => {
        highlight: {
          rowIds: Set<string>
          highlightedColumns: Set<string>
        } | null
      }
    } | undefined
    const highlight = timelineStore?.getState()?.highlight

    return {
      isActive: !!highlight,
      rowIds: highlight ? Array.from(highlight.rowIds) : [],
      columnNames: highlight ? Array.from(highlight.highlightedColumns) : [],
    }
  })
}
```

**Test Refactoring:**

Before (flaky):
```typescript
await expect(page.locator('.bg-yellow-500').first()).toBeVisible()
```

After (store-based):
```typescript
const highlightState = await inspector.getHighlightState()
expect(highlightState.isActive).toBe(true)
expect(highlightState.rowIds).toContain('expected-row-id')
```

**Impact:**
- Reduces Playwright rendering overhead
- More reliable tests (no waitForSelector timeouts)
- Memory savings: ~50MB

---

## Critical Files

1. **`e2e/helpers/heap-cooling.ts`** (NEW)
   - Core cleanup utility with tiered options

2. **`e2e/helpers/store-inspector.ts`** (MODIFY)
   - Add `getGridState()` and `getHighlightState()` methods (optional)

3. **`e2e/tests/feature-coverage.spec.ts`** (MODIFY)
   - Lines 398-726: Migrate 3 CRITICAL groups to `beforeEach`
   - Lines 727-1181: Add `afterEach` cleanup to 2 HIGH groups
   - Lines 19-396, 1183-1358: Add lightweight cleanup to 8 LOW/MEDIUM groups

4. **`e2e/tests/regression-diff-modes.spec.ts`** (REFERENCE)
   - Already implements correct `beforeEach` pattern

---

## Migration Sequence

**Week 1: Foundation**
1. ✅ Create `heap-cooling.ts` utility
2. ✅ Add `getGridState()` and `getHighlightState()` to `StoreInspector` (optional)
3. ✅ Test cleanup utility on 1 low-risk group (e.g., FR-A3: Text Cleaning)

**Week 2: Critical Groups**
4. ✅ Migrate FR-C1: Fuzzy Matcher to `beforeEach`
5. ✅ Migrate FR-C1: Merge Audit Drill-Down to `beforeEach`
6. ✅ Migrate FR-B2: Visual Diff to `beforeEach`
7. ✅ Run full suite, verify no regressions

**Week 3: High-Intensity Groups**
8. ✅ Add `afterEach` cleanup to FR-D2: Obfuscation
9. ✅ Add `afterEach` cleanup to FR-E2: Combiner - Join Files
10. ✅ Verify memory reduction in CI logs

**Week 4: Polish**
11. ✅ Add lightweight cleanup to 8 LOW/MEDIUM groups
12. ✅ Refactor visual validation tests to use `StoreInspector` (optional)
13. ✅ Final CI validation, document results

---

## Verification Strategy

### Local Verification

```bash
npm run test:e2e -- feature-coverage.spec.ts
```

**Success Criteria:**
- All 62 tests pass
- No "Target page, context or browser has been closed" errors
- Total runtime < 6min

### Memory Profiling

Run with `--headed` flag:
```bash
npm run test:e2e -- feature-coverage.spec.ts --headed
```

Open DevTools → Memory → Heap Snapshot:
- Take snapshots before/after each serial group
- Verify memory drops after `afterEach` cleanup
- Target: Peak memory < 1.5GB

### CI Validation

Push to feature branch and monitor GitHub Actions:
- All 62 tests pass without OOM crashes
- No CI runner kills
- Runtime < 6min

### Regression Checks

```bash
npm run test:e2e -- regression-diff-modes.spec.ts
npm run test:e2e -- memory-optimization.spec.ts
```

- Ensure existing `beforeEach` patterns still work
- No performance regression (<10% slowdown)

---

## Success Criteria

✅ All 62 tests in `feature-coverage.spec.ts` pass in CI without crashes
✅ Peak memory usage < 1.5GB (measured via Chrome DevTools)
✅ No "Target page, context or browser has been closed" errors
✅ Total runtime < 6min (acceptable for stability gain)
✅ No flaky visual validation failures
✅ CI success rate: 95%+

---

## Risk Mitigation

**Risk 1:** DuckDB init overhead makes tests too slow
**Mitigation:** Only apply `beforeEach` to 3 CRITICAL groups (9 tests)
**Fallback:** Use `afterEach` cleanup instead of `beforeEach`

**Risk 2:** OPFS cleanup doesn't free memory
**Mitigation:** Combine table drops with `page.reload()` in `afterEach`
**Fallback:** Fall back to `beforeEach` pattern for problematic groups

**Risk 3:** CI timeout despite memory fixes
**Mitigation:** Split `feature-coverage.spec.ts` into 2 files (30 tests each)
**Fallback:** Reduce worker count to 1, increase timeout to 120s

---

## Notes

- This plan follows the user's architectural guidance:
  1. ✅ Shift from `beforeAll` to `beforeEach` for high-intensity suites
  2. ✅ Implement explicit "heap cooling" via standardized cleanup
  3. ✅ Optimize visual validation via store snapshots (optional)
  4. ⏸️ Decouple DuckDB initialization via persistent context (deferred)

- The `regression-diff-modes.spec.ts` file is the proven reference implementation
- Trade-off: +50% runtime for 95%+ CI stability is acceptable
- Optional Phase 5 (StoreInspector optimization) can be implemented separately
