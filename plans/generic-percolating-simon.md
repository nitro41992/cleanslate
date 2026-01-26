# E2E Test Optimization Plan

## Unified Strategy: Stability First, Then Speed

**Guiding Principle:** Strictly enforce "Clean Slate" and "No Sleep" rules before optimizing for speed.

---

## Phase 1: Stability First ("Stop the Bleeding")

**Priority:** CRITICAL
**Goal:** Stop random CI failures immediately

### 1.1 Refactor `dismissOverlays` in laundromat.page.ts

**Current Issue:** Blindly presses Escape and waits 100ms in a loop. Primary source of flake.

**File:** `e2e/page-objects/laundromat.page.ts`

**Required Change:**
```typescript
// BEFORE: Blind loop with fixed waits
async dismissOverlays() {
  for (let i = 0; i < 3; i++) {
    await this.page.keyboard.press('Escape')
    await this.page.waitForTimeout(100)
  }
}

// AFTER: State-aware dismissal
async dismissOverlays() {
  const dialog = this.page.getByRole('dialog')
  const sheet = this.page.locator('[data-state="open"]')

  // Only press Escape if something is actually visible
  if (await dialog.isVisible()) {
    await this.page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 1000 })
  }
  if (await sheet.isVisible()) {
    await this.page.keyboard.press('Escape')
    await expect(sheet).toBeHidden({ timeout: 1000 })
  }
}
```

### 1.2 Global "No Sleep" Enforcement

**Rule:** Replace `waitForTimeout(N)` with `expect.poll` for data assertions.

**Key Pattern - Poll Data Store, Not Just UI:**
```typescript
// ❌ WRONG: Wait and hope
await picker.addTransformation('Remove Duplicates')
await page.waitForTimeout(500)

// ✅ CORRECT: Poll the data store
await picker.addTransformation('Remove Duplicates')
await expect.poll(async () => {
  const res = await inspector.runQuery('SELECT count(*) as c FROM my_table')
  return Number(res[0].c)
}, { timeout: 10000 }).toBe(expectedCount)
```

**Files to fix (167 instances total):**

| File | Instances | Replacement Strategy |
|------|-----------|----------------------|
| `laundromat.page.ts` | 13 | State checks + `toBeHidden()` |
| `heap-cooling.ts` | 4 | `toBeHidden()` after Escape |
| `transformation-picker.page.ts` | 3 | Form visibility checks |
| `match-view.page.ts` | 6 | Keep 2000ms for fuzzy matching, fix others |
| `feature-coverage.spec.ts` | 49 | `expect.poll` + `runQuery` |
| `audit-undo-regression.spec.ts` | 23 | Timeline store polling |
| `regression-internal-columns.spec.ts` | 18 | Grid + data polling |
| `memory-optimization.spec.ts` | 15 | Keep 5 for heavy ops, fix 10 |
| `value-standardization.spec.ts` | 14 | Cluster analysis polling |
| `regression-diff.spec.ts` | 8 | Diff state polling |
| Others | 14 | Case-by-case |

---

## Phase 2: The "Golden Template" (Isolation + Speed)

**Priority:** HIGH
**Goal:** Fix `e2e-flow.spec.ts` and heavy regression tests

**Pattern: Strict Isolation + SQL Speed Injection**

```typescript
// === GOLDEN TEMPLATE FOR HEAVY TESTS ===
test.describe('Full E2E Flow', () => {
  let page: Page
  let laundromat: LaundromatPage
  let inspector: StoreInspector
  let picker: TransformationPickerPage

  // 1. ISOLATION: Fresh Page per test (prevents WASM crashes)
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    inspector = createStoreInspector(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await page.close() // Force garbage collection
  })

  test('deduplicate → export', async () => {
    // 2. SPEED: SQL Injection (bypasses slow Wizard UI)
    await createTableFromCSV(
      inspector,
      getFixturePath('with-duplicates.csv'),
      'with_duplicates'
    )
    await inspector.waitForTableLoaded('with_duplicates', 5)

    // 3. RELIABILITY: Poll Data Store (not just UI)
    await laundromat.openCleanPanel()
    await picker.addTransformation('Remove Duplicates')

    await expect.poll(async () => {
      const res = await inspector.runQuery(
        'SELECT count(*) as c FROM with_duplicates'
      )
      return Number(res[0].c)
    }, { timeout: 10000 }).toBe(3)
  })
})
```

**Apply Golden Template to:**
- `e2e/tests/e2e-flow.spec.ts` - Full integration tests
- `e2e/tests/regression-diff.spec.ts` - Heavy diff operations (100+ rows)
- `e2e/tests/memory-optimization.spec.ts` - Already using this pattern (verify)

---

## Phase 3: Targeted Optimization (Lighter Tests)

**Priority:** MEDIUM
**Goal:** Reduce runtime for lighter tests without full isolation overhead

### 3.1 Apply `coolHeapLight` to Light Serial Groups

For tests that don't crash WASM, skip expensive `browser.newPage()`:

```typescript
test.afterEach(async () => {
  await coolHeapLight(page)
})
```

**Apply to:**
| File | Groups |
|------|--------|
| `transformations.spec.ts` | 8 serial groups |
| `file-upload.spec.ts` | 1 serial group |
| `export.spec.ts` | 1 serial group |

### 3.2 Apply `coolHeap` to Medium-Weight Groups

```typescript
test.afterEach(async () => {
  await coolHeap(page, inspector, {
    dropTables: true,
    closePanels: true,
    clearDiffState: true,
  })
})
```

**Apply to:**
| File | Groups | Reason |
|------|--------|--------|
| `audit-details.spec.ts` | 1 group | 10 tests, heavy audit state |
| `audit-undo-regression.spec.ts` | 3 groups | Timeline accumulation |

### 3.3 SQL Data Setup for Non-Wizard Tests

**Use `createTableFromCSV` everywhere except wizard-specific tests:**

| File | Calls to Replace | Keep Wizard? |
|------|------------------|--------------|
| `export.spec.ts` | 6 | No |
| `audit-details.spec.ts` | 1 | No |
| `feature-coverage.spec.ts` (FR-A3) | 17 | No |
| `transformations.spec.ts` | 8 | No |
| `regression-diff.spec.ts` | 4 | No |
| `value-standardization.spec.ts` | 2 | No |
| **`file-upload.spec.ts`** | 0 | **YES - tests wizard itself** |
| **`feature-coverage.spec.ts` (FR-A6)** | 0 | **YES - tests wizard UI** |

---

## Execution Order

### Step 1: Fix `laundromat.page.ts` Overlays
- Refactor `dismissOverlays()` with state checks
- Run tests: `npm run test`

### Step 2: Fix Page Object Waits
- `heap-cooling.ts` (4 fixes)
- `transformation-picker.page.ts` (3 fixes)
- `match-view.page.ts` (4 fixes, keep 2 for fuzzy matching)
- Run tests: `npm run test`

### Step 3: Apply Golden Template to Heavy Tests
- `e2e-flow.spec.ts` - Fresh page + SQL setup
- `regression-diff.spec.ts` - Fresh page + SQL setup
- Run tests: `npm run test`

### Step 4: Add Cleanup to Light Tests
- Add `coolHeapLight` to 10 serial groups
- Add `coolHeap` to 4 serial groups
- Run tests: `npm run test`

### Step 5: Replace Test File Waits with `expect.poll`
- Start with `transformations.spec.ts` (2 instances)
- Progress to `audit-undo-regression.spec.ts` (23 instances)
- Continue through remaining files
- Run tests after each file

### Step 6: SQL Data Setup Migration
- `export.spec.ts` (6 calls)
- `feature-coverage.spec.ts` FR-A3 groups (17 calls)
- Remaining files
- Run tests: `npm run test`

---

## Files to Modify

| Phase | File | Changes |
|-------|------|---------|
| 1 | `e2e/page-objects/laundromat.page.ts` | Refactor `dismissOverlays` + replace 13 waits |
| 1 | `e2e/helpers/heap-cooling.ts` | Replace 4 waits with `toBeHidden()` |
| 1 | `e2e/page-objects/transformation-picker.page.ts` | Replace 3 waits |
| 1 | `e2e/page-objects/match-view.page.ts` | Replace 4 waits, keep 2 |
| 2 | `e2e/tests/e2e-flow.spec.ts` | Golden Template + SQL setup |
| 2 | `e2e/tests/regression-diff.spec.ts` | Golden Template + SQL setup |
| 3 | `e2e/tests/transformations.spec.ts` | Add `coolHeapLight` afterEach |
| 3 | `e2e/tests/file-upload.spec.ts` | Add `coolHeapLight` afterEach |
| 3 | `e2e/tests/export.spec.ts` | Add `coolHeapLight` + SQL setup |
| 3 | `e2e/tests/audit-details.spec.ts` | Add `coolHeap` + SQL setup |
| 3 | `e2e/tests/audit-undo-regression.spec.ts` | Add `coolHeap` + replace 23 waits |
| 3 | `e2e/tests/feature-coverage.spec.ts` | SQL setup (non-FR-A6) + replace 49 waits |
| 3 | `e2e/tests/value-standardization.spec.ts` | Replace 14 waits |
| 3 | `e2e/tests/regression-internal-columns.spec.ts` | Replace 18 waits |
| 3 | `e2e/tests/memory-optimization.spec.ts` | Replace 10 waits (keep 5) |

---

## Verification

After each step:
```bash
npm run test          # Full test suite
npm run test:headed   # Visual verification for tricky changes
```

**Success Criteria:**
- All 129 tests pass
- No new flakiness (run 3x to verify)
- Measurable runtime reduction (target: 20-30%)

---

## Key Directives Summary

1. **Fix `laundromat.page.ts` overlays first** - biggest flake source
2. **Use `expect.poll` instead of `waitForTimeout`** - poll data store
3. **Enforce `browser.newPage()` (Isolation)** for `e2e-flow` and `regression-diff`
4. **Use `createTableFromCSV` (Speed)** for everything except wizard tests
5. **Keep wizard UI tests isolated** in `file-upload.spec.ts` and FR-A6 only
