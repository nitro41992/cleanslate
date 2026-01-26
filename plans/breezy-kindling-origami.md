# Column Order Preservation Plan (TDD Approach)

## Problem Statement

After transformations complete, the affected column moves to the last position in the grid, causing UX confusion. This happens because DuckDB's `ordinal_position` metadata gets reassigned during CREATE TABLE AS SELECT (CTAS) operations, and we fetch columns using `ORDER BY ordinal_position`.

**Key insight**: The problem is in how we fetch and store column metadata after transformations, not in the transformations themselves.

## Root Causes (Detailed Analysis)

### 1. DuckDB CTAS Column Reordering
- All transformations use CTAS to recreate tables (Tier 1, 2, and 3 commands)
- DuckDB reassigns `ordinal_position` metadata based on the SELECT list order in the CTAS statement
- After transformation, `refreshTableContext()` fetches columns using `ORDER BY ordinal_position`, getting the NEW (shuffled) order
- Grid displays columns in this new order from tableStore

**Affected Files**:
- `src/lib/commands/column-versions.ts` (lines 213, 277, 409, 566)
- `src/lib/duckdb/index.ts` (lines 315, 348, 380, 520, 777)

### 2. Batching + Backup Column Destruction
Commit `5d945c0` ("fix(commands): create snapshots for batched Tier 1 operations to enable undo/redo") introduced a critical bug:
- Batched operations (for tables >500k rows) use `SELECT * EXCLUDE` pattern
- This destroys `__base` backup columns (used by expression chaining for undo)
- Without snapshots, undo fails with "Referenced update column undefined not found"
- The fix moved batching decision BEFORE snapshot creation, but race condition remains

**Affected Files**:
- `src/lib/commands/executor.ts` (lines 222, 583)
- `src/lib/commands/batch-executor.ts` (entire file)

### 3. Race Condition in Execution Pipeline
The executor's current flow creates a race condition:
```
1. Command executes → table recreated in DuckDB
2. refreshTableContext() → fetches columns (potentially reordered)
3. updateTableStore() → calculates new columnOrder
⚠️ RACE: context refresh might use stale columnOrder from store
```

### 4. Recent Commits & Branch History

| Commit | Issue Introduced |
|--------|-------------------|
| `5d945c0` | Batched Tier 1 ops destroy __base columns; snapshots added but race condition remains |
| `a70f345` | Batching infrastructure wired to commands (UppercaseCommand, StandardizeDateCommand) |
| `664946a` | Initial batching infrastructure (batch-executor.ts) |
| `b13be85` | "fix(diff): resolve ordering, scroll, and type detection issues" - didn't address root cause |

## Architectural Principles

This plan addresses six critical architectural concerns:

1. **Logic Ownership**: Shift "Source of Truth" for column order from DuckDB's engine to application metadata. UX stability is an application concern, not a database concern.

2. **Race Condition Prevention**: Executor must calculate the new columnOrder BEFORE calling refreshTableContext(). The context refresh receives the new order as an explicit override, preventing timing issues.

3. **Defense-in-Depth**: While the app-level fix is necessary and sufficient, we also optimize Tier 1 commands to use explicit SELECT lists (OPTIONAL). This prevents the shuffle at the database level.

4. **Phantom Column Safety**: The reordering utility must handle unexpected columns gracefully. If DuckDB returns columns not in columnOrder, append them at the end rather than hiding them (data loss prevention).

5. **Combiner Scope**: Stack and Join operations create entirely new schemas, not transformations of existing tables. They must initialize fresh columnOrder immediately based on operation semantics.

6. **Internal Column Guard**: Strict separation between user-facing columns and internal tracking columns (_cs_id, __base). The grid needs _cs_id for row identity, but it's never subject to user-defined ordering.

## Solution Strategy

**Application-Managed Column Order**: Shift "Source of Truth" from DuckDB's engine to application's TableInfo metadata. Store canonical column order and enforce it throughout the transformation pipeline.

### Why This Approach?
- **Logic Ownership**: Application controls UX stability, not DuckDB's internal ordering
- **Centralized**: Executor calculates new order BEFORE context refresh, preventing race conditions
- **Minimal State**: Only tracks user-visible column names (excludes `_cs_id`, `__base`)
- **Backward Compatible**: Optional field, graceful handling of legacy tables
- **Defense-in-Depth**: Combines app-level reordering with SQL-level optimizations (Tier 1 explicit SELECTs)

## Execution Flow (Race Condition Prevention)

**Current Flow (BROKEN)**:
```
1. Command executes → table recreated in DuckDB
2. refreshTableContext() → fetches columns (potentially reordered)
3. updateTableStore() → calculates new columnOrder
   ⚠️ RACE: context refresh might use stale columnOrder from store
```

**New Flow (FIXED)**:
```
1. Command executes → table recreated in DuckDB
2. Executor extracts metadata: newColumnNames, droppedColumnNames, renameMappings
3. Executor calculates new columnOrder IMMEDIATELY
   newOrder = updateColumnOrder(currentOrder, newColumnNames, droppedColumnNames, renameMappings)
4. refreshTableContext(ctx, renameMappings, newOrder) → uses override
5. updateTableStore(tableId, result, newOrder) → stores pre-calculated order
   ✅ NO RACE: both use the same pre-calculated order
```

**Critical Insight**: The executor is the single source of truth for the new columnOrder. It calculates once and distributes to both context refresh and store update.

## Edge Cases Handled

| Scenario | Current Issue | Solution |
|----------|---------------|----------|
| First load | No columnOrder | `reorderColumns()` returns fetched as-is; initialized on first transform |
| Rename column | Column moves | `renameMappings` applied; column stays in same position |
| Split column | New columns position | New columns appended at end; original removed |
| Remove duplicates | Order shuffle | columnOrder preserved (no schema changes) |
| Undo/Redo | Order lost | tableStore maintains columnOrder through timeline |
| Internal columns (_cs_id, __base) | **Contamination risk** | Strictly excluded from `columnOrder`; grid uses `_cs_id` for row identity only |
| Batch transforms | **ORDER BY ordinal_position issue** | Pre-calculated order prevents flicker with race condition fix |
| Phantom columns | Data loss risk | Safety valve: append unexpected columns at end |
| Combiner (Stack/Join) | No order initialization | Fresh `columnOrder` based on union/left+right semantics |

---

## Implementation Plan (TDD Workflow)

### Phase 1: Write Failing E2E Tests (RED)

**Goal**: Create comprehensive E2E tests that demonstrate the column ordering bug before any fixes are implemented.

**File**: `e2e/tests/column-ordering.spec.ts` (NEW)

#### Test Suite Structure

```typescript
import { test, expect, type Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Column Order Preservation', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    inspector = createStoreInspector(page)

    await laundromat.goto()
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await page.close()
  })

  // Tests go here...
})
```

#### Critical Tests to Write

**Test 1: Tier 1 Transform (Trim) Preserves Column Order**
```typescript
test('Tier 1 (trim) preserves original column order', async () => {
  // Arrange: Load CSV with known column order
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  // Get initial column order from grid
  const initialColumns = await inspector.getTableColumns('column_order_test')
  expect(initialColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status'])

  // Act: Apply trim transformation to 'email' (column index 2)
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Trim')
  await picker.apply()

  // Assert: Column order should remain unchanged
  const finalColumns = await inspector.getTableColumns('column_order_test')
  expect(finalColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status'])
  // This test will FAIL before fix - email will move to last position
})
```

**Test 2: Tier 2 Transform (Rename) Preserves Position**
```typescript
test('Tier 2 (rename_column) keeps renamed column in same position', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  const initialOrder = ['id', 'name', 'email', 'status']

  // Act: Rename 'email' (position 2) to 'email_address'
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Rename Column')
  await picker.setInputValue('newName', 'email_address')
  await picker.apply()

  // Assert: Column stays in position 2 with new name
  const finalColumns = await inspector.getTableColumns('column_order_test')
  expect(finalColumns.map(c => c.name)).toEqual(['id', 'name', 'email_address', 'status'])
  // This test will FAIL before fix - email_address will move to end
})
```

**Test 3: Tier 3 Transform (Remove Duplicates) Preserves Order**
```typescript
test('Tier 3 (remove_duplicates) preserves column order', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('with_duplicates', 6)

  const initialColumns = await inspector.getTableColumns('with_duplicates')
  const initialOrder = initialColumns.map(c => c.name)

  // Act: Remove duplicates (Tier 3 - uses snapshot)
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Remove Duplicates')
  await picker.apply()

  // Assert: Column order unchanged (only rows affected)
  const finalColumns = await inspector.getTableColumns('with_duplicates')
  expect(finalColumns.map(c => c.name)).toEqual(initialOrder)
  // This test will FAIL before fix if CTAS reorders columns
})
```

**Test 4: Split Column Appends New Columns at End**
```typescript
test('split_column appends new columns at end, removes original', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('split-column-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('split_column_test', 3)

  // Initial: ['id', 'full_name', 'email']

  // Act: Split 'full_name' by space
  await laundromat.selectColumn('full_name')
  await picker.selectTransformation('Split Column')
  await picker.setInputValue('delimiter', ' ')
  await picker.apply()

  // Assert: New columns at end, original removed
  const finalColumns = await inspector.getTableColumns('split_column_test')
  expect(finalColumns.map(c => c.name)).toEqual(['id', 'email', 'full_name_1', 'full_name_2'])
  // This test will FAIL if new columns appear in unexpected positions
})
```

**Test 5: Undo Restores Original Column Order**
```typescript
test('undo restores original column order', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  const originalOrder = ['id', 'name', 'email', 'status']

  // Act: Transform + Undo
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Uppercase')
  await picker.apply()

  // Verify order is broken after transform
  const afterTransform = await inspector.getTableColumns('column_order_test')
  // (This will show the bug - email moved to end)

  await laundromat.clickUndo()

  // Assert: Order restored to original
  const afterUndo = await inspector.getTableColumns('column_order_test')
  expect(afterUndo.map(c => c.name)).toEqual(originalOrder)
  // This test will FAIL if columnOrder not preserved in timeline
})
```

**Test 6: Redo Preserves Column Order**
```typescript
test('redo preserves column order after undo', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  // Act: Transform → Undo → Redo
  await laundromat.selectColumn('name')
  await picker.selectTransformation('Trim')
  await picker.apply()

  const afterTransform = await inspector.getTableColumns('column_order_test')
  const orderAfterTransform = afterTransform.map(c => c.name)

  await laundromat.clickUndo()
  await laundromat.clickRedo()

  // Assert: Redo restores the SAME order as after transform (not shuffled again)
  const afterRedo = await inspector.getTableColumns('column_order_test')
  expect(afterRedo.map(c => c.name)).toEqual(orderAfterTransform)
  // This test will FAIL if redo doesn't preserve columnOrder
})
```

**Test 7: Chained Transformations Preserve Order**
```typescript
test('chained transformations preserve column order', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  const originalOrder = ['id', 'name', 'email', 'status']

  // Act: Apply 3 transformations in sequence
  // 1. Trim email
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Trim')
  await picker.apply()

  // 2. Lowercase name
  await laundromat.selectColumn('name')
  await picker.selectTransformation('Lowercase')
  await picker.apply()

  // 3. Uppercase status
  await laundromat.selectColumn('status')
  await picker.selectTransformation('Uppercase')
  await picker.apply()

  // Assert: Original column order maintained
  const finalColumns = await inspector.getTableColumns('column_order_test')
  expect(finalColumns.map(c => c.name)).toEqual(originalOrder)
  // This test will FAIL - columns will be shuffled after each transform
})
```

**Test 8: Combiner Stack Preserves Union Column Order**
```typescript
test('combiner stack preserves union column order', async () => {
  // Arrange: Load two tables with different column orders
  await laundromat.uploadFile(getFixturePath('stack-table-1.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('stack_table_1', 3)

  await laundromat.uploadFile(getFixturePath('stack-table-2.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('stack_table_2', 3)

  // Act: Stack tables (UNION ALL)
  await laundromat.openCombinerPanel()
  await laundromat.selectCombineType('stack')
  await laundromat.selectTables(['stack_table_1', 'stack_table_2'])
  await laundromat.executeCombine()

  // Assert: Column order = union of source columns (first appearance)
  // Table 1: ['id', 'name', 'email']
  // Table 2: ['id', 'email', 'status']
  // Expected: ['id', 'name', 'email', 'status']
  const stackedColumns = await inspector.getTableColumns('stacked_result')
  expect(stackedColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status'])
  // This test will FAIL if columnOrder not initialized for combiner results
})
```

**Test 9: Combiner Join Preserves Left + Right Order**
```typescript
test('combiner join preserves left + right column order', async () => {
  // Arrange: Load two tables
  await laundromat.uploadFile(getFixturePath('join-left.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('join_left', 3)

  await laundromat.uploadFile(getFixturePath('join-right.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('join_right', 3)

  // Act: Join on 'id'
  await laundromat.openCombinerPanel()
  await laundromat.selectCombineType('join')
  await laundromat.selectLeftTable('join_left')
  await laundromat.selectRightTable('join_right')
  await laundromat.selectJoinKey('id')
  await laundromat.executeCombine()

  // Assert: Left columns + Right columns (excluding duplicate join key)
  // Left: ['id', 'name', 'email']
  // Right: ['id', 'status', 'role']
  // Expected: ['id', 'name', 'email', 'status', 'role']
  const joinedColumns = await inspector.getTableColumns('joined_result')
  expect(joinedColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status', 'role'])
  // This test will FAIL if join doesn't initialize columnOrder correctly
})
```

**Test 10: Transform After Stack/Join Preserves Combined Order**
```typescript
test('transform after combiner operation preserves combined table order', async () => {
  // Arrange: Stack two tables
  await laundromat.uploadFile(getFixturePath('stack-table-1.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('stack_table_1', 3)

  await laundromat.uploadFile(getFixturePath('stack-table-2.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('stack_table_2', 3)

  await laundromat.openCombinerPanel()
  await laundromat.selectCombineType('stack')
  await laundromat.selectTables(['stack_table_1', 'stack_table_2'])
  await laundromat.executeCombine()

  const orderAfterStack = await inspector.getTableColumns('stacked_result')
  const expectedOrder = orderAfterStack.map(c => c.name)

  // Act: Apply transformation to stacked table
  await laundromat.selectTable('stacked_result')
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Trim')
  await picker.apply()

  // Assert: Combined table's column order preserved
  const finalColumns = await inspector.getTableColumns('stacked_result')
  expect(finalColumns.map(c => c.name)).toEqual(expectedOrder)
  // This test will FAIL if transform on combined table doesn't preserve order
})
```

**Test 11: Internal Columns Excluded from User-Facing Order**
```typescript
test('internal columns (_cs_id, __base) excluded from columnOrder', async () => {
  // Arrange
  await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('column_order_test', 4)

  // Act: Apply Tier 1 transformation (creates __base column)
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Trim')
  await picker.apply()

  // Assert: Fetch tableStore columnOrder - should NOT contain internal columns
  const tableInfo = await inspector.getTableInfo('column_order_test')
  expect(tableInfo.columnOrder).toBeDefined()
  expect(tableInfo.columnOrder).not.toContain('_cs_id')
  expect(tableInfo.columnOrder?.every(name => !name.endsWith('__base'))).toBe(true)

  // But grid should still have _cs_id for row identity
  const allColumns = await inspector.getTableColumns('column_order_test')
  expect(allColumns.some(c => c.name === '_cs_id')).toBe(true)
  // This test will FAIL if internal columns leak into columnOrder
})
```

**Test 12: Batched Transformations Preserve Order**
```typescript
test('batched transformations (>500k rows) preserve column order', async () => {
  // Arrange: Load large CSV that triggers batching
  await laundromat.uploadFile(getFixturePath('large-data-600k.csv'))
  await wizard.import()
  await inspector.waitForTableLoaded('large_data_600k', 600000)

  const initialColumns = await inspector.getTableColumns('large_data_600k')
  const initialOrder = initialColumns.map(c => c.name)

  // Act: Apply transformation (will trigger batch execution)
  await laundromat.selectColumn('email')
  await picker.selectTransformation('Uppercase')
  await picker.apply()

  // Wait for batching to complete
  await inspector.waitForLoading(false)

  // Assert: Column order preserved despite batching
  const finalColumns = await inspector.getTableColumns('large_data_600k')
  expect(finalColumns.map(c => c.name)).toEqual(initialOrder)
  // This test will FAIL if batching doesn't preserve columnOrder
})
```

#### Test Fixtures Required

Create new CSV fixtures in `e2e/fixtures/csv/`:

1. **column-order-test.csv**
```csv
id,name,email,status
1,John Doe,john@example.com,active
2,Jane Smith,jane@example.com,inactive
3,Bob Johnson,bob@example.com,active
4,Alice Brown,alice@example.com,pending
```

2. **split-column-test.csv**
```csv
id,full_name,email
1,John Doe,john@example.com
2,Jane Smith,jane@example.com
3,Bob Johnson,bob@example.com
```

3. **stack-table-1.csv**
```csv
id,name,email
1,John,john@example.com
2,Jane,jane@example.com
```

4. **stack-table-2.csv**
```csv
id,email,status
3,bob@example.com,active
4,alice@example.com,pending
```

5. **join-left.csv**
```csv
id,name,email
1,John,john@example.com
2,Jane,jane@example.com
```

6. **join-right.csv**
```csv
id,status,role
1,active,admin
2,inactive,user
```

#### Expected Test Results Before Fix

All 12 tests should **FAIL** with column ordering issues:
- Tests 1-3: Transformed column moves to last position
- Test 4: New columns appear in unexpected positions
- Tests 5-6: Undo/redo loses original order
- Test 7: Each chained transform shuffles columns
- Tests 8-10: Combiner operations don't initialize columnOrder
- Test 11: Internal columns leak into columnOrder
- Test 12: Batched operations lose column order

---

### Phase 2: Write Failing Unit Tests (RED)

**Goal**: Create unit tests for the column ordering utilities before implementing them.

**File**: `src/lib/commands/utils/__tests__/column-ordering.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest'
import { reorderColumns, updateColumnOrder } from '../column-ordering'
import type { ColumnInfo } from '@/types'

describe('column-ordering utilities', () => {
  describe('reorderColumns', () => {
    it('preserves original column order', () => {
      const fetched: ColumnInfo[] = [
        { name: 'status', type: 'VARCHAR' },
        { name: 'id', type: 'INTEGER' },
        { name: 'email', type: 'VARCHAR' },
        { name: 'name', type: 'VARCHAR' }
      ]
      const originalOrder = ['id', 'name', 'email', 'status']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(originalOrder)
    })

    it('appends new columns at end', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER' },
        { name: 'email', type: 'VARCHAR' },
        { name: 'new_column', type: 'VARCHAR' }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(['id', 'email', 'new_column'])
    })

    it('filters out dropped columns', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER' },
        { name: 'email', type: 'VARCHAR' }
      ]
      const originalOrder = ['id', 'name', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(['id', 'email'])
    })

    it('applies rename mappings to original order', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER' },
        { name: 'email_address', type: 'VARCHAR' },
        { name: 'status', type: 'VARCHAR' }
      ]
      const originalOrder = ['id', 'email', 'status']
      const renameMappings = { 'email': 'email_address' }

      const result = reorderColumns(fetched, originalOrder, renameMappings)

      expect(result.map(c => c.name)).toEqual(['id', 'email_address', 'status'])
    })

    it('excludes internal columns (_cs_id, __base)', () => {
      const fetched: ColumnInfo[] = [
        { name: '_cs_id', type: 'VARCHAR' },
        { name: 'id', type: 'INTEGER' },
        { name: 'email', type: 'VARCHAR' },
        { name: 'email__base', type: 'VARCHAR' }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(['id', 'email'])
      expect(result.some(c => c.name === '_cs_id')).toBe(false)
      expect(result.some(c => c.name.endsWith('__base'))).toBe(false)
    })

    it('handles phantom columns by appending at end', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER' },
        { name: 'phantom', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      // Phantom column not in originalOrder or newColumns → append at end
      expect(result.map(c => c.name)).toEqual(['id', 'email', 'phantom'])
    })

    it('returns fetched order when originalOrder is undefined', () => {
      const fetched: ColumnInfo[] = [
        { name: 'status', type: 'VARCHAR' },
        { name: 'id', type: 'INTEGER' }
      ]

      const result = reorderColumns(fetched, undefined)

      expect(result.map(c => c.name)).toEqual(['status', 'id'])
    })
  })

  describe('updateColumnOrder', () => {
    it('applies rename to current order', () => {
      const currentOrder = ['id', 'email', 'status']
      const renameMappings = { 'email': 'email_address' }

      const result = updateColumnOrder(currentOrder, [], [], renameMappings)

      expect(result).toEqual(['id', 'email_address', 'status'])
    })

    it('removes dropped columns from order', () => {
      const currentOrder = ['id', 'name', 'email', 'status']
      const droppedColumnNames = ['name']

      const result = updateColumnOrder(currentOrder, [], droppedColumnNames)

      expect(result).toEqual(['id', 'email', 'status'])
    })

    it('appends new user columns at end', () => {
      const currentOrder = ['id', 'email']
      const newColumnNames = ['status', 'role']

      const result = updateColumnOrder(currentOrder, newColumnNames, [])

      expect(result).toEqual(['id', 'email', 'status', 'role'])
    })

    it('filters internal columns from new columns', () => {
      const currentOrder = ['id', 'email']
      const newColumnNames = ['status', '_cs_id', 'email__base']

      const result = updateColumnOrder(currentOrder, newColumnNames, [])

      expect(result).toEqual(['id', 'email', 'status'])
    })

    it('handles all operations (rename + add + drop)', () => {
      const currentOrder = ['id', 'name', 'email', 'status']
      const newColumnNames = ['name_1', 'name_2']
      const droppedColumnNames = ['name']
      const renameMappings = { 'email': 'email_address' }

      const result = updateColumnOrder(
        currentOrder,
        newColumnNames,
        droppedColumnNames,
        renameMappings
      )

      expect(result).toEqual(['id', 'email_address', 'status', 'name_1', 'name_2'])
    })
  })
})
```

#### Expected Test Results Before Implementation

All unit tests should **FAIL** because `column-ordering.ts` doesn't exist yet.

---

### Phase 3: Core Infrastructure Implementation (GREEN)

**Goal**: Implement the core column ordering utilities to pass unit tests.

#### Step 3.1: Add Column Order Field to TableInfo

**File**: `src/types/index.ts`

Add optional field:
```typescript
export interface TableInfo {
  // ... existing fields
  columnOrder?: string[]  // User-visible column names only (excludes _cs_id, __base)
}
```

#### Step 3.2: Create Column Ordering Utilities

**File**: `src/lib/commands/utils/column-ordering.ts` (NEW)

Implement `reorderColumns()` and `updateColumnOrder()` functions with:
- Internal column filtering (`_cs_id`, `__base`)
- Phantom column safety valve
- Rename mapping application
- Pure functions (easily testable)

#### Step 3.3: Add ExecutionResult Fields

**File**: `src/lib/commands/types.ts`

```typescript
export interface ExecutionResult {
  // ... existing fields
  newColumnNames?: string[]
  droppedColumnNames?: string[]
  renameMappings?: Record<string, string>
}
```

**Verify**: All unit tests in `column-ordering.test.ts` now pass.

---

### Phase 4: Execution Pipeline Integration (GREEN)

**Goal**: Fix race conditions in executor and integrate column ordering utilities.

#### Step 4.1: Update Context Refresh

**File**: `src/lib/commands/context.ts`

- Add `columnOrderOverride?: string[]` parameter to `refreshTableContext()`
- Call `reorderColumns()` with override if provided
- Return context with reordered columns

#### Step 4.2: Fix Executor Race Condition

**File**: `src/lib/commands/executor.ts`

**CRITICAL**: Calculate new column order BEFORE refreshing context.

New execution flow:
```typescript
// 1. Command executes
const result = await command.execute(ctx)

// 2. Extract metadata
const { newColumnNames, droppedColumnNames, renameMappings } = result

// 3. Get current columnOrder from store
const currentOrder = tableStore.getTableInfo(tableId)?.columnOrder

// 4. Calculate new order IMMEDIATELY
const newOrder = updateColumnOrder(
  currentOrder,
  newColumnNames,
  droppedColumnNames,
  renameMappings
)

// 5. Refresh context with override
const freshCtx = await refreshTableContext(ctx, renameMappings, newOrder)

// 6. Update store with pre-calculated order
await updateTableStore(tableId, result, newOrder)
```

#### Step 4.3: Initialize Column Order on Table Load

**File**: `src/stores/tableStore.ts`

In `addTable` action:
```typescript
const columnOrder = columns
  .filter(c => !isInternalColumn(c.name))
  .map(c => c.name)
```

**Verify**: E2E tests 1-3 (Tier 1-3 transforms) now pass.

---

### Phase 5: Command Updates (GREEN)

**Goal**: Update commands to return execution metadata.

#### Step 5.1: Update RenameColumnCommand

**File**: `src/lib/commands/transform/tier2/rename-column.ts`

```typescript
return {
  // ... existing fields
  newColumnNames: [this.params.newName],
  droppedColumnNames: [this.params.column],
  renameMappings: { [this.params.column]: this.params.newName }
}
```

#### Step 5.2: Update SplitColumnCommand

**File**: `src/lib/commands/transform/tier2/split-column.ts`

```typescript
return {
  // ... existing fields
  newColumnNames: ['column_1', 'column_2'],  // Derived from split result
  droppedColumnNames: [this.params.column]
}
```

**Verify**: E2E tests 2, 4 (rename, split) now pass.

---

### Phase 6: Timeline & Snapshot Integration (GREEN)

**Goal**: Preserve column order through undo/redo and snapshot restoration.

#### Step 6.1: Preserve Order in Checkpoints

**File**: `src/stores/tableStore.ts`

In `checkpointTable`:
```typescript
const sourceTable = state.tables.find((t) => t.id === sourceId)
const columnOrder = sourceTable?.columnOrder

// Set columnOrder in newTable
```

#### Step 6.2: Handle Snapshot Restoration

**File**: `src/lib/timeline-engine.ts` (or executor undo logic)

After restoring snapshot:
```typescript
const originalOrder = tableStore.getTableInfo(tableId)?.columnOrder
const fetchedColumns = await duckDB.getColumns(tableName)
const reorderedColumns = reorderColumns(fetchedColumns, originalOrder)
await updateTableStore(tableId, { columns: reorderedColumns }, originalOrder)
```

**Verify**: E2E tests 5-6 (undo, redo) now pass.

---

### Phase 7: Combiner Integration (GREEN)

**Goal**: Initialize columnOrder for stack/join results.

#### Step 7.1: Stack Operation

**File**: `src/lib/commands/combine/stack-tables.ts`

After UNION ALL:
```typescript
// Compute union of source table columns (first appearance)
const columnOrder = computeUnionColumnOrder(sourceTables)
return {
  // ... existing fields
  newColumnNames: columnOrder,
  droppedColumnNames: []
}
```

#### Step 7.2: Join Operation

**File**: `src/lib/commands/combine/join-tables.ts`

After JOIN:
```typescript
// Left columns + Right columns (exclude duplicate join key)
const columnOrder = [
  ...leftTable.columnOrder,
  ...rightTable.columnOrder.filter(c => c !== joinKey)
]
return {
  // ... existing fields
  newColumnNames: columnOrder,
  droppedColumnNames: []
}
```

**Verify**: E2E tests 8-10 (combiner) now pass.

---

### Phase 8: Batching Integration (GREEN)

**Goal**: Ensure column order preserved during batched transformations.

#### Step 8.1: Update Batch Executor

**File**: `src/lib/commands/batch-executor.ts`

- Pass `columnOrder` through batching pipeline
- Ensure LIMIT/OFFSET batches maintain column order

#### Step 8.2: Verify Batching Preserves Order

**File**: `src/lib/commands/executor.ts` (lines 222, 583)

Ensure batching fallback uses same column ordering logic.

**Verify**: E2E test 12 (batched transformations) now passes.

---

### Phase 9: SQL Optimization (OPTIONAL - REFACTOR)

**Goal**: Optimize Tier 1 commands to use explicit SELECT lists (prevents shuffle at DB level).

**Files**: `src/lib/commands/transform/tier1/*.ts`

Refactor SELECT * EXCLUDE to explicit SELECT lists:
```typescript
// BEFORE
SELECT * EXCLUDE ("${col}"), TRIM("${col}") as "${col}"
FROM "${tableName}"

// AFTER
SELECT ${orderedColumns.map(c =>
  c === targetCol
    ? `TRIM(${quoteColumn(c)}) as ${quoteColumn(c)}`
    : quoteColumn(c)
).join(', ')}
FROM ${quoteTable(tableName)}
```

**Priority**: LOW - App-level reordering already fixes the UX issue.

**Verify**: E2E tests still pass, performance improved.

---

## Critical Files

### Phase 1-2 (Tests)
- `e2e/tests/column-ordering.spec.ts` (NEW) - 12 E2E tests
- `e2e/fixtures/csv/*.csv` (NEW) - 6 test fixtures
- `src/lib/commands/utils/__tests__/column-ordering.test.ts` (NEW) - Unit tests

### Phase 3 (Infrastructure)
- `src/types/index.ts` - Add `columnOrder` to TableInfo
- `src/lib/commands/utils/column-ordering.ts` (NEW) - Core utilities
- `src/lib/commands/types.ts` - Add ExecutionResult fields

### Phase 4 (Executor)
- `src/lib/commands/executor.ts` - Fix race condition
- `src/lib/commands/context.ts` - Accept columnOrderOverride
- `src/stores/tableStore.ts` - Initialize columnOrder

### Phase 5 (Commands)
- `src/lib/commands/transform/tier2/rename-column.ts`
- `src/lib/commands/transform/tier2/split-column.ts`

### Phase 6 (Timeline)
- `src/stores/tableStore.ts` - Preserve in checkpoints
- `src/lib/timeline-engine.ts` - Snapshot restoration

### Phase 7 (Combiner)
- `src/lib/commands/combine/stack-tables.ts`
- `src/lib/commands/combine/join-tables.ts`

### Phase 8 (Batching)
- `src/lib/commands/batch-executor.ts`

### Phase 9 (Optional)
- `src/lib/commands/transform/tier1/*.ts` (6 files)

---

## Verification Strategy

### Phase 1-2: Test Creation
- [ ] All 12 E2E tests fail with expected column ordering bugs
- [ ] All unit tests fail (utilities don't exist yet)

### Phase 3: Infrastructure
- [ ] All unit tests pass
- [ ] No E2E tests pass yet (integration not complete)

### Phase 4: Executor Integration
- [ ] E2E tests 1-3 (Tier 1-3 transforms) pass
- [ ] Unit tests still pass

### Phase 5: Command Updates
- [ ] E2E tests 2, 4 (rename, split) pass
- [ ] All previous tests still pass

### Phase 6: Timeline Integration
- [ ] E2E tests 5-6 (undo, redo) pass
- [ ] Test 7 (chained transforms) passes

### Phase 7: Combiner Integration
- [ ] E2E tests 8-10 (combiner) pass

### Phase 8: Batching Integration
- [ ] E2E test 12 (batching) passes
- [ ] Test 11 (internal columns) passes

### Phase 9: SQL Optimization
- [ ] All tests still pass
- [ ] Performance improved (< 1ms overhead)

### Final Verification
- [ ] All 12 E2E tests pass
- [ ] All unit tests pass
- [ ] No console errors or warnings
- [ ] Zero performance regression
- [ ] Backward compatible with existing tables

---

## Manual Testing Procedures

After all automated tests pass, perform these manual verifications:

1. **Basic Transform Flow**
   - Load CSV with columns: ID, Name, Email, Status
   - Apply trim to "Email" → verify column stays in position 3
   - Verify data is correctly transformed

2. **Rename Stability**
   - Rename "Email" to "EmailAddress" → verify stays in position 3
   - Check grid displays new name in original position

3. **Split Column Behavior**
   - Split "Name" by space → verify Name_1, Name_2 appear at end
   - Verify original "Name" column is removed

4. **Undo/Redo Timeline**
   - Undo all → verify original order restored
   - Redo → verify order preserved through redo

5. **Combiner Operations**
   - Stack two tables with different column orders
   - Verify resulting table has union of columns in correct order
   - Apply transform to stacked table → verify order preserved

6. **Batched Operations**
   - Load large CSV (>500k rows)
   - Apply transformation → verify no column reordering
   - Check console for no errors or warnings

---

## Success Criteria

### Functional Requirements
- [ ] Existing columns stay in position after transformations (all tiers)
- [ ] New columns from split/combine appear at end
- [ ] Renamed columns stay in same position with new name
- [ ] Undo/redo preserves original column order
- [ ] Stack tables: column order = union of source columns
- [ ] Join tables: column order = left + right columns
- [ ] Transformations after stack/join preserve combined order
- [ ] Phantom columns appended at end without crash
- [ ] Internal columns excluded from columnOrder but present in grid

### Non-Functional Requirements
- [ ] Zero performance regression (< 1ms overhead)
- [ ] No race conditions between context refresh and store update
- [ ] Backward compatible with tables without columnOrder
- [ ] All tests passing (12 E2E + unit tests)
- [ ] No console errors or warnings

### Code Quality
- [ ] Dev-mode warnings for phantom columns
- [ ] Strict internal column filtering
- [ ] Pure utility functions (easily testable)
- [ ] Clear execution flow in executor

---

## Risks & Mitigations

| Risk | Mitigation | Status |
|------|-----------|--------|
| Race condition in executor | Calculate columnOrder BEFORE context refresh | Addressed Phase 4 |
| Phantom columns cause crashes | Safety valve appends at end | Addressed Phase 3 |
| Internal columns leak into UI | Strict filtering in all utilities | Addressed Phase 3 |
| Combiner tables lack columnOrder | Explicit initialization in commands | Addressed Phase 7 |
| Batching breaks column order | Pass columnOrder through pipeline | Addressed Phase 8 |
| Existing tables without columnOrder | Graceful undefined handling | Addressed Phase 4 |
| Snapshot restore loses order | tableStore maintains through timeline | Addressed Phase 6 |

---

## Appendix: StoreInspector Methods Needed

Add to `e2e/helpers/store-inspector.ts`:

```typescript
async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
  return await this.page.evaluate(async (name) => {
    const store = window.__cleanslate_stores__.tableStore.getState()
    const table = store.tables.find(t => t.name === name)
    return table?.columns || []
  }, tableName)
}

async getTableInfo(tableName: string): Promise<TableInfo | undefined> {
  return await this.page.evaluate(async (name) => {
    const store = window.__cleanslate_stores__.tableStore.getState()
    return store.tables.find(t => t.name === name)
  }, tableName)
}
```
