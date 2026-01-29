# Enhanced Diff View - Implementation Plan

## Status: ✅ IMPLEMENTED

All four phases have been completed and the build passes.

## Overview
Enhance the diff view with:
1. **Column width adjustment** - ✅ Drag to resize columns
2. **Word wrap toggle** - ✅ Same as data preview
3. **Column filter** - ✅ Show only rows where a specific column changed
4. **Clickable status pills** - ✅ Multi-select toggle filter (Added/Modified/Removed)

---

## Architecture Decision

**State Location: `diffStore.ts`**

Since diff views are ephemeral (don't persist to OPFS), state lives in `diffStore`. This enables coordination between `DiffView`, `DiffSummaryPills`, and `VirtualizedDiffGrid`.

---

## Implementation Phases

### Phase 1: Column Width Adjustment

**Files to modify:**
- `src/stores/diffStore.ts` - Add state + actions
- `src/components/diff/VirtualizedDiffGrid.tsx` - Wire up resize

**diffStore changes:**
```typescript
// New state
columnWidths: Record<string, number>  // columnName -> width

// New actions
setColumnWidth: (column: string, width: number) => void
clearColumnWidths: () => void  // Called on clearResults()
```

**VirtualizedDiffGrid changes:**
1. Import constants from `column-sizing.ts`: `GLOBAL_MIN_COLUMN_WIDTH`, `GLOBAL_MAX_COLUMN_WIDTH`
2. Replace hardcoded `width: 180` (line 171) with `columnWidths[col] ?? 180`
3. Add `onColumnResize={handleColumnResize}` to DataGridLib
4. Add `minColumnWidth`, `maxColumnWidth` props

---

### Phase 2: Word Wrap Toggle

**Files to modify:**
- `src/stores/diffStore.ts` - Add state + action
- `src/components/diff/VirtualizedDiffGrid.tsx` - Row height + cell wrapping
- `src/components/diff/DiffView.tsx` - Toggle button UI

**diffStore changes:**
```typescript
// New state
wordWrapEnabled: boolean  // default: false

// New action
toggleWordWrap: () => void
```

**VirtualizedDiffGrid changes:**
1. Add `rowHeight={wordWrapEnabled ? 80 : 33}` to DataGridLib
2. Add `allowWrapping: wordWrapEnabled` to cell return in `getCellContent`
3. Add grid remount via `gridKey` state when wordWrap changes (same as DataGrid.tsx:1299-1311)

**DiffView changes:**
Add toggle button in controls area (between summary pills and grid):
```tsx
<Button onClick={toggleWordWrap} className={wordWrapEnabled ? 'bg-amber-500/20' : ''}>
  <WrapText className="w-4 h-4" />
</Button>
```

---

### Phase 3: Clickable Status Pills (Multi-Select Toggle)

**Files to modify:**
- `src/stores/diffStore.ts` - Add filter state
- `src/components/diff/DiffSummaryPills.tsx` - Convert to clickable
- `src/components/diff/VirtualizedDiffGrid.tsx` - Apply filter

**diffStore changes:**
```typescript
// New state
statusFilter: ('added' | 'removed' | 'modified')[] | null  // null = show all

// New actions
toggleStatusFilter: (status: 'added' | 'removed' | 'modified') => void
clearStatusFilter: () => void
```

**DiffSummaryPills changes:**
1. Add props: `activeFilters`, `onToggle`
2. Convert `<div>` pills to `<button>` elements
3. Add active state styling (ring highlight when active)
4. Add cursor-pointer and hover effects
5. "Same" pill remains non-clickable (display only)

**VirtualizedDiffGrid changes:**
1. Read `statusFilter` from store
2. Filter data client-side: `data.filter(row => !statusFilter || statusFilter.includes(row.diff_status))`
3. Pass filtered count to DataGridLib `rows` prop
4. Adjust loaded range calculations for filtered view

**Filter Logic:**
- Initial state: `null` (show all rows including unchanged in totalRows calculation)
- Click "Added": `['added']` - only added rows
- Click "Modified" while "Added" active: `['added', 'modified']`
- Click "Added" again: `['modified']` (deselect)
- All deselected → reset to `null` (show all)

---

### Phase 4: Column Filter Dropdown

**Files to modify:**
- `src/stores/diffStore.ts` - Add column filter state
- `src/lib/diff-engine.ts` - Add query for column-specific changes
- `src/components/diff/DiffView.tsx` - Dropdown UI
- `src/components/diff/VirtualizedDiffGrid.tsx` - Apply column filter

**diffStore changes:**
```typescript
// New state
columnFilter: string | null  // column name to filter on, null = all

// New actions
setColumnFilter: (column: string | null) => void
```

**diff-engine.ts changes:**
Add function to get row IDs with changes in specific column:
```typescript
export async function getRowsWithColumnChanges(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  columnName: string,
  storageType: 'memory' | 'parquet'
): Promise<Set<string>>
```

Query:
```sql
SELECT d.row_id FROM "${diffTableName}" d
LEFT JOIN source a ON d.a_row_id = a."_cs_id"
LEFT JOIN target b ON d.b_row_id = b."_cs_id"
WHERE d.diff_status = 'modified'
  AND CAST(a."${columnName}" AS VARCHAR) IS DISTINCT FROM CAST(b."${columnName}" AS VARCHAR)
```

**DiffView changes:**
Add dropdown in controls row:
```tsx
<Select value={columnFilter ?? 'all'} onValueChange={...}>
  <SelectTrigger className="w-48">
    <SelectValue placeholder="Filter by column" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="all">All columns</SelectItem>
    {allColumns.map(col => (
      <SelectItem key={col} value={col}>{col}</SelectItem>
    ))}
  </SelectContent>
</Select>
```

**VirtualizedDiffGrid changes:**
1. Read `columnFilter` from store
2. When set, fetch row IDs with that column's changes (call new engine function)
3. Filter data to only those rows
4. May need to re-fetch with adjusted pagination

---

## UI Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Header: [← Back] DELTA INSPECTOR [Blind Mode] [Export] [New] [X]    │
├──────────────────────────────────────────────────────────────────────┤
│ Schema Banner (if columns added/removed)                             │
├──────────────────────────────────────────────────────────────────────┤
│ Summary Pills (clickable):                                           │
│   [+ Added 123] [- Removed 45] [~ Changed 789]  [= Same 1000]       │
│                 ↑ clickable     ↑ clickable      ↑ display only      │
├──────────────────────────────────────────────────────────────────────┤
│ Controls Row:                                                        │
│   [Filter by column ▾]  [🔤 Wrap]  [Clear Filters] (when active)    │
├──────────────────────────────────────────────────────────────────────┤
│ VirtualizedDiffGrid (with resizable columns)                         │
│   ┌────────┬─────────┬──────────┬──────────┐                        │
│   │ Status │ email   │ name     │ age      │  ← drag borders        │
│   ├────────┼─────────┼──────────┼──────────┤                        │
│   │ ADDED  │ a@b.com │ Alice    │ 30       │                        │
│   │ ...    │         │          │          │                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Critical Files

| File | Changes |
|------|---------|
| `src/stores/diffStore.ts` | Add columnWidths, wordWrapEnabled, statusFilter, columnFilter state + actions |
| `src/components/diff/VirtualizedDiffGrid.tsx` | Column resize, word wrap, filter integration |
| `src/components/diff/DiffSummaryPills.tsx` | Convert to clickable toggle buttons |
| `src/components/diff/DiffView.tsx` | Add controls row with word wrap toggle and column dropdown |
| `src/lib/diff-engine.ts` | Add `getRowsWithColumnChanges()` query function |

---

## Reference Patterns

| Feature | Source File | Key Lines |
|---------|-------------|-----------|
| Column resize handler | `DataGrid.tsx` | 1236-1243 |
| Word wrap row heights | `DataGrid.tsx` | 1293-1311 |
| Word wrap toggle button | `App.tsx` | 338-352 |
| Column width constants | `column-sizing.ts` | 132-134 |

---

## Verification

1. **Column width**: Drag column borders, verify widths persist during scroll
2. **Word wrap**: Toggle, verify tall cells wrap content, check grid remount
3. **Status pills**: Click pills, verify multi-select works, verify row counts update
4. **Column filter**: Select column, verify only rows with changes in that column appear
5. **Combined filters**: Status + column filters work together (intersection)
