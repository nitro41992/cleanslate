# Fix: Formula Builder Columns Not Showing in Diff

## Problem
Columns added via the Formula Builder are not appearing in the Diff view. Running diff produces an error:
```
Error: Binder Error: Values list "b" does not have a column named "_cs_origin_id"
```

## Root Causes (TWO BUGS)

### Bug 1: Formula Builder Drops `_cs_origin_id`

The `ExcelFormulaCommand` uses explicit column selection which drops internal columns:

```typescript
const existingColumns = ctx.table.columns
  .filter((c) => c.name !== '_cs_id')  // _cs_origin_id NOT in ctx.table.columns
```

Compare to `Calculate Age` which uses `SELECT *` and preserves all columns.

### Bug 2: Diff Engine Assumes `_cs_origin_id` Exists

Even when diff-engine detects `hasOriginIdB: false`, it still tries to SELECT it (lines 795-796):
```sql
a."_cs_origin_id" as a_origin_id,
b."_cs_origin_id" as b_origin_id,  -- FAILS if table B doesn't have this column
```

## Files to Modify

### 1. `src/lib/commands/transform/tier3/excel-formula.ts`

**For `outputMode === 'new'` (lines 123-157):**

Replace explicit column selection with `SELECT *` pattern:

```typescript
if (outputMode === 'new') {
  // Use SELECT * to preserve ALL columns including internal ones (_cs_origin_id)
  const newColName = outputColumn!

  const sql = `
    CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
    SELECT *,
           (${sqlExpr}) AS ${quoteColumn(newColName)}
    FROM ${quoteTable(tableName)}
  `
  await ctx.db.execute(sql)
```

**For `outputMode === 'replace'` (lines 158-199):**

Use DuckDB's `SELECT * EXCLUDE` syntax to preserve internal columns:

```typescript
} else {
  // Replace existing column - use EXCLUDE to preserve internal columns
  const targetCol = targetColumn!

  const sql = `
    CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
    SELECT * EXCLUDE (${quoteColumn(targetCol)}),
           (${sqlExpr}) AS ${quoteColumn(targetCol)}
    FROM ${quoteTable(tableName)}
  `
  await ctx.db.execute(sql)
```

### 2. `src/lib/diff-engine.ts` (lines 795-796)

Make `_cs_origin_id` selection conditional based on whether the column exists.

**Before (lines 791-797):**
```typescript
SELECT
  COALESCE(a."_cs_id", b."_cs_id") as row_id,
  a."_cs_id" as a_row_id,
  b."_cs_id" as b_row_id,
  a."_cs_origin_id" as a_origin_id,
  b."_cs_origin_id" as b_origin_id,
  b._row_num as b_row_num,
```

**After:**
```typescript
// Check if _cs_origin_id exists in each table
const hasOriginIdA = colsAAllNames.includes(CS_ORIGIN_ID_COLUMN)
const hasOriginIdB = colsBAllNames.includes(CS_ORIGIN_ID_COLUMN)

// Build conditional origin_id selects
const aOriginIdSelect = hasOriginIdA
  ? `a."${CS_ORIGIN_ID_COLUMN}" as a_origin_id`
  : 'NULL as a_origin_id'
const bOriginIdSelect = hasOriginIdB
  ? `b."${CS_ORIGIN_ID_COLUMN}" as b_origin_id`
  : 'NULL as b_origin_id'

const createTempTableQuery = `
  ...
  SELECT
    COALESCE(a."_cs_id", b."_cs_id") as row_id,
    a."_cs_id" as a_row_id,
    b."_cs_id" as b_row_id,
    ${aOriginIdSelect},
    ${bOriginIdSelect},
    b._row_num as b_row_num,
```

### 3. `e2e/tests/diff-filtering.spec.ts`

Add a new test case for Formula Builder with Diff (after the Calculate Age test at line 140):

```typescript
test('should show rows with new formula column values in diff (Formula Builder)', async () => {
  /**
   * Scenario: Apply Formula Builder to create a new column
   * Expected: All rows should appear in diff as "modified" because they have new column values
   *
   * This tests that Formula Builder preserves _cs_origin_id for proper diff matching.
   */

  // Load test data
  await inspector.runQuery('DROP TABLE IF EXISTS formula_diff_test')
  await laundromat.uploadFile(getFixturePath('basic-data.csv'))
  await wizard.waitForOpen()
  await wizard.import()
  await inspector.waitForTableLoaded('basic_data', 5)

  const tableId = await inspector.getActiveTableId()
  expect(tableId).not.toBeNull()

  // Apply Formula Builder to create a new column
  await laundromat.openCleanPanel()
  await picker.waitForOpen()
  await picker.addTransformation('Formula Builder', {
    formula: 'LEN(@name)',
    outputMode: 'new',
    outputColumn: 'name_length'
  })
  await inspector.waitForTransformComplete(tableId!)

  // Verify the column was added
  const columnsAfter = await inspector.getTableColumns('basic_data')
  expect(columnsAfter.map(c => c.name)).toContain('name_length')

  // Open Diff View
  await laundromat.openDiffView()
  await diffView.waitForOpen()
  await diffView.runComparison()

  // Wait for diff to complete
  await expect.poll(async () => {
    const state = await page.evaluate(() => {
      const stores = window.__CLEANSLATE_STORES__
      return stores?.diffStore?.getState()?.summary
    })
    return state
  }, { timeout: 10000 }).not.toBeNull()

  const diffState = await inspector.getDiffState()
  const summary = diffState.summary!

  // CRITICAL: All rows should be modified because they have new column values
  expect(summary.modified).toBe(5)
  expect(summary.added).toBe(0)
  expect(summary.removed).toBe(0)

  // Verify the "1 column added" banner shows the formula column
  await expect(page.getByText('1 column added')).toBeVisible()
  await expect(page.getByText('name_length')).toBeVisible()
})
```

## Verification

After implementing:

1. Run the new E2E test:
```bash
npx playwright test "diff-filtering.spec.ts" --timeout=120000 --retries=0 --reporter=line
```

2. Verify existing diff tests still pass:
```bash
npx playwright test "diff-filtering.spec.ts" "diff-row-insertion.spec.ts" --timeout=120000 --retries=0 --reporter=line
```

3. Manual verification:
   - Import a CSV file
   - Apply Formula Builder with a new column (e.g., `LEN(@name)` → `name_length`)
   - Open Diff view
   - Verify "1 column added: name_length" banner appears
   - Verify all rows show as "modified"

## Reference Files
- `src/lib/commands/transform/tier3/calculate-age.ts` - Correct `SELECT *` pattern
- `src/lib/duckdb/index.ts` - `isInternalColumn()` function (line 79)
- `src/lib/diff-engine.ts` - Column detection logic (lines 491-510)
