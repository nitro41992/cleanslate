# Fix Column Operations and Remove Filter from Column Menu

## Summary

Three issues with the column context menu:
1. **Add Column Position Bug**: New columns appear at the end of the table instead of the intended left/right position
2. **Delete Column Bug**: Clicking delete does nothing (silent failure)
3. **Filter in Column Options**: Need to remove filter UI since filtering is handled separately via FilterBar

---

## Issue 1: Add Column Position Bug

### Root Cause
The `updateColumnOrder` function in `src/lib/commands/utils/column-ordering.ts` (lines 128-130) always appends new columns at the **end** of the `columnOrder` array:

```typescript
// 3. Append new columns at end (excluding internal columns)
const newUserColumns = newColumnNames.filter(name => !isInternalColumn(name))
result.push(...newUserColumns)
```

Even though `add-column.ts` correctly inserts the column at the specified position in DuckDB, the **visual column order** (`columnOrder` in tableStore) always places new columns at the end.

### Solution
Pass the `insertAfter` parameter through the execution result to `updateColumnOrder` and insert new columns at the correct position.

**Files to modify:**

1. **`src/lib/commands/types.ts`** - Add `insertAfter` to ExecutionResult interface:
   ```typescript
   insertAfter?: string | null  // Column to insert new columns after
   ```

2. **`src/lib/commands/schema/add-column.ts`** - Return `insertAfter` in execution result:
   ```typescript
   return {
     success: true,
     // ... existing fields
     insertAfter: this.params.insertAfter,
   }
   ```

3. **`src/lib/commands/utils/column-ordering.ts`** - Modify `updateColumnOrder` to accept and use `insertAfter`:
   ```typescript
   export function updateColumnOrder(
     currentOrder: string[] | undefined,
     newColumnNames: string[],
     droppedColumnNames: string[],
     renameMappings?: Record<string, string>,
     insertAfter?: string | null  // NEW PARAMETER
   ): string[]
   ```
   - If `insertAfter` is null, insert at beginning
   - If `insertAfter` is a column name, insert after that column
   - Otherwise, append at end (existing behavior)

4. **`src/lib/commands/executor.ts`** - Pass `insertAfter` when calling `updateColumnOrder`:
   ```typescript
   const newColumnOrder = updateColumnOrder(
     currentColumnOrder,
     executionResult.newColumnNames || [],
     executionResult.droppedColumnNames || [],
     executionResult.renameMappings,
     executionResult.insertAfter  // NEW ARGUMENT
   )
   ```

---

## Issue 2: Delete Column Bug

### Root Cause Analysis
The delete handler in `DataGrid.tsx:765-789` has multiple potential failure points:

1. **Silent return**: If `!tableId || !tableName`, function returns with no feedback
2. **Undefined result handling**: If `executeWithConfirmation` returns `undefined` (user cancels), no toast is shown
3. **Both props required**: `tableName` is a required prop, so should always be present

Looking at the code flow:
```typescript
const result = await executeWithConfirmation(command, tableId)
if (result?.success) {
  toast({ title: 'Column deleted' })
} else if (result?.error) {
  toast({ title: 'Error', description: result.error })
}
// No handling for undefined result - SILENT FAILURE
```

### Solution
In `DataGrid.tsx`, improve the `handleDeleteColumn` callback:
1. Add handling for undefined result (user cancelled or unexpected failure)
2. Add console logging for debugging

```typescript
const result = await executeWithConfirmation(command, tableId)
if (result?.success) {
  toast({ title: 'Column deleted', description: `Column "${columnName}" has been deleted.` })
} else if (result?.error) {
  toast({ title: 'Error', description: result.error, variant: 'destructive' })
} else if (result === undefined) {
  // User cancelled the operation (e.g., dismissed ConfirmDiscardDialog)
  console.log('[DataGrid] Delete column cancelled by user')
}
```

**Files to modify:**
- `src/components/grid/DataGrid.tsx` - Add handling for cancelled/undefined result

---

## Issue 3: Remove Filter from Column Menu

### What to Remove
The Filter section in `ColumnHeaderMenu.tsx` (lines 229-270). Filtering is handled separately via `FilterBar`.

### Files to modify

1. **`src/components/grid/filters/ColumnHeaderMenu.tsx`**:

   **Imports to remove:**
   - `Filter` from lucide-react (line 2)
   - `FilterFactory` from './FilterFactory' (line 20)
   - `ColumnFilter`, `FilterOperator` from '@/types' (line 21)
   - `getFilterCategory`, `getOperatorsForCategory`, `FilterCategory` from '@/lib/duckdb/filter-builder' (line 22)

   **Props to remove from interface (lines 31, 34-35):**
   - `currentFilter?: ColumnFilter`
   - `onSetFilter: (filter: ColumnFilter) => void`
   - `onRemoveFilter: () => void`

   **Props to remove from destructuring (lines 57, 60-61):**
   - `currentFilter`
   - `onSetFilter`
   - `onRemoveFilter`

   **State and logic to remove:**
   - Filter state variables (lines 77-85)
   - `filterCategory` and `availableOperators` derivations (lines 87-88)
   - `hasActiveFilter` constant (line 90)
   - Filter useEffect (lines 93-104)
   - `handleApplyFilter` function (lines 106-120)
   - `handleClearFilter` function (lines 122-128)

   **JSX to remove (lines 229-270):**
   - Separator before filter section
   - Entire filter `<div>` including FilterFactory, Apply button, Clear button

   **Function to remove (lines 338-351):**
   - `getDefaultOperator` function

2. **`src/components/grid/DataGrid.tsx`** (lines 2168, 2171-2172):
   - Remove `currentFilter={getColumnFilter(columnMenu.column)}`
   - Remove `onSetFilter={handleSetFilter}`
   - Remove `onRemoveFilter={() => handleRemoveFilter(columnMenu.column)}`

---

## Implementation Order (TDD Approach)

### Phase 1: Write Failing Tests

**Note**: glide-data-grid uses canvas rendering and column header clicks don't fire reliably with Playwright. The existing `data-manipulation.spec.ts` has column tests skipped for this reason.

**Approach**: Write tests that verify the **underlying logic** (column ordering functions) and **command execution** (via inspector.runQuery), rather than UI-driven E2E tests that depend on unreliable header clicks.

**Test file**: `e2e/tests/column-schema-operations.spec.ts`

```typescript
test.describe('Column Schema Operations', () => {

  // Test the updateColumnOrder function behavior via command execution
  test('add_column with insertAfter places column at correct position', async () => {
    // Setup: Create table with SQL [id, name, email]
    await inspector.runQuery(`CREATE TABLE test_cols AS SELECT 1 as id, 'a' as name, 'b' as email`)

    // Act: Execute add_column command with insertAfter='name'
    // (bypass UI, call command directly via executor)

    // Assert: columnOrder should be [id, name, newcol, email]
    const columns = await inspector.getTableColumns('test_cols')
    expect(columns.map(c => c.name)).toEqual(['id', 'name', 'newcol', 'email'])
  })

  test('delete_column command removes column and updates columnOrder', async () => {
    // Setup: Create table [id, name, email]
    // Act: Execute delete_column command for 'name'
    // Assert: columns = [id, email], command returns success
  })
})
```

**Unit test file**: `src/lib/commands/utils/__tests__/column-ordering.test.ts` (already exists)

Add tests for `updateColumnOrder` with `insertAfter` parameter:
```typescript
describe('updateColumnOrder with insertAfter', () => {
  it('inserts new column after specified column', () => {
    const result = updateColumnOrder(
      ['a', 'b', 'c'],
      ['newcol'],
      [],
      undefined,
      'b'  // insertAfter
    )
    expect(result).toEqual(['a', 'b', 'newcol', 'c'])
  })

  it('inserts at beginning when insertAfter is null', () => {
    const result = updateColumnOrder(['a', 'b', 'c'], ['newcol'], [], undefined, null)
    expect(result).toEqual(['newcol', 'a', 'b', 'c'])
  })
})
```

### Phase 2: Fix Implementation
1. **Remove Filter UI** - Clean removal, low risk
2. **Fix Add Column Position** - Update `updateColumnOrder` to accept `insertAfter`
3. **Fix Delete Column** - Add undefined result handling

### Phase 3: Verify Tests Pass
```bash
# Unit tests for column ordering
npm test -- column-ordering

# E2E tests for column operations
npx playwright test "column-schema-operations" --timeout=90000 --retries=0
```

---

## Verification

### Manual Testing
1. **Delete Column**:
   - Click column header → "Delete Column" → confirm
   - Column should be removed with success toast
   - If user has undone operations, ConfirmDiscardDialog appears first

2. **Add Column Left**:
   - Click column header → "Insert Left" → enter name
   - New column appears immediately to the LEFT of the clicked column

3. **Add Column Right**:
   - Click column header → "Insert Right" → enter name
   - New column appears immediately to the RIGHT of the clicked column

4. **Filter Removed**:
   - Column context menu shows only Sort and Column sections
   - No Filter section visible
   - FilterBar (separate component) still works

### Test Commands
```bash
# Run existing column-related tests
npx playwright test "column" --timeout=60000 --retries=0 --reporter=line
```
