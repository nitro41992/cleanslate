# Plan: Column/Row Add/Delete/Rearrange Features

## Status: Implementation Complete

---

## User Requirements
1. Add/delete columns
2. Add/delete rows
3. Rearrange (reorder) columns
4. **Row numbers** for reference (renumber automatically when rows deleted)
5. Context menus (not FABs) for add/delete operations

---

## Research Summary

### Glide Data Grid Native Support
From [Row Markers documentation](https://docs.grid.glideapps.com/api/dataeditor/row-markers):
- `rowMarkers` prop enables row number column on left
- `rowMarkerStartIndex` sets starting number (default: 1)
- `rowMarkerWidth` adapts based on row count
- `onColumnMoved` - drag column to new location ✅
- `onHeaderMenuClick` - header menu click event

### Current Codebase State
- `ColumnHeaderMenu` component exists at `src/components/grid/filters/ColumnHeaderMenu.tsx`
- Currently shows Sort and Filter options on column header click
- No row markers enabled (no `rowMarkers` prop)
- Column reorder utility exists in `src/lib/commands/utils/column-ordering.ts`

**Sources:**
- [Glide Data Grid API](https://docs.grid.glideapps.com/)
- [Row Markers](https://docs.grid.glideapps.com/api/dataeditor/row-markers)

---

## Design: Context Menu Approach

### Column Header Menu (Extended)
When clicking a column header, the existing `ColumnHeaderMenu` popover shows. We extend it with:

```
┌─────────────────────────┐
│ Sort                    │
│   ↑ Sort Ascending      │
│   ↓ Sort Descending     │
│   ✕ Clear Sort          │
├─────────────────────────┤
│ Filter                  │
│   [operator] [value]    │
│   [Apply] [Clear]       │
├─────────────────────────┤  ← NEW SECTION
│ Column                  │
│   ← Insert Left         │
│   → Insert Right        │
│   🗑 Delete Column       │
└─────────────────────────┘
```

### Row Number Column
Enable Glide Data Grid's built-in row markers:
```typescript
rowMarkers="number"           // Shows row numbers
rowMarkerStartIndex={1}       // Start from 1
```

Row numbers are **reference only** - when a row is deleted, remaining rows renumber automatically (this is built-in behavior).

### Row Context Menu (New)
When clicking a row number, show a popover menu:

```
┌─────────────────────────┐
│ Row                     │
│   ↑ Insert Above        │
│   ↓ Insert Below        │
│   🗑 Delete Row          │
└─────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Core Commands (Tier 3 - Snapshot Based)

**1.1 `schema:add_column` Command**
```typescript
// src/lib/commands/schema/add-column.ts
interface AddColumnParams {
  tableId: string
  tableName: string
  columnName: string
  columnType: 'VARCHAR' | 'INTEGER' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP'
  insertAfter?: string  // Column name to insert after, or null for end
}
// Tier 3: Snapshot for undo (restores original schema)
```

**1.2 `schema:delete_column` Command**
```typescript
// src/lib/commands/schema/delete-column.ts
interface DeleteColumnParams {
  tableId: string
  tableName: string
  columnName: string
}
// Tier 3: Requires snapshot for undo (column data is lost)
```

**1.3 `data:insert_row` Command**
```typescript
// src/lib/commands/data/insert-row.ts
interface InsertRowParams {
  tableId: string
  tableName: string
  insertAfterCsId?: string  // Insert after this row, or null for end
}
// Tier 3: Snapshot for undo
```

**1.4 `data:delete_row` Command**
```typescript
// src/lib/commands/data/delete-row.ts
interface DeleteRowParams {
  tableId: string
  tableName: string
  csIds: string[]  // One or more row IDs to delete
}
// Tier 3: Requires snapshot for undo
```

### Phase 2: Enable Row Markers

**2.1 Add rowMarkers prop to DataGrid**
```typescript
// In DataGrid.tsx DataGridLib component:
rowMarkers="number"
rowMarkerStartIndex={1}
onRowMarkerClick={handleRowMarkerClick}  // New handler for row menu
```

**2.2 Create RowMenu Component**
```
src/components/grid/RowMenu.tsx
```
Similar structure to ColumnHeaderMenu but with row-specific options.

### Phase 3: Extend Column Header Menu

**3.1 Modify ColumnHeaderMenu**
Add new "Column" section with:
- Insert Left
- Insert Right
- Delete Column (with confirmation)

**3.2 Create AddColumnDialog**
```
src/components/grid/AddColumnDialog.tsx
```
Simple dialog with:
- Column name input
- Type defaults to VARCHAR (per design decision)

### Phase 4: Column Reorder UI

**4.1 Enable drag-drop in DataGrid**
```typescript
onColumnMoved={(startIndex, endIndex) => {
  const newOrder = [...columns]
  const [moved] = newOrder.splice(startIndex, 1)
  newOrder.splice(endIndex, 0, moved)
  updateColumnOrder(tableId, newOrder)
}}
```

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/commands/schema/add-column.ts` | Create | Add column command |
| `src/lib/commands/schema/delete-column.ts` | Create | Delete column command |
| `src/lib/commands/data/insert-row.ts` | Create | Insert row command |
| `src/lib/commands/data/delete-row.ts` | Create | Delete row command |
| `src/lib/commands/index.ts` | Modify | Export new commands |
| `src/components/grid/RowMenu.tsx` | Create | Row context menu |
| `src/components/grid/AddColumnDialog.tsx` | Create | Add column dialog |
| `src/components/grid/DataGrid.tsx` | Modify | Add rowMarkers, onColumnMoved, row click handler |
| `src/components/grid/filters/ColumnHeaderMenu.tsx` | Modify | Add column operations section |

---

## Verification Plan

1. **Row Numbers:** Verify row numbers display (1, 2, 3...) and renumber after delete
2. **Add Column:** Click header → Insert Left/Right → enter name → verify column appears
3. **Delete Column:** Click header → Delete → confirm → verify removed, undo restores
4. **Add Row:** Click row number → Insert Above/Below → verify empty row appears
5. **Delete Row:** Click row number → Delete → confirm → verify removed, undo restores
6. **Column Reorder:** Drag column header → verify new order persists
7. **Undo/Redo:** All operations reversible via Command Pattern

---

## Design Decisions (Confirmed)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default column type | **VARCHAR** | Most flexible, user can cast later |
| Delete confirmation | **Yes, always confirm** | Prevents accidental data loss |
| New row values | **Empty (null)** | Clean slate for user input |
| Row numbers | **Reference only** | Auto-renumber on delete (built-in) |
