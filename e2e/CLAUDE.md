# E2E Testing Guidelines

## 1. State Isolation ("Clean Slate" Rule)

**Rule:** Never assume state persists cleanly. DuckDB-WASM is memory-intensive — shared contexts cause "Target Closed" crashes.

**Do NOT rely on `test.describe.serial` for data dependency.** Test B should never depend on Test A's data.

**Heavy Tests (Parquet/Large CSVs, Diff, Matcher):** Use `beforeEach` with fresh **browser context** + re-initialized Page Objects.

> **Why context, not just page?** DuckDB-WASM runs in a WebWorker. When WASM crashes, the worker state persists at the browser level. Closing just the page doesn't fully clean up SharedArrayBuffer memory or terminated workers. Browser contexts provide complete isolation including service workers and WebWorker state. See [Playwright Isolation Docs](https://playwright.dev/docs/browser-contexts).

```typescript
// ✅ Good: Fresh context per test (strongest isolation for WASM)
let browser: Browser
let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser: b }) => {
  browser = b
})

test.beforeEach(async () => {
  context = await browser.newContext()
  page = await context.newPage()
  laundromat = new LaundromatPage(page)  // MUST re-init
  inspector = createStoreInspector(page)  // MUST re-init
  await page.goto('/')
  await inspector.waitForDuckDBReady()
})

test.afterEach(async () => {
  try {
    await context.close()  // Terminates all pages + WebWorkers
  } catch {
    // Ignore - context may already be closed from crash
  }
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

```typescript
// ⚠️ Less robust: Fresh page only (OK for light tests, not for WASM-heavy)
test.beforeEach(async ({ browser }) => {
  page = await browser.newPage()
  // ...
})
test.afterEach(async () => {
  await page.close()  // May not fully clean up WebWorker state
})
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
- `await inspector.waitForTransformComplete(tableId)` — Transform operations complete
- `await inspector.waitForPanelAnimation(panelId)` — Panel open/close animations
- `await inspector.waitForMergeComplete()` — Matcher merge operations
- `await inspector.waitForCombinerComplete()` — Combiner stack/join operations
- `await inspector.waitForGridReady()` — Data grid fully initialized
- `await expect(locator).toBeVisible()` — UI elements
- `await expect(locator).toBeHidden()` — Spinners disappear
- `await expect.poll(...)` — Data persistence checks

**Network Idleness for Large File Uploads:**

For heavy Parquet/CSV uploads, ensure `uploadFile` waits for network to settle, not just the file input change:
```typescript
await laundromat.uploadFile(getFixturePath('large-dataset.parquet'))
await page.waitForLoadState('networkidle')  // Wait for upload to complete
await inspector.waitForTableLoaded('my_table', expectedRows)
```

**📚 See also:** `e2e/helpers/WAIT_HELPERS_QUICKREF.md` for detailed usage patterns

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

**Strict Mode — Avoid Ambiguous Locators:**

Playwright throws if a locator matches multiple elements. If your UI has duplicate labels (e.g., "Cancel" in both a modal and background page), scope locators to a container or use `.first()`:

```typescript
// ❌ Bad: Fails if "Save" exists in modal AND page background
await page.getByRole('button', { name: 'Save' }).click()

// ✅ Good: Scope to the visible dialog
await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()

// ✅ Also OK: Explicit first match (when order is predictable)
await page.getByRole('button', { name: 'Cancel' }).first().click()
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

**Clock Stability for Time-Sensitive Tests:**

If testing features that display relative times (e.g., "Modified 5 minutes ago"), use Playwright's clock API to prevent flakiness from CI slowness:

```typescript
// ❌ Bad: System clock ticks during slow CI run
expect(await page.getByText('Modified just now')).toBeVisible()

// ✅ Good: Freeze time for deterministic assertions
await page.clock.setFixedTime(new Date('2024-01-15T10:00:00Z'))
await performAction()
expect(await page.getByText('Modified just now')).toBeVisible()
```

## 5. Infrastructure & Timeouts

**Timeouts:** Default 30s is too short for WASM + Parquet. Set realistic timeouts:
```typescript
test.setTimeout(120000)  // 2 mins for heavy tests
```

**Tiered Cleanup Strategy:**

Serial test groups accumulate state (audit log, snapshots, timeline, diff tables). Use tiered cleanup to prevent memory pressure and flaky assertions:

**Tier 1 - Light Tests** (simple transforms: trim, uppercase, lowercase, replace)
```typescript
import { coolHeapLight } from '../helpers/cleanup-helpers'

test.afterEach(async () => {
  await coolHeapLight(page)  // Only closes panels
})
```

**Tier 2 - Medium Tests** (joins, multiple transforms, some diffs)
```typescript
import { coolHeap } from '../helpers/cleanup-helpers'

test.afterEach(async () => {
  await coolHeap(page, inspector, {
    dropTables: false,     // Keep tables for next test
    closePanels: true,
    clearDiffState: true,
    pruneAudit: true,
    auditThreshold: 50     // Prune if >50 entries
  })
})
```

**Tier 3 - Heavy Tests** (snapshots, matcher, large datasets, diff operations)

Use fresh browser context per test for complete WASM isolation:
```typescript
import { coolHeap } from '../helpers/cleanup-helpers'

let browser: Browser
let context: BrowserContext
let page: Page

test.setTimeout(120000)  // 2 mins for heavy WASM operations

test.beforeAll(async ({ browser: b }) => {
  browser = b
})

test.beforeEach(async () => {
  context = await browser.newContext()
  page = await context.newPage()
  laundromat = new LaundromatPage(page)  // MUST re-init
  inspector = createStoreInspector(page)  // MUST re-init
  await page.goto('/')
  await inspector.waitForDuckDBReady()
})

test.afterEach(async () => {
  try {
    await coolHeap(page, inspector, {
      dropTables: true,      // Full cleanup
      closePanels: true,
      clearDiffState: true,
      pruneAudit: true,
      auditThreshold: 30
    })
  } catch {
    // Ignore cleanup errors - page may be in bad state
  }
  try {
    await context.close()  // Terminates all WebWorkers, clears SharedArrayBuffer
  } catch {
    // Ignore - context may already be closed from crash
  }
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

  test.afterEach(async () => {
    await coolHeapLight(page)  // Tier 1 cleanup for simple transforms
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
| `coolHeap()` / `coolHeapLight()` | `helpers/cleanup-helpers.ts` | Tiered cleanup for serial tests |
| Grid state helpers | `helpers/grid-state-helpers.ts` | Canvas grid state assertions |

**Key StoreInspector Methods:**
```typescript
// Initialization & Data Loading
await inspector.waitForDuckDBReady()           // Wait for DuckDB init
await inspector.waitForTableLoaded(name, rows) // Wait for table

// Operation Completion (replaces waitForTimeout!)
await inspector.waitForTransformComplete(tableId)  // Transform done
await inspector.waitForPanelAnimation(panelId)     // Panel ready
await inspector.waitForMergeComplete()             // Matcher merge done
await inspector.waitForCombinerComplete()          // Combiner stack/join done
await inspector.waitForGridReady()                 // Grid ready

// Data Access
await inspector.getTableData(name)             // Get all rows
await inspector.runQuery(sql)                  // Execute SQL
await inspector.getAuditEntries()              // Get audit log
```

**Canvas Grid Testing:**

Glide Data Grid uses canvas rendering. Use store-based assertions instead of DOM inspection:

```typescript
import { waitForCellSelected, getSelectedCell, waitForGridScrolled } from '../helpers/grid-state-helpers'

// After clicking cell
await page.getByRole('gridcell', { name: 'Cell A1' }).click()
await waitForCellSelected(page, 0, 0)

// After programmatic scroll
await page.keyboard.press('PageDown')
await waitForGridScrolled(page, 20)

// Get current selection
const selected = await getSelectedCell(page)
expect(selected).toEqual({ row: 0, col: 1 })
```

**Always validate data via SQL, not canvas rendering:**
```typescript
// ✅ Good: Verify data in database
const rows = await inspector.runQuery('SELECT * FROM my_table')
expect(rows[0].name).toBe('John Doe')

// ❌ Bad: Try to scrape canvas content
// (Canvas content is not in DOM - this will fail)
```

**📚 Full documentation:** See `e2e/helpers/WAIT_HELPERS.md`, `WAIT_HELPERS_EXAMPLES.md`, `WAIT_HELPERS_QUICKREF.md`

## 7. Fixtures

Located in `fixtures/csv/`:
- `basic-data.csv`, `whitespace-data.csv`, `mixed-case.csv`, `with-duplicates.csv`
- `fr_a3_*.csv` — Text cleaning | `fr_b2_*.csv` — Diff | `fr_c1_*.csv` — Dedupe
- `fr_d2_*.csv` — PII/scrubbing | `fr_e1/e2_*.csv` — Combine | `fr_f_*.csv` — Standardization

## 8. Test Health Monitoring

**Monitoring Scripts** (see `scripts/README.md` for full documentation):

### Pattern Detection
```bash
npm run test:lint-patterns
```
Detects common flakiness patterns before commit:
- `picker.apply()` without `waitForTransformComplete()`
- `waitForTimeout()` usage (violates "No Sleep" rule)
- `Promise.race()` for operation completion
- `editCell()` without prior `waitForGridReady()`
- Cardinality assertions instead of identity assertions

### Flakiness Analysis
```bash
npx playwright test --reporter=json
npm run test:analyze
```
Tracks flaky tests over time, fails if flakiness rate exceeds 5% threshold. Reports saved to `test-results/`.

### Memory Monitoring
```typescript
import { logMemoryUsage, assertMemoryUnderLimit } from '../helpers/memory-monitor'

test('heavy operation', async ({ page }) => {
  await logMemoryUsage(page, 'before load')
  // ... heavy operation
  await logMemoryUsage(page, 'after operation')
  await assertMemoryUnderLimit(page, 60, 'after cleanup')
})
```
Use for heavy tests (Parquet, large CSVs, matcher) to catch memory leaks early.

---

## 9. New Test Checklist

- [ ] **Isolation:** Does the test load its own data?
- [ ] **State:** If test crashes, will it affect the next? (Use `beforeEach` + fresh context for Tier 3 tests)
- [ ] **Context vs Page:** Heavy tests (diff, matcher, large files) using `browser.newContext()` + `context.close()`?
- [ ] **Cleanup:** Using appropriate tier (1: light transforms, 2: joins/diffs, 3: snapshots/matcher)?
- [ ] **Timeout:** Heavy tests have `test.setTimeout(120000)` for WASM cold start?
- [ ] **Selectors:** All using `getByRole`, `getByLabel`, or `getByTestId`? Scoped to container if ambiguous?
- [ ] **Timing:** Zero `waitForTimeout` calls? Using `networkidle` for large uploads?
- [ ] **Clock:** Time-sensitive tests using `page.clock.setFixedTime()`?
- [ ] **Promise.race:** Not using it for operation completion? (Use dedicated wait helpers instead)
- [ ] **Dynamic Data:** UUIDs/Timestamps handled dynamically, not hardcoded?
- [ ] **Canvas Grid:** Using SQL or store-based assertions, not DOM scraping?
- [ ] **Patterns Check:** Run `npm run test:lint-patterns` before committing

## 10. Parameter Preservation Testing

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
