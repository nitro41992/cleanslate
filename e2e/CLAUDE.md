# E2E Testing Guidelines

## 1. State Isolation ("Clean Slate" Rule)

**Rule:** Never assume state persists cleanly. DuckDB-WASM is memory-intensive — shared contexts cause "Target Closed" crashes.

**Do NOT rely on `test.describe.serial` for data dependency.** Test B should never depend on Test A's data.

**Heavy Tests (Parquet/Large CSVs):** Use `beforeEach` with fresh page + re-initialized Page Objects:

```typescript
// ✅ Good: Fresh page per test
test.beforeEach(async ({ browser }) => {
  page = await browser.newPage()
  laundromat = new LaundromatPage(page)  // MUST re-init
  inspector = createStoreInspector(page)  // MUST re-init
  await page.goto('/')
  await inspector.waitForDuckDBReady()
})

test.afterEach(async () => {
  await page.close()  // Force garbage collection
})
```

```typescript
// ❌ Bad: Stale reference after crash
let inspector  // Old inspector holds reference to closed page
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  inspector = createStoreInspector(page)
})
// If Test A crashes WASM worker, Test B fails with stale reference
```

**Light Tests (shared context OK):**
```typescript
// In beforeAll:
await inspector.runQuery('DROP TABLE IF EXISTS my_table')
await laundromat.uploadFile(getFixturePath('my-fixture.csv'))
await wizard.import()
await inspector.waitForTableLoaded('my_table', expectedRows)
```

## 2. Async & Timing ("No Sleep" Rule)

**FORBIDDEN:** `await page.waitForTimeout(N)` — CI environments are slower than local.

**Use instead:**
- `await inspector.waitForDuckDBReady()` — DuckDB initialization
- `await inspector.waitForTableLoaded(name, rows)` — Table data ready
- `await expect(locator).toBeVisible()` — UI elements
- `await expect(locator).toBeHidden()` — Spinners disappear
- `await expect.poll(...)` — Data persistence checks

```typescript
// ❌ Bad: Hope it finished
await clickButton()
await page.waitForTimeout(2000)

// ✅ Good: Poll data store until predicate matches
await clickButton()
await expect.poll(async () => {
  return await inspector.getTableData('my_table')
}, { timeout: 10000 }).toHaveLength(5)
```

## 3. Selector Strategy

**Rule:** Select by user intent or explicit contract, never by DOM structure.

| Priority | Method | Use Case |
|----------|--------|----------|
| 1st | `getByRole` | buttons, checkboxes, headings |
| 2nd | `getByLabel` | form inputs |
| 3rd | `getByTestId` | wrappers, dynamic widgets |
| ❌ | Regex on text, generic CSS | Forbidden |

```typescript
// ❌ Bad: Breaks if "id" becomes "ID" or layout changes
page.locator('label').filter({ hasText: /^id$/ }).first().click()
page.locator('div > div > span').click()

// ✅ Good: Robust against HTML changes
await page.getByRole('checkbox', { name: 'id' }).click()
await page.getByTestId('column-selector-id').click()
```

## 4. Data Assertions

**Static Values — Assert Identity, Not Cardinality:**
```typescript
// ❌ Bad: expect(rows.length).toBe(3)
// ✅ Good: expect(rows.map(r => r.id)).toEqual([1, 3, 5])
```

**Dynamic Values (UUIDs, Timestamps) — Never hardcode:**
```typescript
// ❌ Bad: Fails next run
expect(rowIds).toEqual(['123e4567-e89b...'])

// ✅ Good: Check structure or count
expect(rowIds.length).toBeGreaterThan(0)
expect(rowIds.sort()).toEqual(expectedIds.sort())  // Standardize order
```

**Exact State Assertions:**
```typescript
// ❌ Bad: expect(valueAfterUndo).not.toBe(valueBeforeUndo)
// ✅ Good: expect(valueAfterUndo).toBe('Original Value')
```

## 5. Infrastructure & Timeouts

**Timeouts:** Default 30s is too short for WASM + Parquet. Set realistic timeouts:
```typescript
test.setTimeout(120000)  // 2 mins for heavy tests
```

**Self-Cleaning:** Don't leave database full for next worker:
```typescript
test.afterEach(async () => {
  await inspector.runQuery('DROP TABLE IF EXISTS test_table')
  await page.close()
})
```

**Serial Groups (light tests only):**
```typescript
test.describe.serial('FR-A3: Text Cleaning', () => {
  let page: Page, laundromat: LaundromatPage, inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => await page.close())
})
```

## 6. Test Helpers

| Helper | Location | Purpose |
|--------|----------|---------|
| `StoreInspector` | `helpers/store-inspector.ts` | Access stores, run DuckDB queries |
| `LaundromatPage` | `page-objects/laundromat.page.ts` | Laundromat UI interactions |
| `IngestionWizardPage` | `page-objects/ingestion-wizard.page.ts` | CSV import wizard |
| `TransformationPickerPage` | `page-objects/transformation-picker.page.ts` | Transform selection |
| `getFixturePath()` | `helpers/file-upload.ts` | Get path to CSV fixtures |

**Key StoreInspector Methods:**
```typescript
await inspector.waitForDuckDBReady()           // Wait for DuckDB init
await inspector.waitForTableLoaded(name, rows) // Wait for table
await inspector.getTableData(name)             // Get all rows
await inspector.runQuery(sql)                  // Execute SQL
await inspector.getAuditEntries()              // Get audit log
```

## 7. Fixtures

Located in `fixtures/csv/`:
- `basic-data.csv`, `whitespace-data.csv`, `mixed-case.csv`, `with-duplicates.csv`
- `fr_a3_*.csv` — Text cleaning | `fr_b2_*.csv` — Diff | `fr_c1_*.csv` — Dedupe
- `fr_d2_*.csv` — PII/scrubbing | `fr_e1/e2_*.csv` — Combine | `fr_f_*.csv` — Standardization

## 8. New Test Checklist

- [ ] **Isolation:** Does the test load its own data?
- [ ] **State:** If test crashes, will it affect the next? (Use `beforeEach` + fresh page if yes)
- [ ] **Selectors:** All using `getByRole`, `getByLabel`, or `getByTestId`?
- [ ] **Timing:** Zero `waitForTimeout` calls?
- [ ] **Dynamic Data:** UUIDs/Timestamps handled dynamically, not hardcoded?

## 9. Parameter Preservation Testing

Commands with custom parameters (e.g., `pad_zeros` with `length: 9`) must preserve those values through the undo/redo timeline system. Test failures indicate silent data corruption.

### The Replay Trigger Pattern

To verify parameters are preserved, trigger a timeline replay:

1. Apply the target transform with non-default params
2. Apply an unrelated Tier 3 transform (triggers snapshot)
3. Undo the Tier 3 transform (triggers replay from snapshot)
4. Verify the target transform still uses correct params via SQL

```typescript
// Use SQL polling to verify - DO NOT rely on UI alone
await expect.poll(async () => {
  const rows = await inspector.runQuery('SELECT val FROM test_table')
  return rows.every(r => String(r.val).length === 9)  // Verify padded length
}, { timeout: 10000 }).toBe(true)
```

### Test File Location

`e2e/tests/tier-3-undo-param-preservation.spec.ts`

### Helper Functions

Located in `e2e/helpers/param-preservation-helpers.ts`:

```typescript
// Apply transform and trigger replay via unrelated Tier 3 undo
await applyAndTriggerReplay(picker, laundromat, inspector, {
  name: 'Pad Zeros',
  column: 'id',
  params: { 'Length': '9' }
})

// Validate via SQL (primary) and timeline (secondary)
await validateParamPreservation(inspector, tableId, async () => {
  const rows = await inspector.runQuery('SELECT id FROM test_table')
  expect(rows.every(r => String(r.id).length === 9)).toBe(true)
})
```

### Commands Requiring Parameter Tests

| Risk Level | Commands |
|------------|----------|
| **High** | `split_column`, `combine_columns`, `match:merge` |
| **Medium** | `replace`, `pad_zeros`, `cast_type`, `mask`, `hash` |
| **Lower** | `replace_empty`, `custom_sql`, `calculate_age`, `fill_down` |

### Key Rule

**Always validate via SQL query, not just UI inspection.** The database is the source of truth.
