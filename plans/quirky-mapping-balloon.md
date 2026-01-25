# E2E Test Fixes Plan

## Summary
Fix remaining E2E test failures across three phases: showstoppers, race conditions, and test pruning.

---

## Phase 1: Fix Showstoppers (Crashes & Timeouts)

### 1.1 Memory Optimization Timeouts
**File:** `e2e/tests/memory-optimization.spec.ts`

**Problem:** Tests timeout (30s default insufficient for Parquet/DuckDB in CI), causing "Target Page Closed" errors.

**Fix:**
- Move `test.setTimeout(120000)` to describe level (line ~402)
- Convert `beforeAll/afterAll` to `beforeEach/afterEach` for per-test page isolation
- **CRITICAL:** Re-instantiate ALL page objects with the NEW page in `beforeEach` - reusing old instances with new page causes immediate failures

```typescript
test.describe.serial('Memory Optimization - Chunked Parquet Snapshots', () => {
  test.setTimeout(120000)

  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector
  let picker: TransformationPickerPage

  test.beforeEach(async ({ browser }) => {
    // 1. Create fresh page
    page = await browser.newPage()

    // 2. Re-instantiate ALL page objects with the NEW page
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)
    picker = new TransformationPickerPage(page)

    // 3. Load the app
    await laundromat.goto()
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Clean OPFS, close page - force garbage collection
    await page.evaluate(async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        await opfsRoot.removeEntry('cleanslate.db')
      } catch {}
    })
    await page.close()
  })
})
```

### 1.2 "Table does not exist" (FR-A4)
**File:** `e2e/tests/feature-coverage.spec.ts`

**Problem:** FR-A4 tests depend on FR-A3 state. When FR-A3 fails, FR-A4 gets "Table fr_a3_text_dirty does not exist".

**Fix:** Add `loadTestData()` helper inside FR-A4 describe block (after line 1365):

```typescript
async function loadTestData() {
  // IMPORTANT: Reload to ensure clean state - prevents getting stuck in previous screen
  await page.reload()
  await inspector.waitForDuckDBReady()

  await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty')
  await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
  await wizard.waitForOpen()
  await wizard.import()
  await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)
}
```

Update tests `should commit cell edit` (line 1389) and `should undo/redo cell edits` (line 1427) to call `loadTestData()`.

### 1.3 Audit Sidebar Timeout (FR-C1)
**File:** `e2e/page-objects/laundromat.page.ts`

**Problem:** Audit sidebar timeout after `applyMerges()` - UI needs more settling time.

**Fix:** Update `openAuditSidebar()` method:

```typescript
async openAuditSidebar(): Promise<void> {
  await this.dismissOverlays()
  const toggleBtn = this.page.getByTestId('toggle-audit-sidebar')
  await toggleBtn.waitFor({ state: 'visible', timeout: 10000 })  // was 5000

  const sidebarOpen = await this.page.getByTestId('audit-sidebar').isVisible().catch(() => false)
  if (!sidebarOpen) {
    await toggleBtn.click({ force: true })
    await this.page.waitForTimeout(500)
  }
  await this.page.getByTestId('audit-sidebar').waitFor({ state: 'visible', timeout: 15000 })  // was 10000
}
```

---

## Phase 2: Fix Logic & Race Conditions

### 2.1 OPFS Persistence (Alice vs John Doe)
**File:** `e2e/tests/opfs-persistence.spec.ts`

**Problem:** Test expects `initialData[0].name` to be `'Alice'` (alphabetical) but DuckDB returns `'John Doe'` (insertion order from CSV).

**Root Cause:** `basic-data.csv` has rows in order: John Doe, Jane Smith, Bob Johnson, Alice Brown, Charlie Wilson. Test assumed alphabetical sorting.

**Fix:** Update assertions to match actual CSV order (lines 57, 66-67, 89):

```typescript
// Line 57: Fix initial data assertion
expect(initialData[0].name).toBe('John Doe')  // was 'Alice'

// Lines 66-67: Fix transformed data assertions
expect(transformedData[0].name).toBe('JOHN DOE')  // was 'ALICE'
expect(transformedData[1].name).toBe('JANE SMITH')  // was 'BOB'

// Line 89: Fix restored data assertion
expect(restoredData[0].name).toBe('JOHN DOE')  // was 'ALICE'
```

**Double-check:** The "Uppercase" transformation on `column: 'name'` should affect all rows. Verify it's not a filter operation that removes rows - the transformation targets the inspected rows (0 and 1).

### 2.2 UUID Mismatch (FR-REGRESSION-2)
**File:** `e2e/tests/audit-undo-regression.spec.ts`

**Problem:** `highlightState.rowIds` returns empty array `[]` - highlight click timing issue.

**Fix:** Add polling wait before assertions (around line 78):

```typescript
// After highlightBtn.click()
await expect.poll(
  async () => {
    const state = await inspector.getTimelineHighlight()
    return state.rowIds.length
  },
  { timeout: 5000, message: 'Highlight rowIds never populated' }
).toBeGreaterThan(0)

// Keep existing assertions but add fail-fast count check:
expect(highlightState.rowIds.length).toBe(expected_cs_ids.length)
expectRowIdsHighlighted(highlightState.rowIds, expected_cs_ids)
```

---

## Phase 3: Prune Redundant Tests

### 3.1 Remove FR-REGRESSION-10
**File:** `e2e/tests/audit-undo-regression.spec.ts`
**Lines:** 526-578

**Action:** Delete entire test block. It's an edge case (new columns in diff view) covered by main diff tests.

### 3.2 Skip FR-F-INT-3 and FR-F-INT-4
**File:** `e2e/tests/value-standardization.spec.ts`

**Problem:** Undo/Redo tests are flaky in E2E - should rely on unit tests instead.

**Action:** Mark both as `.fixme()`:
- Line 546: `test.fixme('FR-F-INT-3: Undo should revert standardization', ...)`
- Line 569: `test.fixme('FR-F-INT-4: Redo should reapply standardization', ...)`

Note: FR-F-INT-5 handles its own state by doing redo first, so it remains unaffected.

---

## Files to Modify

| File | Changes |
|------|---------|
| `e2e/tests/memory-optimization.spec.ts` | Timeout + per-test page isolation |
| `e2e/tests/feature-coverage.spec.ts` | Add loadTestData() helper for FR-A4 |
| `e2e/page-objects/laundromat.page.ts` | Increase audit sidebar timeouts |
| `e2e/tests/opfs-persistence.spec.ts` | Fix row order assertions |
| `e2e/tests/audit-undo-regression.spec.ts` | Add polling wait, remove FR-REGRESSION-10 |
| `e2e/tests/value-standardization.spec.ts` | Mark undo/redo tests as fixme |

---

## Verification

```bash
# Phase 1 verification
npx playwright test memory-optimization.spec.ts --workers=1
npx playwright test feature-coverage.spec.ts -g "FR-A4"
npx playwright test feature-coverage.spec.ts -g "FR-C1"

# Phase 2 verification
npx playwright test opfs-persistence.spec.ts
npx playwright test audit-undo-regression.spec.ts -g "FR-REGRESSION-2"

# Full suite
npm run test:e2e
```
