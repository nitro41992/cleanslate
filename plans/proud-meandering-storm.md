# Fix Row Persistence Bug + Add Regression Tests

## Summary

1. **Bug Fix:** Newly added rows are not persisting across page refresh
2. **Tests:** Add regression tests for row and column persistence to prevent future breakage

**Note:** Column ordinal persistence (drag reorder) is working correctly - only need tests.

## Root Cause Analysis

### Row Persistence Bug

**Root Cause:** `data:insert_row` is classified as `LOCAL_ONLY_COMMANDS` in `executor.ts:148`. This optimization:
- Skips `dataVersion` increment (to avoid grid scroll reset)
- Skips `requestPrioritySave()` call (line 751)
- The persistence subscription only fires when `hasDataChanged` is true
- Result: New rows are never exported to Parquet

**Data Loss Path:**
```
User inserts row → executor marks dirty → dataVersion NOT incremented →
usePersistence Effect 6 doesn't fire → Effect 6b marks "clean" via changelog →
User refreshes before 30s compaction → Row is lost
```

## Implementation Plan

### Phase 1: Fix Row Persistence

**File:** `src/lib/commands/executor.ts`

After the silent update block (around line 740), add priority save for row/column data mutations:

```typescript
// After silent update block, trigger priority save for data mutations
// These need Parquet export even though they skip dataVersion bump
if (command.type === 'data:insert_row' || command.type === 'data:delete_row') {
  uiStoreModule.useUIStore.getState().requestPrioritySave(tableId)
  console.log('[Executor] Priority save requested for data mutation:', command.type)
}
```

This ensures row insertions trigger immediate Parquet export without grid reload.

### Phase 2: Add E2E Regression Tests

**File:** `e2e/tests/row-column-persistence.spec.ts` (new)

Test cases to add:

#### Row Persistence Tests
1. **Insert row above → refresh → verify row persists**
2. **Insert row below → refresh → verify row persists**
3. **Insert multiple rows → refresh → verify all rows persist in correct positions**
4. **Delete row → refresh → verify deletion persists**

#### Column Persistence Tests
1. **Add column left of selection → refresh → verify column position**
2. **Add column right of selection → refresh → verify column position**
3. **Drag column to new position → refresh → verify new order persists**
4. **Multiple column reorders → refresh → verify final order persists**

Test pattern (from e2e/CLAUDE.md):
```typescript
test.describe.serial('Row/Column Persistence', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Fresh context per test for WASM isolation
    context = await browser.newContext()
    page = await context.newPage()
    // ... re-init page objects
  })

  test.afterEach(async () => {
    await context.close()
  })

  test('inserted row persists after refresh', async () => {
    // 1. Upload CSV, import
    // 2. Insert row above/below selection
    // 3. Verify row exists via SQL
    // 4. Refresh page
    // 5. Wait for DuckDB ready + table loaded
    // 6. Verify row still exists via SQL with same data
  })

  test('column order persists after drag reorder', async () => {
    // 1. Upload CSV, import
    // 2. Get initial column order via SQL/store
    // 3. Drag column to new position
    // 4. Verify new order
    // 5. Refresh page
    // 6. Verify column order matches after refresh
  })
})
```

## Critical Files

| File | Changes |
|------|---------|
| `src/lib/commands/executor.ts` | Add priority save for `data:insert_row`/`data:delete_row` |
| `e2e/tests/row-column-persistence.spec.ts` | New test file for persistence regression tests |

## Verification Plan

### Manual Testing
1. Start fresh (clear OPFS)
2. Import a CSV with 5 rows
3. Insert a row → verify it appears
4. Refresh → verify row persists
5. Drag a column to new position
6. Refresh → verify column order persists

### Automated Testing
```bash
npx playwright test "row-column-persistence.spec.ts" --timeout=90000 --retries=0 --reporter=line
```

## Feature Status (Verified)

| Feature | Status | Notes |
|---------|--------|-------|
| Insert Row Above | ✅ Working | RowMenu.tsx → DataGrid.handleInsertRowAbove() |
| Insert Row Below | ✅ Working | RowMenu.tsx → DataGrid.handleInsertRowBelow() |
| Insert Column Left | ✅ Working | ColumnHeaderMenu.tsx → DataGrid.handleAddColumnConfirm() |
| Insert Column Right | ✅ Working | ColumnHeaderMenu.tsx → DataGrid.handleAddColumnConfirm() |
| Column Drag Reorder | ✅ Working | DataGrid with setColumnOrder() |
| **Row Persistence** | ❌ Bug | Rows lost on refresh - needs fix |
| Column Order Persistence | ✅ Working | Just needs regression tests |

## Dependencies

- Row insertion UI exists (RowMenu component with Above/Below)
- Column insertion UI exists (ColumnHeaderMenu with Left/Right)
- Column drag-reorder UI exists (DataGrid)
- Priority save mechanism exists in uiStore
- Parquet export mechanism exists in usePersistence

## Risks

- Adding priority save for every row insert increases write frequency
- Mitigation: Row inserts are rare compared to cell edits; acceptable overhead
