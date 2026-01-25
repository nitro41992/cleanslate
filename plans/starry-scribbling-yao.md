# Plan: Fix Failing E2E Tests

## Summary

13 tests are failing due to 5 root causes:
1. **Fragile selectors** - CSS class-based and text-based selectors breaking
2. **UUID mismatch** - Executor fallback includes all rows instead of affected rows only
3. **OPFS timing** - Tests reload before auto-flush completes (1000ms debounce)
4. **Memory crashes** - Serial tests accumulate memory without cleanup
5. **Cluster timing** - Value standardization test asserts before clusters populate

---

## Fixes

### 1. Fragile Selectors (6 files)

#### 1.1 `e2e/page-objects/laundromat.page.ts` (lines 108, 115)

**Current:**
```typescript
const sidebarOpen = await this.page.locator('text=Audit Log').first().isVisible().catch(() => false)
// ...
await this.page.locator('.text-sm:has-text("Audit Log")').waitFor({ state: 'visible', timeout: 10000 })
```

**Fix:**
```typescript
const sidebarOpen = await this.page.getByTestId('audit-sidebar').isVisible().catch(() => false)
// ...
await this.page.getByTestId('audit-sidebar').waitFor({ state: 'visible', timeout: 10000 })
```

#### 1.2 `e2e/page-objects/transformation-picker.page.ts` (lines 72-73)

**Current:**
```typescript
const columnSelect = this.page.locator('[role="combobox"]').filter({ hasText: /Select column/ })
```

**Fix:** Add a `data-testid` to the source component and use it:

**Step 1 - Add testid to `src/components/panels/CleanPanel.tsx`:**
Find the column `SelectTrigger` and add the testid:
```typescript
<SelectTrigger data-testid="column-selector">
  <SelectValue placeholder="Select column..." />
</SelectTrigger>
```

**Step 2 - Update test selector:**
```typescript
const columnSelect = this.page.getByTestId('column-selector')
await columnSelect.waitFor({ state: 'visible', timeout: 10000 })
await columnSelect.click()
```

#### 1.3 `e2e/page-objects/diff-view.page.ts` (lines 89-91)

**Current:**
```typescript
const checkbox = this.page.locator(`label:has-text("${columnName}")`)
```

**Fix:** Use `getByRole` with checkbox name (matches via associated label):
```typescript
async toggleKeyColumn(columnName: string): Promise<void> {
  const checkbox = this.page.getByRole('checkbox', { name: columnName })
  await checkbox.waitFor({ state: 'visible', timeout: 5000 })
  await checkbox.click()
}
```

#### 1.4 `e2e/tests/audit-undo-regression.spec.ts` (line 553)

**Current:**
```typescript
const keyColumnCheckbox = page.locator('label').filter({ hasText: /^id$/ }).first()
```

**Fix:**
```typescript
const keyColumnCheckbox = page.getByRole('checkbox', { name: 'id' })
await expect(keyColumnCheckbox).toBeVisible({ timeout: 3000 })
await keyColumnCheckbox.click()
```

---

### 2. UUID Mismatch - FR-REGRESSION-2

**File:** `src/lib/commands/executor.ts` (lines 396-410)

**Problem:** The fallback uses `WHERE column IS NOT NULL` which selects ALL rows, not just those actually affected by the transform.

**Fix:** Use the command's predicate for accurate affected rows:
```typescript
if (affectedRowIds.length === 0 && command.type.startsWith('transform:')) {
  const column = (command.params as { column?: string })?.column
  if (column && typeof command.getAffectedRowsPredicate === 'function') {
    try {
      const predicate = await command.getAffectedRowsPredicate(updatedCtx)
      if (predicate) {
        const result = await updatedCtx.db.query<{ _cs_id: string }>(`
          SELECT _cs_id FROM "${updatedCtx.table.name}"
          WHERE ${predicate}
        `)
        affectedRowIds = result.map(r => String(r._cs_id))
      }
    } catch (err) {
      console.warn('[EXECUTOR] Failed to extract affectedRowIds via predicate:', err)
    }
  }
}
```

---

### 3. OPFS Persistence Race Condition

**File:** `e2e/tests/opfs-persistence.spec.ts` (lines 69-74)

**Problem:** Auto-flush debounce is 1000ms. Fixed waits are slow and still flaky.

**Fix:** Use polling to detect when data is persisted (returns as soon as ready):
```typescript
// 4. Verify transformation applied
const transformedData = await inspector.getTableData('basic_data')
expect(transformedData[0].name).toBe('ALICE')

// 5. Reload and poll for persistence (no fixed wait)
await expect.poll(
  async () => {
    await page.reload()
    await inspector.waitForDuckDBReady()
    const tables = await inspector.getTables()
    return tables.some(t => t.name === 'basic_data')
  },
  { timeout: 10000, message: 'Table not restored from OPFS' }
).toBeTruthy()

// 6. Verify data persisted
const restoredData = await inspector.getTableData('basic_data')
expect(restoredData[0].name).toBe('ALICE')
```

Apply same polling pattern to all OPFS persistence tests that use `waitForTimeout` before reload.

---

### 4. Memory Crashes - Browser Closes

**Affected files:**
- `e2e/tests/memory-optimization.spec.ts`
- `e2e/tests/value-standardization.spec.ts`
- `e2e/tests/regression-diff-modes.spec.ts`
- `e2e/tests/regression-internal-columns.spec.ts`

**Problem:** Serial tests share a page context. Memory accumulates from DuckDB tables, Parquet snapshots, and internal `v_diff_*` tables.

#### Fix A: Add `afterEach` cleanup for lighter tests
```typescript
test.afterEach(async () => {
  // Drop internal diff tables created during comparison
  try {
    const internalTables = await inspector.runQuery(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE 'v_diff_%' OR table_name LIKE '_timeline_%'
    `)
    for (const t of internalTables) {
      await inspector.runQuery(`DROP TABLE IF EXISTS "${t.table_name}"`)
    }
  } catch {
    // Ignore errors during cleanup
  }
  // Press Escape to close any open panels
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})
```

#### Fix B: Fresh page per test for heavily crashing tests (memory-optimization Parquet)

**CRITICAL:** When creating a new page, you MUST re-instantiate ALL page objects:

```typescript
test.describe.serial('Memory Optimization - Chunked Parquet Snapshots', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector
  let diffView: DiffViewPage

  test.beforeEach(async ({ browser }) => {
    // Create fresh page
    page = await browser.newPage()

    // CRITICAL: Re-instantiate ALL page objects with new page reference
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    diffView = new DiffViewPage(page)

    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await page.close()
  })

  // ... tests ...
})
```

---

### 5. Value Standardization Cluster Test

**File:** `e2e/tests/value-standardization.spec.ts` (line 101)

**Problem:** Test asserts cluster counts before clusters are fully computed.

**Fix:** Use polling to wait for expected cluster count:
```typescript
// Wait for clusters to be computed (at least 3 clusters expected)
await expect.poll(
  async () => {
    const clusterData = await page.evaluate(() => {
      const stores = (window as any).__CLEANSLATE_STORES__
      return stores?.standardizerStore?.getState().clusters || []
    })
    return clusterData.length
  },
  { timeout: 10000, message: 'Clusters not computed' }
).toBeGreaterThanOrEqual(3)

// Now verify cluster sizes
const clusterData = await page.evaluate(...)
const clusterSizes = clusterData.map((c: any) =>
  c.values.reduce((sum: number, v: any) => sum + v.count, 0)
).sort((a: number, b: number) => b - a)
expect(clusterSizes.filter((size: number) => size === 3).length).toBeGreaterThanOrEqual(2)
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `e2e/page-objects/laundromat.page.ts` | Lines 108, 115 - use `getByTestId('audit-sidebar')` |
| `src/components/panels/CleanPanel.tsx` | Add `data-testid="column-selector"` to SelectTrigger |
| `e2e/page-objects/transformation-picker.page.ts` | Lines 72-73 - use `getByTestId('column-selector')` |
| `e2e/page-objects/diff-view.page.ts` | Lines 89-91 - use `getByRole('checkbox', { name })` |
| `e2e/tests/audit-undo-regression.spec.ts` | Line 553 - use `getByRole('checkbox', { name: 'id' })` |
| `src/lib/commands/executor.ts` | Lines 396-410 - use `getAffectedRowsPredicate()` |
| `e2e/tests/opfs-persistence.spec.ts` | Replace `waitForTimeout` with `expect.poll` pattern |
| `e2e/tests/memory-optimization.spec.ts` | Add cleanup + fresh page per test for Parquet tests |
| `e2e/tests/value-standardization.spec.ts` | Add `expect.poll` before cluster assertion |
| `e2e/tests/regression-diff-modes.spec.ts` | Add `afterEach` cleanup |
| `e2e/tests/regression-internal-columns.spec.ts` | Add `afterEach` cleanup |

---

## Verification

After implementing fixes, run the specific failing tests:
```bash
npx playwright test e2e/tests/audit-undo-regression.spec.ts --headed
npx playwright test e2e/tests/opfs-persistence.spec.ts --headed
npx playwright test e2e/tests/memory-optimization.spec.ts --headed
npx playwright test e2e/tests/feature-coverage.spec.ts --grep "FR-C1"
npx playwright test e2e/tests/value-standardization.spec.ts --headed
npx playwright test e2e/tests/regression-diff-modes.spec.ts --headed
npx playwright test e2e/tests/regression-internal-columns.spec.ts --headed
```

Then run full test suite:
```bash
npm run test:e2e
```
