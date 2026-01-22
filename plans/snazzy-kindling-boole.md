# Plan: Fix Undo/Redo for Structural Transformations

## Problem
Undo/redo is broken for `split_column` and `combine_columns`:
1. **Undo** does NOT remove the columns created by split/combine
2. **Redo** creates duplicate columns with `_1` suffix instead of restoring originals

## Root Cause
In `src/App.tsx`, the `handleUndo` and `handleRedo` functions incorrectly handle the return value from `undoTimeline()`/`redoTimeline()`.

**Current broken code (lines 120-124):**
```typescript
const newRowCount = await undoTimeline(activeTableId)
if (typeof newRowCount === 'number') {  // ← ALWAYS FALSE!
  updateTable(activeTableId, { rowCount: newRowCount })
}
```

**The issue:**
- `undoTimeline()` returns `{ rowCount: number; columns: ColumnInfo[] } | undefined`
- The code checks `typeof newRowCount === 'number'` which is always `false` for an object
- `updateTable()` is **never called**, so columns are never updated in the UI
- The UI shows stale columns while DuckDB has the correctly restored state

**Why "_1" duplicates appear:** When users see undo "didn't work" (columns still visible), they may manually re-apply the transform, causing collision detection to add `_split` suffixes.

## Verified Assumptions
- ✅ `tableStore.updateTable()` accepts `Partial<TableInfo>` including `columns` (line 17)
- ✅ `replayToPosition()` queries live DuckDB via `getTableColumns()` before returning (lines 321, 367)
- ✅ Race condition protection exists via `isReplaying` flag
- ✅ Snapshot restoration properly drops and recreates table (lines 307-308)

## Fix

### File: `src/App.tsx`

**Change 1: Fix handleUndo (lines 113-142)**

Replace the entire `handleUndo` function:
```typescript
const handleUndo = useCallback(async () => {
  console.log('[UNDO] handleUndo called', { activeTableId, isReplaying, activeTable: activeTable?.name })
  if (!activeTableId || isReplaying) {
    console.log('[UNDO] Early return - no activeTableId or isReplaying')
    return
  }
  try {
    const result = await undoTimeline(activeTableId)
    console.log('[UNDO] undoTimeline returned:', result)
    if (result) {
      console.log('[UNDO] Calling updateTable with rowCount:', result.rowCount, 'columns:', result.columns.length)
      updateTable(activeTableId, { rowCount: result.rowCount, columns: result.columns })
      if (activeTable) {
        addAuditEntry(
          activeTableId,
          activeTable.name,
          'Undo',
          'Reverted to previous state',
          'A'
        )
      }
    } else {
      console.log('[UNDO] No result returned, nothing to undo')
    }
    // Refresh memory after timeline operation
    refreshMemory()
  } catch (error) {
    console.error('[UNDO] Error during undo:', error)
  }
}, [activeTableId, activeTable, isReplaying, addAuditEntry, updateTable, refreshMemory])
```

**Change 2: Fix handleRedo (lines 144-172)**

Replace the entire `handleRedo` function:
```typescript
const handleRedo = useCallback(async () => {
  console.log('[REDO] handleRedo called', { activeTableId, isReplaying })
  if (!activeTableId || isReplaying) {
    console.log('[REDO] Early return - no activeTableId or isReplaying')
    return
  }
  try {
    const result = await redoTimeline(activeTableId)
    console.log('[REDO] redoTimeline returned:', result)
    if (result) {
      console.log('[REDO] Calling updateTable with rowCount:', result.rowCount, 'columns:', result.columns.length)
      updateTable(activeTableId, { rowCount: result.rowCount, columns: result.columns })
      if (activeTable) {
        addAuditEntry(
          activeTableId,
          activeTable.name,
          'Redo',
          'Reapplied next state',
          'A'
        )
      }
    } else {
      console.log('[REDO] No result returned, nothing to redo')
    }
    // Refresh memory after timeline operation
    refreshMemory()
  } catch (error) {
    console.error('[REDO] Error during redo:', error)
  }
}, [activeTableId, activeTable, isReplaying, addAuditEntry, updateTable, refreshMemory])
```

---

## Verification

### Manual Testing - Split Column
1. Load a CSV file with a column like "name" containing values like "John Doe"
2. Apply **Split Column** on "name" with space delimiter
3. Verify columns are now: [name, name_1, name_2]
4. Press **Ctrl+Z** (undo)
5. **Critical check**: Verify columns return to original (no name_1, name_2)
6. Press **Ctrl+Y** (redo)
7. **Critical check**: Verify columns are [name, name_1, name_2] (no duplicates like name_1_1)

### Manual Testing - Combine Columns
1. Load a CSV with "first_name" and "last_name" columns
2. Apply **Combine Columns** → creates "combined" column
3. Undo → verify "combined" column is removed
4. Redo → verify "combined" column is restored (not "combined_1")

### Manual Testing - Other Transforms
Test undo/redo with these transforms that affect row counts or columns:
- **Remove Duplicates** - verify row count updates
- **Filter Empty** - verify row count updates
- **Calculate Age** - verify new column appears/disappears
- **Standardize Date** - verify data changes undo properly

---

## Files to Modify
| File | Lines | Change |
|------|-------|--------|
| `src/App.tsx` | 113-142 | Fix handleUndo to use result object with rowCount + columns |
| `src/App.tsx` | 144-172 | Fix handleRedo to use result object with rowCount + columns |
