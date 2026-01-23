# Fix Calculate Age Audit + Diff View Issues

## Problem Summary

Two issues with the Calculate Age transformation:

### Issue 1: Audit Log Shows Wrong "Previous Value"

**Current behavior:**
- Column: `sub_dt` (source column)
- Previous Value: `2025-07-04` (the date)
- New Value: `1` (calculated age)

**Expected behavior:**
- Column: `age` (the NEW column)
- Previous Value: `<new column>` (indicator that column didn't exist)
- New Value: `1` (calculated age)

**Root cause:** `captureCalculateAgeDetails()` treats Calculate Age like a column modification, but it's a column CREATION.

### Issue 2: Diff View Shows New Column as Yellow (Modified)

**Current behavior:** The `age` column shows yellow (modified) with `(-DEL)` badge in header

**Expected behavior:** The `age` column should show green (new/added)

**Root cause:** `getModifiedColumns()` in `diff-engine.ts` compares NULL (missing in original) vs actual value, treating new columns as "modified"

---

## Implementation Plan

### Task 1: Fix Audit Capture for Calculate Age ✅ APPROVED

**File:** `src/lib/commands/audit-capture.ts`

**Change:** Update `captureCalculateAgeDetails()` to use new column semantics (following the "Combine Columns" pattern):

```typescript
async function captureCalculateAgeDetails(
  tableName: string,
  column: string,
  auditEntryId: string,
  params?: Record<string, unknown>  // Add params to get newColumnName
): Promise<boolean> {
  // Use new column name with robust fallback (matches backend default)
  const newColName = (params?.newColumnName as string) || 'age'
  const escapedNewCol = newColName.replace(/'/g, "''")

  // ... existing date parsing logic ...

  const insertSql = `
    INSERT INTO _audit_details (...)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedNewCol}',          -- NEW column name, not source column
      '<new column>',              -- Previous: column didn't exist
      ${newValueExpression},       -- New: calculated age
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `
}
```

**Also update:** `captureTier23RowDetails()` to pass `params` to `captureCalculateAgeDetails()`

---

### Task 2: Fix Diff Engine Cell Highlighting ✅ APPROVED (Scoped Fix)

**Scope:** Fix cell-level yellow highlighting for new columns. Do NOT over-engineer row status logic.

**Data Flow (Already Working):**
1. `runDiff()` computes `newColumns` and `removedColumns` by comparing schemas
2. `DiffView.tsx` stores these in `diffStore` via `setDiffConfig()`
3. `VirtualizedDiffGrid` receives `newColumns` and `removedColumns` as props

**Missing Piece:** `getModifiedColumns()` doesn't receive these arrays.

**File:** `src/lib/diff-engine.ts`

**Change:** Update `getModifiedColumns()` signature:

```typescript
export function getModifiedColumns(
  row: DiffRow,
  allColumns: string[],
  keyColumns: string[],
  newColumns: string[] = [],      // Add parameter
  removedColumns: string[] = []   // Add parameter
): string[] {
  if (row.diff_status !== 'modified') return []

  const modified: string[] = []
  for (const col of allColumns) {
    if (keyColumns.includes(col)) continue
    // NEW: Skip columns that are structural additions/deletions
    if (newColumns.includes(col)) continue
    if (removedColumns.includes(col)) continue

    const valA = row[`a_${col}`]
    const valB = row[`b_${col}`]
    if (String(valA ?? '') !== String(valB ?? '')) {
      modified.push(col)
    }
  }
  return modified
}
```

**File:** `src/components/diff/VirtualizedDiffGrid.tsx`

**Change:** Pass `newColumns` and `removedColumns` to `getModifiedColumns()` in TWO places:

```typescript
// 1. In getCellContent callback (line ~206):
const modifiedCols = getModifiedColumns(rowData, allColumns, keyColumns, newColumns, removedColumns)

// 2. In drawCell callback (line ~257):
const modifiedCols = getModifiedColumns(rowData, allColumns, keyColumns, newColumns, removedColumns)
```

**Note:** Row status (`diff_status`) is computed upstream in `runDiff()` and is NOT being changed. This fix only affects cell-level highlighting.

---

### Task 3: Add E2E Regression Tests

**File:** `e2e/tests/audit-undo-regression.spec.ts`

**Add tests to existing serial group:**

```typescript
// Add to existing 'FR-REGRESSION: Audit Capture' serial group

test('calculate_age audit shows new column name and <new column> as previous value', async () => {
  // Setup: Load CSV with date column
  await inspector.runQuery('DROP TABLE IF EXISTS age_test')
  await laundromat.uploadFile(getFixturePath('fr_a3_standardize_date.csv'))
  await wizard.waitForOpen()
  await wizard.import()
  await inspector.waitForTableLoaded('fr_a3_standardize_date', 5)

  // Apply Calculate Age transformation
  await picker.addTransformation('Calculate Age', { column: 'date_col' })
  await laundromat.clickRunRecipe()

  // Verify audit details
  const auditDetails = await inspector.runQuery(`
    SELECT column_name, previous_value, new_value
    FROM _audit_details
    WHERE audit_entry_id = (
      SELECT audit_entry_id FROM _audit_log
      WHERE action = 'Calculate Age'
      ORDER BY timestamp DESC LIMIT 1
    )
    LIMIT 1
  `)

  expect(auditDetails[0].column_name).toBe('age')  // Not the source column
  expect(auditDetails[0].previous_value).toBe('<new column>')
  expect(Number(auditDetails[0].new_value)).toBeGreaterThanOrEqual(0)  // Valid age
})

test('calculate_age diff view shows age column as +NEW, not modified', async () => {
  // This test verifies the diff highlighting after Calculate Age
  // The age column header should show (+NEW) badge
  // Age column cells should NOT be highlighted yellow

  // Implementation depends on whether we can programmatically check
  // the grid cell highlighting. May need visual regression test.
})
```

**Note:** The diff view test may require a visual approach or checking DOM attributes for cell styling.

---

## Files to Modify

| File | Line | Changes |
|------|------|---------|
| `src/lib/commands/audit-capture.ts` | 66-67 | Pass `params` to `captureCalculateAgeDetails()` |
| `src/lib/commands/audit-capture.ts` | 162-206 | Update function signature, use `newColName`, set `previous_value` to `<new column>` |
| `src/lib/diff-engine.ts` | 346-360 | Add `newColumns` and `removedColumns` params to `getModifiedColumns()` |
| `src/components/diff/VirtualizedDiffGrid.tsx` | ~206 | Pass arrays to `getModifiedColumns()` in `getCellContent` |
| `src/components/diff/VirtualizedDiffGrid.tsx` | ~257 | Pass arrays to `getModifiedColumns()` in `drawCell` |
| `e2e/tests/audit-undo-regression.spec.ts` | (end) | Add regression test for audit capture |

---

## Verification Steps

### After Implementation

```bash
# 1. TypeScript build check
npm run build

# 2. Lint check
npm run lint

# 3. Run all audit regression tests
npm test -- --grep "FR-REGRESSION"
```

### Manual Verification

**Audit Log Test:**
1. Load CSV with date column (e.g., `sub_dt` with values like `2025-07-04`)
2. Apply "Calculate Age" transformation on `sub_dt` column
3. Open Audit Sidebar
4. Click on the Calculate Age entry to view details
5. Verify:
   - Column shows `age` (not `sub_dt`)
   - Previous Value shows `<new column>`
   - New Value shows the calculated age (e.g., `1`)

**Diff View Test:**
1. Load CSV with date column
2. Apply "Calculate Age" transformation
3. Click "Compare with Preview" to open diff view
4. Verify:
   - `age` column header shows `(+NEW)` badge
   - `age` column cells are NOT highlighted yellow
   - Only columns that existed in both versions and changed show yellow

---

## Design Rationale

### Why Distinguish "New Column" vs "Modified Column" in Audit?

For transformations that CREATE columns (Calculate Age, Split Column, Combine Columns):
- The column didn't exist before, so there's no "previous value" to show
- Using `<new column>` makes it clear this is an addition, not a modification
- Users can see exactly which columns were created vs modified

### Why Exclude New Columns from Modification Detection?

The diff engine's purpose is to show what CHANGED:
- **Added rows:** Exist in current, not in original → Green
- **Removed rows:** Exist in original, not in current → Red
- **Modified rows:** Exist in both, values differ → Yellow

For columns:
- **New columns:** Exist in current, not in original → Should be green (added)
- **Removed columns:** Exist in original, not in current → Should be red (removed)
- **Modified values:** Column exists in both, values differ → Yellow

Comparing NULL (missing) to a value treats new columns as "modified" which is semantically incorrect.

---

## Similar Patterns to Follow

**Combine Columns** (`captureCombineColumnsDetails`) already uses the correct pattern:
- Uses `newColName` for `column_name`
- Shows source columns in `previous_value`
- Shows combined result in `new_value`

**Split Column** uses a hybrid approach:
- Shows source column as `column_name`
- Shows "Split by ..." summary in `new_value`

For Calculate Age, we should follow the Combine Columns pattern since it also creates a new column.
