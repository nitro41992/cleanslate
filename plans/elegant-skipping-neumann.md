# Implementation Plan: Complete Stubbed Tests (FR-A3 + FR-D2)

## Overview

Implement 14 stubbed tests marked with `test.fail()` to complete the Clean transformations (FR-A3) and Smart Scrubber (FR-D2) functionality.

**Current Status:** 14 TDD tests failing as expected (stub tests)
**Target:** All 14 tests passing

---

## Key Implementation Decisions

| Decision | Approach | Rationale |
|----------|----------|-----------|
| Title Case | Use DuckDB's native `initcap()` | Cleaner than split/aggregate |
| Date Parsing | `TRY_CAST(x AS DATE)` first | More permissive for mixed formats |
| Fill Down | `rowid` ordering | Acceptable for MVP; note sort limitations |
| Split Column | Name collision check | Prevent conflicts with existing columns |
| Scrubber Tests | `data-testid` attributes | Reliable selection over text matching |

---

## Summary of Work

| Feature Area | Tests | Implementation Status |
|--------------|-------|----------------------|
| FR-A3 Text Transformations | 3 | Need new transformation code |
| FR-A3 Finance Transformations | 3 | Need new transformation code |
| FR-A3 Date/Structure Transformations | 4 | Need new transformation code |
| FR-D2 Smart Scrubber | 4 | **Backend complete** - fix tests + add data-testid |

---

## Part 1: FR-A3 Transformations (10 tests)

### Files to Modify

| File | Changes |
|------|---------|
| `src/types/index.ts` | Add 10 new `TransformationType` union members |
| `src/lib/transformations.ts` | Add 10 definitions + `countAffectedRows` + `applyTransformation` |
| `src/features/scrubber/components/ColumnRuleTable.tsx` | Add `data-testid` to SelectTrigger |
| `e2e/tests/feature-coverage.spec.ts` | Remove `test.fail()`, update scrubber test selectors |

### 1.1 Update TransformationType (src/types/index.ts:87-98)

Add to the union type:
```typescript
export type TransformationType =
  | 'trim' | 'lowercase' | 'uppercase' | 'remove_duplicates'
  | 'filter_empty' | 'replace' | 'split' | 'merge_columns'
  | 'rename_column' | 'cast_type' | 'custom_sql'
  // NEW - FR-A3
  | 'title_case'
  | 'remove_accents'
  | 'remove_non_printable'
  | 'unformat_currency'
  | 'fix_negatives'
  | 'pad_zeros'
  | 'standardize_date'
  | 'calculate_age'
  | 'split_column'
  | 'fill_down'
```

### 1.2 Add Transformation Definitions (src/lib/transformations.ts)

Add to `TRANSFORMATIONS` array after line 143:

#### Text Transformations
```typescript
{
  id: 'title_case',
  label: 'Title Case',
  description: 'Capitalize first letter of each word',
  icon: '🔤',
  requiresColumn: true,
},
{
  id: 'remove_accents',
  label: 'Remove Accents',
  description: 'Remove diacritical marks (cafe instead of cafe)',
  icon: 'e',
  requiresColumn: true,
},
{
  id: 'remove_non_printable',
  label: 'Remove Non-Printable',
  description: 'Remove tabs, newlines, control characters',
  icon: '🚫',
  requiresColumn: true,
},
```

#### Finance Transformations
```typescript
{
  id: 'unformat_currency',
  label: 'Unformat Currency',
  description: 'Remove $ , and convert to number',
  icon: '💵',
  requiresColumn: true,
},
{
  id: 'fix_negatives',
  label: 'Fix Negatives',
  description: 'Convert (500.00) to -500.00',
  icon: '−',
  requiresColumn: true,
},
{
  id: 'pad_zeros',
  label: 'Pad Zeros',
  description: 'Left-pad numbers with zeros',
  icon: '0',
  requiresColumn: true,
  params: [
    { name: 'length', type: 'number', label: 'Target length', default: '5' },
  ],
},
```

#### Date/Structure Transformations
```typescript
{
  id: 'standardize_date',
  label: 'Standardize Date',
  description: 'Convert to ISO format (YYYY-MM-DD)',
  icon: '📅',
  requiresColumn: true,
  params: [
    {
      name: 'format',
      type: 'select',
      label: 'Target format',
      options: [
        { value: 'YYYY-MM-DD', label: 'ISO (YYYY-MM-DD)' },
        { value: 'MM/DD/YYYY', label: 'US (MM/DD/YYYY)' },
        { value: 'DD/MM/YYYY', label: 'EU (DD/MM/YYYY)' },
      ],
      default: 'YYYY-MM-DD',
    },
  ],
},
{
  id: 'calculate_age',
  label: 'Calculate Age',
  description: 'Create age column from date of birth',
  icon: '🎂',
  requiresColumn: true,
},
{
  id: 'split_column',
  label: 'Split Column',
  description: 'Split by delimiter into multiple columns',
  icon: '✂️',
  requiresColumn: true,
  params: [
    { name: 'delimiter', type: 'text', label: 'Delimiter', default: ' ' },
  ],
},
{
  id: 'fill_down',
  label: 'Fill Down',
  description: 'Fill empty cells with value from above',
  icon: '⬇️',
  requiresColumn: true,
},
```

### 1.3 Add countAffectedRows Cases (src/lib/transformations.ts)

Add cases in `countAffectedRows()` switch (after line 259):

| Transform | DuckDB Query |
|-----------|-------------|
| title_case | `WHERE col != initcap(col)` |
| remove_accents | `WHERE col != strip_accents(col)` |
| remove_non_printable | `WHERE col != regexp_replace(col, '[\x00-\x1F\x7F]', '', 'g')` |
| unformat_currency | `WHERE col LIKE '%$%' OR col LIKE '%,%'` |
| fix_negatives | `WHERE col LIKE '(%)'` |
| pad_zeros | `WHERE LENGTH(CAST(col AS VARCHAR)) < target_length` |
| standardize_date | Count all non-null dates |
| calculate_age | Count all rows (creates new column) |
| split_column | `WHERE col LIKE '%delimiter%'` |
| fill_down | `WHERE col IS NULL OR TRIM(col) = ''` |

### 1.4 Add applyTransformation Cases (src/lib/transformations.ts)

Add cases in `applyTransformation()` switch (after line 558):

| Transform | DuckDB SQL Strategy |
|-----------|-------------------|
| title_case | `initcap(col)` - Native DuckDB function |
| remove_accents | `UPDATE SET col = strip_accents(col)` |
| remove_non_printable | `UPDATE SET col = regexp_replace(col, '[\x00-\x1F\x7F]', '', 'g')` |
| unformat_currency | `TRY_CAST(REPLACE(REPLACE(col, '$', ''), ',', '') AS DOUBLE)` |
| fix_negatives | `CASE WHEN col LIKE '(%)' THEN -TRY_CAST(...) ELSE TRY_CAST(...) END` |
| pad_zeros | `UPDATE SET col = LPAD(CAST(col AS VARCHAR), length, '0')` |
| standardize_date | `TRY_CAST(col AS DATE)` first, then `strftime()` |
| calculate_age | `DATE_DIFF('year', TRY_CAST(col AS DATE), CURRENT_DATE) as age` |
| split_column | See detailed implementation below |
| fill_down | `LAST_VALUE(col IGNORE NULLS) OVER (ORDER BY rowid ...)` |

### 1.5 Special Implementation: Split Column

**Complexity:** Need collision detection and dynamic column creation.

```typescript
case 'split_column': {
  const delimiter = (step.params?.delimiter as string) || ' '
  const escapedDelim = delimiter.replace(/'/g, "''")
  const baseColName = step.column!

  // 1. Find max number of parts
  const maxParts = await query<{ max_parts: number }>(
    `SELECT MAX(len(string_split("${baseColName}", '${escapedDelim}'))) as max_parts
     FROM "${tableName}"`
  )
  const numParts = Math.min(Number(maxParts[0].max_parts) || 2, 10)

  // 2. Check for name collisions and determine prefix
  const existingCols = await getTableColumns(tableName, true)
  const colNames = existingCols.map(c => c.name)
  let prefix = baseColName
  if (colNames.some(c => c.startsWith(`${baseColName}_1`))) {
    prefix = `${baseColName}_split`  // Fallback if collision
  }

  // 3. Build column expressions
  const partColumns = Array.from({ length: numParts }, (_, i) =>
    `string_split("${baseColName}", '${escapedDelim}')[${i + 1}] as "${prefix}_${i + 1}"`
  ).join(', ')

  // 4. Create new table with split columns
  sql = `
    CREATE OR REPLACE TABLE "${tempTable}" AS
    SELECT *, ${partColumns}
    FROM "${tableName}"
  `
  await execute(sql)
  await execute(`DROP TABLE "${tableName}"`)
  await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
  break
}
```

### 1.6 Special Implementation: Date Standardization

**Use `TRY_CAST` first** (more permissive than strict format parsing):

```typescript
case 'standardize_date': {
  const format = (step.params?.format as string) || 'YYYY-MM-DD'
  const formatMap: Record<string, string> = {
    'YYYY-MM-DD': '%Y-%m-%d',
    'MM/DD/YYYY': '%m/%d/%Y',
    'DD/MM/YYYY': '%d/%m/%Y',
  }
  const strftimeFormat = formatMap[format] || '%Y-%m-%d'

  sql = `
    CREATE OR REPLACE TABLE "${tempTable}" AS
    SELECT * EXCLUDE ("${step.column}"),
           strftime(TRY_CAST("${step.column}" AS DATE), '${strftimeFormat}') as "${step.column}"
    FROM "${tableName}"
  `
  await execute(sql)
  await execute(`DROP TABLE "${tableName}"`)
  await execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)
  break
}
```

### 1.7 Fill Down Limitations (MVP Note)

The `rowid`-based ordering reflects **ingestion order**, not grid sort order. If the UI allows column sorting in the future:
- Fill Down will still use original row order
- Consider adding `sortColumn` param to respect visible sort

---

## Part 2: FR-D2 Smart Scrubber Tests (4 tests)

### Status: Backend Complete

All scrubber functionality is **already implemented**:
- `src/lib/obfuscation.ts` - hash, redact, mask, year_only, faker, scramble, last4, zero, jitter
- `src/components/panels/ScrubPanel.tsx` - Full UI with ColumnRuleTable
- `src/stores/scrubberStore.ts` - State management

### The Problem

The tests fail because they look for `option` elements that don't exist in the current UI. The ColumnRuleTable uses a custom dropdown with method categories.

### Files to Modify

| File | Changes |
|------|---------|
| `src/features/scrubber/components/ColumnRuleTable.tsx` | Add `data-testid` to SelectTrigger |
| `e2e/tests/feature-coverage.spec.ts` | Update FR-D2 tests with proper UI interactions |

### 2.1 Add data-testid to ColumnRuleTable

In `ColumnRuleTable.tsx`, update the SelectTrigger for each column:

```tsx
<SelectTrigger
  className="h-8"
  data-testid={`method-select-${column.name}`}  // ADD THIS
>
```

This allows tests to reliably target "the dropdown for the Email column" instead of matching text.

### 2.2 Updated Test Strategy

1. Load `fr_d2_pii.csv` fixture with SSN, email, credit card, DOB columns
2. Open Scrub panel via toolbar
3. Select table from dropdown
4. For each column, select obfuscation method using `data-testid`:
   ```typescript
   await page.getByTestId('method-select-ssn').click()
   await page.getByRole('option', { name: /hash/i }).click()
   ```
5. Enter project secret
6. Click "Apply & Create Scrubbed Table"
7. Verify scrubbed data in new table

### 2.3 Test Implementation Example

```typescript
test('should hash sensitive columns', async () => {
  // Load PII data fixture
  await inspector.runQuery('DROP TABLE IF EXISTS fr_d2_pii')
  await laundromat.uploadFile(getFixturePath('fr_d2_pii.csv'))
  await wizard.waitForOpen()
  await wizard.import()
  await inspector.waitForTableLoaded('fr_d2_pii', 5)

  // Open scrub panel
  await laundromat.openScrubPanel()
  await expect(page.locator('text=Scrub Data')).toBeVisible()

  // Select hash method for SSN column using data-testid
  await page.getByTestId('method-select-ssn').click()
  await page.getByRole('option', { name: /hash/i }).click()

  // Enter secret
  await page.getByPlaceholder(/secret/i).fill('test-secret-123')

  // Apply
  await page.getByRole('button', { name: /Apply/i }).click()

  // Wait for scrubbed table
  await inspector.waitForTableLoaded('fr_d2_pii_scrubbed', 5)

  // Verify hash format (16-char hex)
  const data = await inspector.getTableData('fr_d2_pii_scrubbed')
  expect(data[0].ssn).toMatch(/^[a-f0-9]{16}$/)
})
```

---

## Part 3: Remove test.fail() Markers

After implementation, remove `test.fail()` from these lines in `e2e/tests/feature-coverage.spec.ts`:

| Line | Test |
|------|------|
| 87 | Title Case |
| 105 | Remove Accents |
| 125 | Remove Non-Printable |
| 174 | Unformat Currency |
| 193 | Fix Negatives |
| 212 | Pad Zeros |
| 262 | Standardize Date |
| 284 | Calculate Age |
| 304 | Split Column |
| 348 | Fill Down |
| 888 | Hash columns |
| 899 | Redact PII |
| 910 | Mask values |
| 920 | Year only |

---

## Implementation Order

1. **Phase 1: Types** - Add 10 new types to `TransformationType` union
2. **Phase 2: Definitions** - Add 10 entries to `TRANSFORMATIONS` array
3. **Phase 3: Count Logic** - Add 10 cases to `countAffectedRows()`
4. **Phase 4: Apply Logic** - Add 10 cases to `applyTransformation()`
5. **Phase 5: Run FR-A3 Tests** - Verify all 10 transformation tests pass, remove `test.fail()`
6. **Phase 6: Scrubber UI** - Add `data-testid` attributes to ColumnRuleTable.tsx
7. **Phase 7: Scrubber Tests** - Update FR-D2 tests with proper selectors, remove `test.fail()`
8. **Phase 8: Run Full Suite** - Verify no regressions, check lint

---

## DuckDB Functions Reference

| Function | Usage |
|----------|-------|
| `initcap(str)` | Title case (capitalize first letter of each word) |
| `strip_accents(str)` | Remove diacritical marks (cafe -> cafe) |
| `regexp_replace(str, pattern, replacement, 'g')` | Global regex replace |
| `LPAD(str, length, '0')` | Left-pad with zeros |
| `TRY_CAST(str AS DATE)` | Smart date parsing (preferred over strptime) |
| `strftime(date, format)` | Format date as string |
| `DATE_DIFF('year', date1, date2)` | Years between dates |
| `string_split(str, delim)` | Split into array |
| `string_split(str, delim)[i]` | Get i-th element (1-indexed) |
| `len(array)` | Get array length (for max splits) |
| `LAST_VALUE(col IGNORE NULLS) OVER (...)` | Window function for fill down |
| `TRY_CAST(expr AS type)` | Safe cast (returns NULL on failure) |

---

## Test Fixtures

| Fixture | Columns | Tests |
|---------|---------|-------|
| `fr_a3_text_dirty.csv` | id, name, email, notes | Title Case, Accents, Non-Printable |
| `fr_a3_finance.csv` | id, amount, currency_value, account_number, formatted_negative | Currency, Negatives, Pad Zeros |
| `fr_a3_dates_split.csv` | id, full_name, birth_date, date_us, date_eu, address | Dates, Age, Split |
| `fr_a3_fill_down.csv` | region, store, product, sales | Fill Down |
| `fr_d2_pii.csv` | (PII data) | All Scrubber tests |

---

## Verification

```bash
# Run transformation tests by group
npm test -- --grep "FR-A3: Text"
npm test -- --grep "FR-A3: Finance"
npm test -- --grep "FR-A3: Dates"
npm test -- --grep "FR-A3: Fill Down"

# Run scrubber tests
npm test -- --grep "FR-D2"

# Run full suite
npm test

# Check lint
npm run lint
```

---

## Expected Outcome

- **14 TDD tests pass** (removed `test.fail()`)
- **All existing tests remain passing**
- **~100 total tests passing**
