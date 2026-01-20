# Plan: Optimize Playwright E2E Tests for DuckDB-WASM Cold Start

## Problem
Each of the ~57 tests creates a fresh page context, triggering DuckDB-WASM initialization (2-10s) per test. With `workers: 1` and no context sharing, total init overhead is 2-10 minutes.

## Solution Overview
1. **Serial Grouping**: Use `test.describe.serial` with shared page context via `beforeAll`/`afterAll`
2. **Parallel Workers**: Enable `fullyParallel: true` and `workers: '50%'` so serial groups run in parallel

## Implementation

### 1. Update `playwright.config.ts`
```typescript
fullyParallel: true,
workers: process.env.CI ? 4 : '50%',
```

### 2. Create Serial Setup Helper
**New file**: `e2e/helpers/serial-setup.ts`

```typescript
export interface SerialTestContext {
  page: Page;
  laundromat: LaundromatPage;
  wizard: IngestionWizardPage;
  picker: TransformationPickerPage;
  inspector: StoreInspector;
}

export async function createSerialContext(browser: Browser, route = '/laundromat'): Promise<SerialTestContext>

export async function loadFreshTable(ctx: SerialTestContext, fixture: string, tableName: string, expectedRows?: number): Promise<void>
```

### 3. Refactor Test Files

#### `e2e/tests/feature-coverage.spec.ts` (30 tests → ~10 serial groups)

Convert each `test.describe` block to `test.describe.serial` with shared context:

```typescript
test.describe.serial('FR-A3: Text Cleaning Transformations', () => {
  let page: Page;
  let laundromat: LaundromatPage;
  let wizard: IngestionWizardPage;
  let picker: TransformationPickerPage;
  let inspector: StoreInspector;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    laundromat = new LaundromatPage(page);
    wizard = new IngestionWizardPage(page);
    picker = new TransformationPickerPage(page);
    await laundromat.goto();
    inspector = createStoreInspector(page);
    await inspector.waitForDuckDBReady(); // Only once!
  });

  test.afterAll(async () => {
    await page.close();
  });

  // Helper to reload table for tests that modify data
  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty');
    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'));
    await wizard.waitForOpen();
    await wizard.import();
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8);
  }

  test('should trim whitespace from text fields', async () => {
    await loadTestData();
    // ... test code (uses shared page, inspector)
  });

  test('should convert text to uppercase', async () => {
    await loadTestData();
    // ... test code
  });

  // Continue for all 6 tests in this block
});
```

**Groups to create:**
| Group | Tests | Fixture |
|-------|-------|---------|
| FR-A3: Text Cleaning | 6 | fr_a3_text_dirty.csv |
| FR-A3: Finance & Number | 3 | fr_a3_finance.csv |
| FR-A3: Dates & Structure | 3 | fr_a3_dates_split.csv |
| FR-A3: Fill Down | 1 | fr_a3_fill_down.csv |
| FR-A6: Ingestion Wizard | 3 | mixed fixtures |
| FR-B2: Visual Diff | 2 | fr_b2_*.csv |
| FR-C1: Fuzzy Matcher | 3 | N/A |
| FR-D2: Obfuscation | 5 | N/A |
| FR-E1/E2: Combiner | 3 | mixed fixtures |
| FR-A4: Manual Cell Editing | 3 | mixed fixtures |

#### `e2e/tests/transformations.spec.ts` (17 tests → 8 serial groups by fixture)

Group tests by fixture file:

| Group | Fixture | Tests |
|-------|---------|-------|
| Whitespace | whitespace-data.csv | 3 (trim, chain, audit) |
| Mixed Case | mixed-case.csv | 2 (upper, lower) |
| Duplicates | with-duplicates.csv | 1 |
| Empty Values | empty-values.csv | 1 |
| Find Replace | find-replace-data.csv | 2 |
| Basic Data | basic-data.csv | 1 (rename) |
| Numeric Strings | numeric-strings.csv | 3 (cast int, cast date, custom SQL) |
| Case Sensitive | case-sensitive-data.csv | 4 (find/replace variants) |

#### `e2e/tests/file-upload.spec.ts` (7 tests → 1 serial group)

All tests share context - order tests so read-only tests run first:
1. show dropzone (read-only)
2. open ingestion wizard (read-only, cancel at end)
3. detect pipe delimiter (read-only, cancel at end)
4. load file with default settings (loads data)
5. show data grid (uses loaded data)
6. allow custom header row (loads different data)
7. cancel wizard (read-only)

#### `e2e/tests/e2e-flow.spec.ts` (3 tests → keep parallel)

These are full E2E flows requiring complete isolation. Keep as separate tests (no serial grouping) - they'll run in parallel workers.

## Files to Modify

| File | Changes |
|------|---------|
| `playwright.config.ts` | Enable parallelism |
| `e2e/helpers/serial-setup.ts` | **NEW** - shared context helper |
| `e2e/tests/feature-coverage.spec.ts` | Convert to ~10 serial groups |
| `e2e/tests/transformations.spec.ts` | Convert to 8 serial groups |
| `e2e/tests/file-upload.spec.ts` | Convert to 1 serial group |
| `e2e/tests/e2e-flow.spec.ts` | No changes (parallel E2E tests) |

## Expected Performance

| Metric | Before | After |
|--------|--------|-------|
| DuckDB Inits | ~57 | ~20 |
| Init Overhead | 2-10 min | 30-60s |
| Parallelism | None | 4 workers |

## Verification

1. Run `npm test` - all tests should pass
2. Compare test run time before/after
3. Verify no test order dependencies (run with `--shard` to randomize)
4. Check CI pipeline completes faster
