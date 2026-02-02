# Fix Row/Column Operations and Persistence

## Summary

Multiple issues with row/column operations need to be fixed:

1. **Add Column Left/Right**: Column goes to end instead of correct position
2. **Column Persistence**: New columns lost on refresh
3. **Row Persistence**: New rows lost on refresh (partially addressed in prior plan)
4. **Verification**: All operations need regression tests

## Root Cause Analysis

### Issue 1: Column Position Bug (Add Left/Right goes to end)

**Root Cause**: `schema:add_column` is in `LOCAL_ONLY_COMMANDS` (executor.ts:149), which uses a code path that DOESN'T update `columnOrder` in the store.

**Data Flow**:
```
DataGrid.handleAddColumnConfirm() → calculates insertAfter correctly
        ↓
executor.execute() → calculates newColumnOrder correctly (line 458-464)
        ↓
BUT isLocalOnlyCommand === true
        ↓
silentUpdates = { rowCount, columns } ← MISSING columnOrder!
        ↓
updateTableSilent(silentUpdates) ← columnOrder NOT updated
        ↓
App.tsx displayColumns memo → uses stale columnOrder
        ↓
reorderColumns() → new column becomes "phantom", appended at end
```

**Key Code** (executor.ts:716-746):
```typescript
// Line 716-723: silentUpdates only includes rowCount and columns
const silentUpdates: Partial<{ rowCount: number; columns: ColumnInfo[] }> = {}

// Line 744-746: updateTableSilent does NOT include columnOrder
if (Object.keys(silentUpdates).length > 0) {
  tableStore.updateTableSilent(ctx.table.id, silentUpdates)
}

// Line 771: updateTableStore WITH columnOrder is SKIPPED for LOCAL_ONLY_COMMANDS
```

### Issue 2: Column Persistence Bug

**Root Cause**: `schema:add_column` doesn't trigger priority save.

**Code** (executor.ts:734-741):
```typescript
if (command.type === 'data:insert_row' || command.type === 'data:delete_row') {
  // Priority save ONLY for row operations
  uiStoreModule.useUIStore.getState().requestPrioritySave(tableId)
}
// schema:add_column is MISSING → relies on 2s debounce → lost on quick refresh
```

### Issue 3: Row Persistence

Already has priority save at line 734 for `data:insert_row` and `data:delete_row`. Should work, but needs verification testing.

### Issue 4: Delete Column

`schema:delete_column` is NOT in `LOCAL_ONLY_COMMANDS`, so it goes through the normal path with `updateTableStore()` (line 771) which includes columnOrder. Should work correctly.

## Implementation Plan

### Phase 1: Fix Column Position (Add Left/Right)

**File:** `src/lib/commands/executor.ts`

**Location:** After line 746 (after `updateTableSilent` call)

Add columnOrder update for `schema:add_column`:

```typescript
        // Apply silent update if anything changed
        if (Object.keys(silentUpdates).length > 0) {
          tableStore.updateTableSilent(ctx.table.id, silentUpdates)
        }

        // CRITICAL FIX: Update columnOrder for schema:add_column
        // The newColumnOrder was calculated at line 458-464 but never applied
        // because LOCAL_ONLY commands skip updateTableStore() which includes columnOrder
        if (command.type === 'schema:add_column') {
          tableStore.setColumnOrder(ctx.table.id, newColumnOrder)
          console.log('[Executor] Updated columnOrder for add_column:', newColumnOrder)
        }
```

### Phase 2: Fix Column Persistence

**File:** `src/lib/commands/executor.ts`

**Location:** Line 734 - extend the existing condition

Change from:
```typescript
        if (command.type === 'data:insert_row' || command.type === 'data:delete_row') {
```

To:
```typescript
        if (
          command.type === 'data:insert_row' ||
          command.type === 'data:delete_row' ||
          command.type === 'schema:add_column'
        ) {
```

### Phase 3: Add Column Position E2E Tests

**File:** `e2e/tests/row-column-persistence.spec.ts` (existing file has row tests, need to add column tests)

**Already implemented:**
- FR-ROW-PERSIST-1 through 4: Row insert/delete persistence tests
- FR-COL-PERSIST-1 through 2: Column order drag-reorder persistence tests

**Tests to add:**

1. `FR-COL-POSITION-1`: Add column left → verify appears LEFT of selected column
2. `FR-COL-POSITION-2`: Add column right → verify appears RIGHT of selected column
3. `FR-COL-PERSIST-3`: Add column → refresh → verify persists at correct position
4. `FR-COL-PERSIST-4`: Delete column → refresh → verify deletion persists

## Critical Files

| File | Changes |
|------|---------|
| `src/lib/commands/executor.ts` | 1. Add columnOrder update for schema:add_column<br>2. Add priority save for schema:add_column |
| `e2e/tests/row-column-persistence.spec.ts` | New test file with comprehensive tests |

## Verification Plan

### Manual Testing Checklist

1. **Add Column Left**
   - Select middle column
   - Click "Insert Left"
   - Verify new column appears to LEFT of selected
   - Refresh page
   - Verify column still in correct position

2. **Add Column Right**
   - Select middle column
   - Click "Insert Right"
   - Verify new column appears to RIGHT of selected
   - Refresh page
   - Verify column still in correct position

3. **Insert Row Above**
   - Select a middle row
   - Click "Insert Above"
   - Verify new row appears ABOVE selected with green gutter
   - Refresh page
   - Verify row persists at correct position

4. **Insert Row Below**
   - Select a middle row
   - Click "Insert Below"
   - Verify new row appears BELOW selected with green gutter
   - Refresh page
   - Verify row persists

5. **Delete Row**
   - Select a row
   - Delete it
   - Refresh page
   - Verify deletion persists

6. **Delete Column**
   - Select a column
   - Delete it
   - Refresh page
   - Verify deletion persists

### Automated Testing
```bash
npx playwright test "row-column-persistence.spec.ts" --timeout=90000 --retries=0 --reporter=line
```

## Feature Status Summary

| Feature | Works? | Position Correct? | Persists? | Fix Needed? |
|---------|--------|-------------------|-----------|-------------|
| Insert Row Above | ✅ | ✅ | ✅ | None (already in uncommitted code) |
| Insert Row Below | ✅ | ✅ | ✅ | None (already in uncommitted code) |
| Delete Row | ✅ | N/A | ✅ | None (already in uncommitted code) |
| Add Column Left | ✅ | ❌ Goes to end | ❌ | **Phase 1 + Phase 2** |
| Add Column Right | ✅ | ❌ Goes to end | ❌ | **Phase 1 + Phase 2** |
| Delete Column | ✅ | N/A | ✅ | None (not LOCAL_ONLY) |

### What "Already in uncommitted code" means

Row operations already have a fix in your local working directory (uncommitted changes to `executor.ts`).

The git diff shows this code was already added:
```typescript
if (command.type === 'data:insert_row' || command.type === 'data:delete_row') {
  uiStoreModule.useUIStore.getState().requestPrioritySave(tableId)
}
```

**Row persistence should work now** - just needs testing and committing.

### What still needs implementation

**Column operations need TWO fixes** (Phase 1 and Phase 2 in this plan):
1. **Position fix**: New column goes to end instead of left/right of selected
2. **Persistence fix**: New column lost on refresh

## Risks & Mitigations

1. **Increased write frequency**: Schema/row operations now trigger immediate save
   - Mitigation: These are rare user-initiated operations, acceptable overhead

2. **Regression in grid behavior**: Changing LOCAL_ONLY path could affect scroll position
   - Mitigation: Only adding setColumnOrder call, not changing dataVersion bump logic
