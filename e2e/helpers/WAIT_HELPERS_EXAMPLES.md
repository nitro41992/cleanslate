# Wait Helper Methods - Code Examples

Real-world examples showing before/after refactoring of `waitForTimeout()` violations using the new semantic wait helpers.

## Example 1: Transform + Panel Close

**File:** `e2e/tests/regression-internal-columns.spec.ts:103`

### Before
```typescript
await picker.waitForOpen()
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await laundromat.closePanel()
await page.waitForTimeout(500)  // ❌ Arbitrary wait

// Verify grid columns
const gridColumnsAfterTrim = await page.evaluate(() => {
  // ... grid column check
})
```

### After
```typescript
await picker.waitForOpen()
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await inspector.waitForTransformComplete()  // ✅ Semantic wait
await laundromat.closePanel()

// Verify grid columns
const gridColumnsAfterTrim = await page.evaluate(() => {
  // ... grid column check
})
```

**Why:** `waitForTransformComplete()` ensures the transformation has fully applied before proceeding, making the panel close timing irrelevant.

---

## Example 2: Merge Operation

**File:** `e2e/tests/feature-coverage.spec.ts:821-829`

### Before
```typescript
await matchView.mergePair(0)
await page.waitForTimeout(300)  // ❌ Arbitrary wait
await matchView.applyMerges()

// Wait for merge to complete and return to main view
await expect(page.getByText('Merges Applied')).toBeVisible({ timeout: 5000 })
await expect(page.getByTestId('data-grid')).toBeVisible({ timeout: 5000 })
await expect(page.getByTestId('match-view')).toBeHidden({ timeout: 5000 })
await page.waitForLoadState('networkidle')
await page.waitForTimeout(500)  // ❌ Arbitrary wait
```

### After
```typescript
await matchView.mergePair(0)
await matchView.applyMerges()
await inspector.waitForMergeComplete()  // ✅ Semantic wait

// Wait for UI to update
await expect(page.getByText('Merges Applied')).toBeVisible({ timeout: 5000 })
await inspector.waitForGridReady()  // ✅ Ensures grid is ready
await expect(page.getByTestId('match-view')).toBeHidden({ timeout: 5000 })
```

**Why:** `waitForMergeComplete()` polls the store state instead of guessing timing. `waitForGridReady()` ensures the grid has fully reloaded before proceeding.

---

## Example 3: Diff Comparison

**File:** `e2e/tests/regression-internal-columns.spec.ts:228-229`

### Before
```typescript
await page.locator('#key-id').click()
await page.getByTestId('diff-compare-btn').click()
await page.waitForTimeout(2000)  // ❌ Arbitrary wait

// Get diff grid column headers
const diffColumns = await page.evaluate(() => {
  const stores = window.__CLEANSLATE_STORES__
  // ...
})
```

### After
```typescript
await page.locator('#key-id').click()
await page.getByTestId('diff-compare-btn').click()

// Wait for comparison to complete
await expect.poll(async () => {
  const diffState = await inspector.getDiffState()
  return diffState.isComparing === false && diffState.summary !== null
}, { timeout: 15000 }).toBe(true)

await inspector.waitForGridReady()  // ✅ Ensures diff grid is ready

// Get diff grid column headers
const diffColumns = await page.evaluate(() => {
  const stores = window.__CLEANSLATE_STORES__
  // ...
})
```

**Why:** Diff operations use `diffStore.isComparing`, so we poll that state. Then ensure the grid is ready before reading columns.

---

## Example 4: Panel Open + Transformation

**File:** Common pattern across multiple tests

### Before
```typescript
await laundromat.openCleanPanel()
await page.waitForTimeout(300)  // ❌ Arbitrary wait
await picker.selectTransformation('Trim Whitespace')
await picker.selectColumn('name')
await picker.apply()
await page.waitForTimeout(500)  // ❌ Arbitrary wait
```

### After
```typescript
await laundromat.openCleanPanel()
await inspector.waitForPanelAnimation('panel-clean')  // ✅ Panel fully open
await picker.selectTransformation('Trim Whitespace')
await picker.selectColumn('name')
await picker.apply()
await inspector.waitForTransformComplete()  // ✅ Transform complete
```

**Why:** Panel animations have a specific completion state we can check. Transformations update the store when done.

---

## Example 5: Import + Immediate Undo

**File:** Various undo/redo tests

### Before
```typescript
await wizard.import()
await page.waitForTimeout(1000)  // ❌ Arbitrary wait
await laundromat.undo()
await page.waitForTimeout(500)  // ❌ Arbitrary wait

const rows = await inspector.getTableData('my_table')
expect(rows).toHaveLength(0)
```

### After
```typescript
await wizard.import()
await inspector.waitForTableLoaded('my_table', expectedRows)
await inspector.waitForGridReady()  // ✅ Grid ready for interaction

await laundromat.undo()
await inspector.waitForTransformComplete()  // ✅ Undo complete
await inspector.waitForGridReady()  // ✅ Grid updated

const rows = await inspector.getTableData('my_table')
expect(rows).toHaveLength(0)
```

**Why:** Undo/redo are transformations that update the store. Grid needs to refresh after state changes.

---

## Example 6: Audit Sidebar

**File:** `e2e/tests/feature-coverage.spec.ts:831-833`

### Before
```typescript
// Open audit sidebar
await laundromat.openAuditSidebar()
await page.waitForTimeout(300)  // ❌ Arbitrary wait

// Click on an audit entry with details
await page.locator('[data-testid="audit-entry-with-details"]').first().click()
```

### After
```typescript
// Open audit sidebar
await laundromat.openAuditSidebar()
const sidebar = page.getByTestId('audit-sidebar')
await expect(sidebar).toBeVisible({ timeout: 5000 })  // ✅ Explicit visibility check

// Wait for entries to load
await expect(page.locator('[data-testid="audit-entry-with-details"]').first())
  .toBeVisible({ timeout: 5000 })  // ✅ Wait for content

// Click on an audit entry
await page.locator('[data-testid="audit-entry-with-details"]').first().click()
```

**Why:** Sidebars don't have a specific panel animation helper, but we can use explicit visibility checks for the sidebar and its content.

---

## Example 7: Chained Transformations

**File:** Complex test scenarios with multiple transforms

### Before
```typescript
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await page.waitForTimeout(500)
await picker.addTransformation('Lowercase', { column: 'email' })
await page.waitForTimeout(500)
await picker.addTransformation('Replace', {
  column: 'phone',
  params: { 'Find': '-', 'Replace with': '' }
})
await page.waitForTimeout(500)

const rows = await inspector.getTableData('my_table')
```

### After
```typescript
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await inspector.waitForTransformComplete()

await picker.addTransformation('Lowercase', { column: 'email' })
await inspector.waitForTransformComplete()

await picker.addTransformation('Replace', {
  column: 'phone',
  params: { 'Find': '-', 'Replace with': '' }
})
await inspector.waitForTransformComplete()

const rows = await inspector.getTableData('my_table')
```

**Why:** Each transformation needs to complete before the next one starts. This ensures data consistency and prevents race conditions.

---

## Example 8: Match View Open

**File:** Matcher tests

### Before
```typescript
await laundromat.openMatchView()
await page.waitForTimeout(500)  // ❌ Arbitrary wait
await matchView.selectTable('fr_c1_dedupe')
```

### After
```typescript
await laundromat.openMatchView()
await inspector.waitForPanelAnimation('match-view')  // ✅ Panel fully open
await matchView.selectTable('fr_c1_dedupe')
```

**Why:** Match view is a panel/overlay that has animation states we can poll.

---

## Example 9: Heavy Data Load

**File:** Tests with large CSV/Parquet files

### Before
```typescript
await laundromat.uploadFile(getFixturePath('large-file.csv'))
await wizard.import()
await page.waitForTimeout(3000)  // ❌ Arbitrary wait, might not be enough

const tableInfo = await inspector.getTableInfo('large_file')
expect(tableInfo?.rowCount).toBe(50000)
```

### After
```typescript
await laundromat.uploadFile(getFixturePath('large-file.csv'))
await wizard.import()

// Wait with proper timeout for large dataset
await inspector.waitForTableLoaded('large_file', 50000, 60000)  // ✅ 60s timeout
await inspector.waitForGridReady(30000)  // ✅ Extra time for grid render

const tableInfo = await inspector.getTableInfo('large_file')
expect(tableInfo?.rowCount).toBe(50000)
```

**Why:** Large files need more time. Semantic waits with proper timeouts are self-documenting and adapt to actual completion.

---

## Example 10: Error Recovery

**File:** Tests that handle expected failures

### Before
```typescript
// Try invalid transformation
await picker.selectTransformation('Cast Type')
await picker.selectColumn('name')
await picker.selectParam('Target Type', 'INTEGER')
await picker.apply()
await page.waitForTimeout(1000)  // ❌ Hope error shows up

await expect(page.getByText('Cast failed')).toBeVisible()
```

### After
```typescript
// Try invalid transformation
await picker.selectTransformation('Cast Type')
await picker.selectColumn('name')
await picker.selectParam('Target Type', 'INTEGER')
await picker.clickApply()  // Don't use .apply() which waits for success

// Wait for error toast
await expect(page.getByText('Cast failed')).toBeVisible({ timeout: 5000 })

// Verify store state didn't change
await expect.poll(async () => {
  const tables = await inspector.getTables()
  return tables[0]?.dataVersion
}).toBe(originalVersion)
```

**Why:** Error cases should use explicit checks for error UI elements rather than waiting for success states.

---

## Migration Checklist

For each `waitForTimeout()` you find:

- [ ] Identify what operation happened just before the timeout
- [ ] Determine which store state changes as a result
- [ ] Replace with appropriate semantic wait helper
- [ ] Verify test still passes locally
- [ ] Verify test passes in CI (3 consecutive runs)
- [ ] Update test comments to explain what you're waiting for

## When You Can't Use These Helpers

Sometimes `waitForTimeout()` is genuinely needed:

1. **Debounced UI interactions** - Some UI elements have intentional debounce
2. **Animation timing tests** - When testing animation duration itself
3. **External service delays** - When waiting for non-app resources

In these rare cases, add a comment explaining WHY:
```typescript
// Animation duration is 300ms - testing it completes fully
await page.waitForTimeout(300)
```

But always try semantic waits first!
