# Polish: Row Addition Dirty Indicators & Scroll Preservation

## Status: ✅ IMPLEMENTED

## Summary

Two polish items for row/column addition:
1. **Dirty indicators**: New rows should show orange gutter (pending) → green gutter (saved)
2. **Scroll preservation**: Adding rows/columns should not reset scroll position

---

## Issue 1: New Rows Not Showing Dirty Indicators

### Root Cause
`InsertRowCommand` doesn't implement `getCellChanges()`, so no cell changes are recorded in the timeline. The dirty cell tracking system only shows indicators for cells with recorded `CellChange` entries.

### Solution
Add `getCellChanges()` method to `InsertRowCommand` following the pattern in `EditCellCommand`.

### File: `src/lib/commands/data/insert-row.ts`

**Changes:**
1. Import `CellChange` type
2. Add `private userColumns: string[] = []` field to store column names
3. In `execute()`, store user column names: `this.userColumns = userColumns.map(c => c.name)`
4. Add `getCellChanges()` method:

```typescript
getCellChanges(): CellChange[] {
  if (!this.newCsId || this.userColumns.length === 0) {
    return []
  }

  return this.userColumns.map(columnName => ({
    csId: this.newCsId!,
    columnName,
    previousValue: undefined,  // Row didn't exist
    newValue: null,            // New cells are NULL
  }))
}
```

---

## Issue 2: Scroll Position Resetting

### Root Cause
When `dataVersion` changes, the DataGrid useEffect:
1. Captures `savedScrollPosition` from `scrollPositionRef`
2. Clears data with `setData([])`
3. Grid may fire `onVisibleRegionChanged` with `{0, 0}` during re-render
4. Restores scroll via `requestAnimationFrame`

The timing between data clear and scroll restore can cause visual scroll reset.

### Solution
Add a "scroll lock" flag to prevent `onVisibleRegionChanged` from overwriting the saved position during reload.

### File: `src/components/grid/DataGrid.tsx`

**Changes:**

1. Add ref around line 445:
```typescript
const isReloadingRef = useRef(false)
```

2. In the data reload useEffect (around line 1033), set lock before save:
```typescript
isReloadingRef.current = true
const savedScrollPosition = scrollPositionRef.current
```

3. After scroll restore (around line 1141), release lock:
```typescript
requestAnimationFrame(() => {
  if (gridRef.current && savedScrollPosition) {
    const { col, row } = savedScrollPosition
    const clampedRow = Math.min(row, Math.max(0, rowCount - 1))
    gridRef.current.scrollTo(col, clampedRow)
  }
  // Release lock after grid settles
  requestAnimationFrame(() => {
    isReloadingRef.current = false
  })
})
```

4. In `onVisibleRegionChanged` (around line 1252), guard the update:
```typescript
if (!isReloadingRef.current) {
  scrollPositionRef.current = { col: range.x, row: range.y }
}
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/commands/data/insert-row.ts` | Add `getCellChanges()` method |
| `src/components/grid/DataGrid.tsx` | Add scroll lock during reload |

---

## Verification

### Dirty Indicators (Issue 1)
1. Load a table with data
2. Right-click a row → Insert Row Below
3. **Expected**: New row shows green gutter bar immediately after insert
4. Make an edit to the new row → orange bar appears
5. Wait 500ms → green bar returns (batch flush)
6. Refresh page → green bar persists

### Scroll Preservation (Issue 2)
1. Load a table with 100+ rows
2. Scroll down to row 50
3. Right-click → Insert Row Below
4. **Expected**: Grid stays at approximately the same scroll position
5. Repeat with Insert Row Above
6. Repeat with Add Column Left/Right
