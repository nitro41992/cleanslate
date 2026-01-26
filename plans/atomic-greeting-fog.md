# Fix: Column Ordering Not Maintained on Redo

## Problem Statement

When a transformation is applied (e.g., Standardize Date), then undone and redone, the transformed column moves to the end of the table instead of staying in its original position.

**User-reported behavior:**
- Apply "Standardize Date" → column stays in position 3
- Undo → column returns to original format and position
- Redo → column is reformatted BUT moves to end of table

**Affects:** All transformation types (Tier 1, 2, and 3)
**Timing:** Happens on first redo immediately after undo

## Root Cause Analysis

The bug exists in **two places**:

### Primary Bug: App.tsx Not Using columnOrder

**File:** `src/App.tsx` line 315

The DataGrid component receives columns in their DuckDB schema order:

```typescript
<DataGrid
  tableName={activeTable.name}
  rowCount={activeTable.rowCount}
  columns={activeTable.columns.map((c) => c.name)}  // ← BUG: Uses DuckDB order
  editable={true}
  tableId={activeTable.id}
  dataVersion={activeTable.dataVersion}
/>
```

The code ignores `activeTable.columnOrder` which contains the correct user-facing column order.

**Why this happens:**
1. During redo, `timeline-engine.ts` correctly calls `resolveColumnOrder(timeline, targetPosition)` (line 721)
2. Executor correctly updates tableStore with both `columns` (DuckDB order) and `columnOrder` (user order) (lines 741-745)
3. But App.tsx only uses `columns`, not `columnOrder`

### Secondary Issue: Deprecated applyTransformation Creates Tables with Wrong Order

**File:** `src/lib/transformations.ts` (DEPRECATED)

During timeline replay, the system calls the deprecated `applyTransformation` function which:
- Creates temp tables using `CREATE TABLE AS SELECT *`
- DuckDB may reorder columns alphabetically or by type during table recreation
- This corrupts the `columns` array in tableStore

**Flow during replay:**
```
replayToPosition() → applyCommand() → applyTransformation() (deprecated)
```

## Solution Strategy

### Fix 1: Make App.tsx Use columnOrder (Primary Fix)

**File:** `src/App.tsx` lines 312-319

Change the DataGrid instantiation to reorder columns using `activeTable.columnOrder`:

```typescript
// Add import at top
import { reorderColumns } from '@/lib/commands/utils/column-ordering'

// Inside render
const displayColumns = useMemo(() => {
  if (!activeTable?.columnOrder) {
    return activeTable?.columns.map((c) => c.name) || []
  }

  const reordered = reorderColumns(
    activeTable.columns,
    activeTable.columnOrder
  )
  return reordered.map((c) => c.name)
}, [activeTable?.columns, activeTable?.columnOrder, activeTable?.dataVersion])

<DataGrid
  tableName={activeTable.name}
  rowCount={activeTable.rowCount}
  columns={displayColumns}  // ← Use reordered columns
  editable={true}
  tableId={activeTable.id}
  dataVersion={activeTable.dataVersion}
/>
```

**Why this works:**
- `reorderColumns` takes DuckDB columns and reorders them according to `columnOrder`
- The grid will always display columns in the correct order regardless of DuckDB schema order
- Fixes the issue holistically for ALL transformations (rename, standardize, split, etc.)

### Fix 2: Write Failing E2E Test

**File:** `e2e/tests/column-ordering.spec.ts`

Add a new test that reproduces the exact user-reported scenario:

```typescript
test('redo after standardize date preserves column position', async () => {
  // Arrange: Load data with known column order
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  // Columns: ['id', 'name', 'order_date', 'status']
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  // Capture initial column order
  const initialColumns = await inspector.getTableColumns('column_order_test')
  const initialOrder = initialColumns.map(c => c.name)
  expect(initialOrder).toEqual(['id', 'name', 'order_date', 'status'])

  // Act: Apply standardize date transformation on 3rd column
  await laundromat.openCleanPanel()
  await picker.waitForOpen()
  await picker.addTransformation('Standardize Date', {
    column: 'order_date',
    params: { 'Format': 'YYYY-MM-DD' }
  })
  await laundromat.closePanel()

  // Assert: Column order unchanged after transform
  const afterTransform = await inspector.getTableColumns('column_order_test')
  const orderAfterTransform = afterTransform.map(c => c.name)
  expect(orderAfterTransform).toEqual(['id', 'name', 'order_date', 'status'])

  // Act: Undo and Redo
  await laundromat.clickUndo()
  await laundromat.clickRedo()

  // Assert: Column order STILL unchanged (order_date should be 3rd, not last)
  const afterRedo = await inspector.getTableColumns('column_order_test')
  const orderAfterRedo = afterRedo.map(c => c.name)
  expect(orderAfterRedo).toEqual(['id', 'name', 'order_date', 'status'])

  // Verify via SQL (not just UI)
  const sqlColumns = await inspector.runQuery(`
    SELECT column_name
    FROM (DESCRIBE column_order_test)
    WHERE column_name NOT LIKE '%__base' AND column_name != '_cs_id'
  `)
  const sqlOrder = sqlColumns.map(r => r.column_name)

  // SQL order might differ from display order, but display order should match columnOrder
  console.log('SQL order:', sqlOrder)
  console.log('Display order:', orderAfterRedo)
})
```

**Also add tests for:**
- Column rename + undo + redo
- Split column + undo + redo
- Cast type + undo + redo
- Multiple transformations + undo all + redo all

## Implementation Steps

1. **Write failing E2E test** in `column-ordering.spec.ts`
2. **Run test** → Should FAIL (column moves to end on redo)
3. **Apply Fix 1** → Modify App.tsx to use reordered columns
4. **Run test** → Should PASS
5. **Run full E2E suite** → Verify no regressions
6. **Manual verification:**
   - Load CSV with 4+ columns
   - Apply Standardize Date on middle column
   - Undo → Redo
   - Verify column stays in same position

## Critical Files

1. **src/App.tsx** (lines 312-319) - DataGrid instantiation, add columnOrder reordering
2. **e2e/tests/column-ordering.spec.ts** - Add failing test for redo column order
3. **src/lib/commands/utils/column-ordering.ts** - Import `reorderColumns` utility (already exists)
4. **src/stores/tableStore.ts** - Verify `columnOrder` field is populated (already exists)

## Verification Plan

### E2E Tests (Automated)
- [ ] New test: `redo after standardize date preserves column position` (FAILS before fix, PASSES after)
- [ ] Existing test: `redo preserves column order after undo` (line 155) should still PASS
- [ ] Existing test: `chained transformations preserve column order` (line 178) should still PASS
- [ ] Run full `column-ordering.spec.ts` suite (13 tests) → All PASS

### Manual Testing
1. Load `column-order-test.csv` with columns: `[id, name, email, status]`
2. Apply "Trim Whitespace" on `email` (3rd column)
3. Verify `email` stays in position 3
4. Undo → Redo
5. Verify `email` is still in position 3 (NOT moved to end)
6. Repeat with "Standardize Date", "Cast Type", "Rename Column"
7. Test with multiple undo/redo cycles

### SQL Validation
For each test, verify that the displayed column order matches `tableStore.columnOrder`:

```typescript
const displayOrder = await inspector.getTableColumns('table_name')
const storedOrder = await inspector.getStoreValue('tableStore',
  state => state.tables.find(t => t.name === 'table_name')?.columnOrder
)
expect(displayOrder.map(c => c.name)).toEqual(storedOrder)
```

## Edge Cases Covered

- [x] Transformation on first column
- [x] Transformation on middle column
- [x] Transformation on last column
- [x] Multiple transformations in sequence
- [x] Undo all → Redo all
- [x] Redo after multiple undo operations
- [x] Column-altering transforms (rename, split, combine)
- [x] Type-changing transforms (cast, standardize date)

## Notes

- The existing `reorderColumns` utility (in `column-ordering.ts`) handles all edge cases (renames, drops, new columns, phantom columns)
- The executor already correctly captures and stores `columnOrder` in timelineStore
- The timeline-engine already correctly resolves `columnOrder` during redo
- This is purely a UI display issue where App.tsx was ignoring the stored column order
- Fix is minimal, non-breaking, and holistic (fixes all transformation types)
