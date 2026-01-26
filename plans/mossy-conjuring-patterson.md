# Plan: Fix Undo Parameter Preservation Bug

## Problem Statement

**Bug:** When undoing a Tier 2 command (rename column), a previous Tier 3 command (pad zeros) loses its custom parameters and reverts to defaults.

**Reproduction Steps:**
1. Pad zeros with length=**9** on column A (Tier 3)
2. Rename a **different** column B to something else (Tier 2)
3. Immediately undo the rename (Ctrl+Z)
4. **BUG:** Column A now shows **5 zeros** (default) instead of 9

**User Report:** "The audit log shows the correct value (9), but the data preview grid shows 5"

---

## Root Cause Analysis

### Key Findings from Investigation

**DataGrid Refresh Mechanism (`src/components/grid/DataGrid.tsx:160-231`):**
- DataGrid has `dataVersion` in useEffect dependency array (line 231)
- When `dataVersion` increments, grid re-fetches data from DuckDB via `getDataWithRowIds()`
- This is **correct behavior** - grid should show fresh data from database

**Undo Flow (`src/lib/commands/executor.ts:541-653`):**
- Tier 2 undo executes inverse SQL (line 597)
- Then calls `refreshTableContext()` and `updateTableStore()` (lines 640-644)
- `updateTableStore()` increments `dataVersion` at line 995, triggering grid refresh

**The Mystery:**
- If grid fetches from DuckDB, it should show correct data
- User says audit log shows 9 (correct), but grid shows 5 (wrong)
- This suggests either:
  1. DuckDB data is actually wrong (data corruption during undo)
  2. Grid is reading from wrong table/view
  3. Race condition between undo completion and grid refresh

### Hypothesis

**Most Likely:** There's a bug in how the command executor manages the database state during mixed Tier 2/Tier 3 undo operations. Specifically:

1. When Tier 2 undo executes, it might be inadvertently triggering a snapshot restoration
2. Or: The `refreshTableContext()` call might be rebuilding transformations from stale state
3. Or: There's a race condition where grid fetches before undo completes

**Evidence Needed:**
- Direct DuckDB query to verify data (bypass UI)
- Timeline state inspection to verify params.length = 9
- Logging to trace exact execution flow

---

## Implementation Plan

### Phase 1: Create Failing Test

**File:** `e2e/tests/bugs/tier-3-undo-param-preservation.spec.ts`

**Test Structure:**
```typescript
test.describe.serial('Bug: Tier 3 Undo Parameter Preservation', () => {
  // Reproduces bug where undoing Tier 2 command causes
  // previous Tier 3 command to lose custom parameters

  test('pad zeros params should persist after unrelated rename undo', async () => {
    // 1. Upload CSV: account_number, name
    // 2. Pad zeros to account_number with length=9
    // 3. Verify: DuckDB shows '000000123'
    // 4. Rename: name → customer_name
    // 5. Undo rename (Ctrl+Z)
    // 6. ASSERT: DuckDB still shows '000000123' (NOT '00123')
    // 7. ASSERT: Timeline params.length === 9 (NOT 5)
  })
})
```

**Test Implementation Details:**

Create new fixture: `e2e/fixtures/csv/undo-param-test.csv`
```csv
id,account_number,name
1,123,Alice
2,456,Bob
3,789,Charlie
```

Test code:
```typescript
import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../../page-objects/laundromat.page'
import { IngestionWizardPage } from '../../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../../helpers/store-inspector'
import { getFixturePath } from '../../helpers/file-upload'

test.describe.serial('Bug: Tier 3 Undo Parameter Preservation', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS undo_param_test')
    await page.close()
  })

  test('pad zeros params should persist after unrelated rename undo', async () => {
    // Setup: Import test data
    await inspector.runQuery('DROP TABLE IF EXISTS undo_param_test')
    await laundromat.uploadFile(getFixturePath('undo-param-test.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('undo_param_test', 3)

    // Step 1: Apply pad zeros with length=9 to account_number
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Pad with Zeros', {
      column: 'account_number',
      params: { length: 9 }  // CRITICAL: Use 9, not default 5
    })

    // Wait for transformation to complete
    await expect.poll(async () => {
      const rows = await inspector.getTableData('undo_param_test')
      return rows[0]?.account_number
    }, { timeout: 10000 }).toBe('000000123')

    // Verify all rows have 9 digits
    const dataBefore = await inspector.getTableData('undo_param_test')
    console.log('[TEST] Data after pad zeros:', dataBefore)
    expect(dataBefore[0].account_number).toBe('000000123')
    expect(dataBefore[1].account_number).toBe('000000456')
    expect(dataBefore[2].account_number).toBe('000000789')

    // Verify timeline has correct params
    const timelineBefore = await inspector.getAuditEntries()
    const padEntry = timelineBefore.find(e => e.action.includes('Pad'))
    console.log('[TEST] Pad zeros audit entry:', padEntry)

    // Step 2: Rename DIFFERENT column (name → customer_name)
    await picker.addTransformation('Rename Column', {
      column: 'name',
      params: { newName: 'customer_name' }
    })

    // Verify rename worked
    await expect.poll(async () => {
      const schema = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'undo_param_test' ORDER BY column_name"
      )
      return schema.map(c => c.column_name)
    }, { timeout: 5000 }).toContain('customer_name')

    // Close picker
    await laundromat.closePanel()

    // Step 3: Undo the rename
    console.log('[TEST] Pressing Ctrl+Z to undo rename...')
    await page.keyboard.press('Control+Z')

    // Wait for undo to complete (column 'name' should exist again)
    await expect.poll(async () => {
      const schema = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'undo_param_test' ORDER BY column_name"
      )
      return schema.map(c => c.column_name)
    }, { timeout: 5000 }).toContain('name')

    // CRITICAL ASSERTIONS: Verify data still has 9 zeros (NOT 5!)

    // Layer 1: Direct DuckDB query (bypass UI entirely)
    const dataAfterUndo = await inspector.runQuery(
      'SELECT account_number FROM undo_param_test ORDER BY id'
    )
    console.log('[TEST] Data after undo (direct SQL):', dataAfterUndo)

    // Assert exact values (identity, not just length)
    expect(dataAfterUndo[0].account_number).toBe('000000123')  // NOT '00123'
    expect(dataAfterUndo[1].account_number).toBe('000000456')  // NOT '00456'
    expect(dataAfterUndo[2].account_number).toBe('000000789')  // NOT '00789'

    // Layer 2: Verify timeline still has correct params
    const commandExecutor = await page.evaluate(() => {
      const { getCommandExecutor } = window as any
      const executor = getCommandExecutor()
      const timeline = executor.getTimeline('undo_param_test')
      return {
        position: timeline?.position,
        commands: timeline?.commands.map((c: any) => ({
          type: c.commandType,
          params: c.params,
          tier: c.tier
        }))
      }
    })
    console.log('[TEST] Timeline state:', commandExecutor)

    const padCommand = commandExecutor.commands.find((c: any) =>
      c.type === 'transform:pad_zeros'
    )
    expect(padCommand).toBeDefined()
    expect(padCommand.params.length).toBe(9)  // NOT 5 or undefined

    // Layer 3: Verify via getTableData (uses same path as grid)
    const gridData = await inspector.getTableData('undo_param_test')
    console.log('[TEST] Data via getTableData (grid path):', gridData)
    expect(gridData[0].account_number).toBe('000000123')
  })
})
```

**Key Assertions:**
1. **Direct SQL** - Queries DuckDB bypassing all UI layers
2. **Timeline params** - Verifies command record has `params.length = 9`
3. **Grid data path** - Uses same `getTableData()` helper that grid uses

---

### Phase 2: Debug and Fix

Once test fails, add diagnostic logging to trace execution:

**Add to `src/lib/commands/executor.ts` undo() method (around line 596):**
```typescript
case 2:
  // Tier 2: Execute inverse SQL
  console.log('[UNDO DEBUG] Before inverse SQL execution')
  const dataBefore = await ctx.db.execute(`SELECT * FROM ${ctx.table.name} LIMIT 1`)
  console.log('[UNDO DEBUG] Data before:', dataBefore)

  if (commandRecord.inverseSql) {
    await ctx.db.execute(commandRecord.inverseSql)
  }

  const dataAfter = await ctx.db.execute(`SELECT * FROM ${ctx.table.name} LIMIT 1`)
  console.log('[UNDO DEBUG] Data after inverse SQL:', dataAfter)
  break
```

**Add after refreshTableContext() (line 640):**
```typescript
const updatedCtx = await refreshTableContext(ctx)
console.log('[UNDO DEBUG] After refreshTableContext, columns:', updatedCtx.table.columns)

const dataBeforeStoreUpdate = await ctx.db.execute(`SELECT * FROM ${ctx.table.name} LIMIT 1`)
console.log('[UNDO DEBUG] Data before updateTableStore:', dataBeforeStoreUpdate)

this.updateTableStore(tableId, {
  rowCount: updatedCtx.table.rowCount,
  columns: updatedCtx.table.columns,
})

const dataAfterStoreUpdate = await ctx.db.execute(`SELECT * FROM ${ctx.table.name} LIMIT 1`)
console.log('[UNDO DEBUG] Data after updateTableStore:', dataAfterStoreUpdate)
```

**Run test and analyze logs** to pinpoint where data changes from 9 to 5 zeros.

### Phase 3: Likely Fixes (Based on Root Cause)

**Scenario A: Data corruption during undo**
- **Location:** `executor.ts` undo() method
- **Fix:** Ensure no transformation re-execution during Tier 2 undo
- **Change:** Add guard to prevent snapshot restoration when undoing Tier 2

**Scenario B: Wrong snapshot being restored**
- **Location:** `snapshots.ts` or `executor.ts:604-613`
- **Fix:** Ensure `findNearestSnapshot()` doesn't accidentally restore during Tier 2 undo
- **Change:** Only call snapshot logic for Tier 3 undo

**Scenario C: Race condition in refresh**
- **Location:** `DataGrid.tsx:160-231` or `executor.ts:640-644`
- **Fix:** Ensure `updateTableStore()` is called AFTER database operations complete
- **Change:** Add await or move updateTableStore() to end of try block

**Scenario D: Column versioning interference**
- **Location:** `column-versions.ts` or `executor.ts:572-591`
- **Fix:** Ensure Tier 1 column version logic doesn't affect Tier 3 columns
- **Change:** Add check to verify column has version info before undoing

---

### Phase 4: Verification

**Test Suite to Run:**
1. New test: `tier-3-undo-param-preservation.spec.ts` (should pass)
2. Existing: `e2e/tests/feature-coverage.spec.ts` (FR-A3, FR-A4 tests with pad zeros)
3. Existing: `e2e/tests/undo-redo.spec.ts` (all undo/redo tests)
4. Existing: All transformation tests to ensure no regressions

**Manual Verification:**
1. Upload CSV with 2+ columns
2. Apply pad zeros (9) to column A
3. Apply 2-3 other transformations (rename, trim, etc.) to column B
4. Undo each transformation one by one
5. Verify column A always shows 9 zeros throughout

**Edge Cases:**
- Multiple Tier 3 commands with different params
- Undo → Redo → Undo sequence
- Undo past multiple Tier 2 commands
- Mixed Tier 1/2/3 command stack

---

## Critical Files

### To Modify (Likely)
1. **`src/lib/commands/executor.ts`** (Lines 541-653)
   - Undo logic - may need guards against unintended snapshot restoration

2. **`src/lib/commands/snapshots.ts`**
   - Snapshot selection logic - ensure correct snapshot is used

### To Create
3. **`e2e/tests/bugs/tier-3-undo-param-preservation.spec.ts`**
   - Failing test to reproduce bug

4. **`e2e/fixtures/csv/undo-param-test.csv`**
   - Test fixture data

### To Monitor (Don't Modify Unless Necessary)
5. **`src/components/grid/DataGrid.tsx`** (Lines 160-231)
   - Grid refresh logic - appears correct, but monitor during debug

6. **`src/stores/tableStore.ts`** (Lines 73-92)
   - Store update logic - triggers grid refresh

7. **`src/lib/commands/transform/tier3/pad-zeros.ts`**
   - Pad zeros implementation - verify params handling

---

## Success Criteria

✅ **Test passes:** Direct SQL query shows 9 zeros after undo
✅ **Timeline intact:** Command record has `params.length = 9`
✅ **UI correct:** Grid displays 9 zeros (not 5)
✅ **No regressions:** All existing E2E tests pass
✅ **Audit log:** Shows correct parameter values

---

## Notes

- User mentioned "[Request interrupted by user]" in audit log - may indicate async issue
- Audit log shows correct value (9) but grid shows wrong value (5) - suggests UI/DB desync
- Bug is with **unrelated column** rename - rules out simple column name tracking issue
- Default value of 5 appearing suggests transformation re-execution with missing params
