# Dynamic Column Width System for DataGrid

## Problem Statement

The current DataGrid uses fixed 150px column widths, causing:
- Long text content to be clipped without word wrap
- Column headers with type info (e.g., "email (VARCHAR)") to be truncated
- Poor space utilization for narrow content (IDs, booleans)
- No user control over column sizing

Must work efficiently with 1M+ rows using existing virtualization.

## Solution Overview

Implement a three-tier column width system:
1. **Type-based defaults** - Intelligent initial widths per DuckDB type
2. **Content sampling** - Auto-size from first N visible rows (Glide's built-in)
3. **User overrides** - Drag-to-resize with persistence

## Implementation Plan

### Phase 1: Type-Aware Default Widths

**File:** `src/components/grid/DataGrid.tsx`

Replace fixed `width: 150` with type-based defaults:

```typescript
const TYPE_WIDTH_DEFAULTS: Record<string, { min: number; default: number; max: number }> = {
  'INTEGER': { min: 60, default: 90, max: 150 },
  'BIGINT': { min: 80, default: 110, max: 180 },
  'DOUBLE': { min: 80, default: 120, max: 180 },
  'DECIMAL': { min: 80, default: 120, max: 180 },
  'VARCHAR': { min: 100, default: 180, max: 400 },
  'DATE': { min: 100, default: 120, max: 140 },
  'TIMESTAMP': { min: 140, default: 180, max: 200 },
  'BOOLEAN': { min: 60, default: 80, max: 100 },
  'DEFAULT': { min: 80, default: 150, max: 300 },
}
```

Update `gridColumns` useMemo to use type-based widths.

---

### Phase 2: User Column Resizing

**File:** `src/components/grid/DataGrid.tsx`

Add Glide Data Grid's resize props (verified from API):

```typescript
<DataGridLib
  // ... existing props
  onColumnResize={handleColumnResize}      // Emitted during drag
  onColumnResizeEnd={handleColumnResizeEnd} // Emitted when drag ends
  minColumnWidth={60}                       // Prevent too-narrow columns
  maxColumnWidth={500}                      // Prevent runaway widths
  maxColumnAutoWidth={400}                  // Cap auto-sizing
/>
```

Implement resize handlers:

```typescript
const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})

const handleColumnResize = useCallback((
  column: GridColumn,
  newSize: number
) => {
  setColumnWidths(prev => ({ ...prev, [column.id]: newSize }))
}, [])

const handleColumnResizeEnd = useCallback((
  column: GridColumn,
  newSize: number
) => {
  // Persist to preferences (debounced)
  persistColumnWidth(tableId, column.id, newSize)
}, [tableId])
```

---

### Phase 3: Column Width Persistence

**File:** `src/lib/persistence/column-preferences.ts` (new)

```typescript
interface ColumnPreferences {
  widths: Record<string, number>
  wordWrap: Record<string, boolean>
}

export async function saveColumnPreferences(
  tableId: string,
  prefs: ColumnPreferences
): Promise<void>

export async function loadColumnPreferences(
  tableId: string
): Promise<ColumnPreferences | null>
```

Store in `app-state.json` under `tables[tableId].columnPreferences`.

**File:** `src/types/index.ts`

Add `columnPreferences` to TableInfo interface (line 12, after columnOrder):

```typescript
export interface TableInfo {
  // ... existing fields
  columnOrder?: string[]
  columnPreferences?: ColumnPreferences  // NEW: User width/wrap settings
}

export interface ColumnPreferences {
  widths: Record<string, number>       // column name → px width
  wordWrap?: Record<string, boolean>   // column name → wrap enabled
}
```

**File:** `src/stores/tableStore.ts`

Add methods to update column preferences in store.

---

### Phase 4: Header Type Badge (Non-Clipping)

**File:** `src/components/grid/DataGrid.tsx`

Use Glide's `drawHeader` prop for custom header rendering:

```typescript
const drawHeader = useCallback((args: DrawHeaderCallbackArgs) => {
  const { ctx, column, rect, theme } = args
  const [name, typeStr] = column.title.split(' (')
  const type = typeStr?.replace(')', '') || ''

  // Draw column name (left-aligned, truncated if needed)
  ctx.fillStyle = theme.textHeader
  ctx.font = '13px system-ui'
  const nameWidth = rect.width - 70 // Reserve space for type badge
  drawTextWithEllipsis(ctx, name, rect.x + 8, rect.y + rect.height/2, nameWidth)

  // Draw type badge (right-aligned, always visible)
  if (type) {
    const badgeX = rect.x + rect.width - 60
    drawTypeBadge(ctx, type, badgeX, rect.y + 6)
  }

  return true // We handled the drawing
}, [])
```

Type badge styling:
- Pill shape with subtle background
- Color-coded by type category (numeric=blue, text=green, date=purple, etc.)
- Fixed 50px width, always visible

---

### Phase 5: Word Wrap Toggle (Optional Enhancement)

**File:** `src/components/grid/DataGrid.tsx`

Add dynamic row height support:

```typescript
const getRowHeight = useCallback((row: number) => {
  if (!wordWrapEnabled) return 34 // Default fixed height

  // Calculate based on content length in wrapped columns
  const maxLines = Math.min(getMaxLinesForRow(row), 4) // Cap at 4 lines
  return 34 + (maxLines - 1) * 18
}, [wordWrapEnabled])
```

Add word wrap toggle to column header context menu (future enhancement).

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/grid/DataGrid.tsx` | Add resize handlers, type-based widths, custom header drawing |
| `src/types/index.ts` | Add `columnPreferences` to TableInfo |
| `src/stores/tableStore.ts` | Add column preferences state management |
| `src/lib/persistence/state-persistence.ts` | Include column preferences in save/restore |

## New Files

| File | Purpose |
|------|---------|
| `src/lib/persistence/column-preferences.ts` | Column width/wrap preference utilities |
| `src/components/grid/column-sizing.ts` | Type-based width defaults and calculations |

---

## Verification Plan

### Manual Testing
1. Load a table with mixed column types (VARCHAR, INTEGER, DATE, BOOLEAN)
2. Verify columns have appropriate default widths by type
3. Drag column edges to resize - verify smooth interaction
4. Refresh page - verify resized widths persist
5. Load 100k+ row dataset - verify resize remains responsive
6. Check header type badges are always visible (not clipped)

### E2E Tests
Add tests in `e2e/tests/column-sizing.spec.ts`:
- Column resize via drag interaction
- Width persistence across page refresh
- Type-based default width verification

### Performance Validation
- Resize should not trigger full data re-fetch
- No perceptible lag when resizing with 1M+ rows loaded
- Memory usage stable during resize operations

---

## Implementation Order

1. **Phase 1**: Type-aware defaults (quick win, immediate visual improvement)
2. **Phase 2**: User resize handlers (core UX improvement)
3. **Phase 3**: Persistence (complete the resize feature)
4. **Phase 4**: Custom header rendering (polish, prevents clipping)
5. **Phase 5**: Word wrap (optional, can defer)

Estimated scope: Phases 1-4 are core, Phase 5 is enhancement.

---

## Research Sources

- [Glide Data Grid API](https://github.com/glideapps/glide-data-grid/blob/main/packages/core/API.md) - Official props reference
- [Auto column sizing issue #181](https://github.com/glideapps/glide-data-grid/issues/181) - Implementation details
- [AG Grid Column Sizing](https://www.ag-grid.com/react-data-grid/column-sizing/) - Best practices for large datasets
- [MUI X Data Grid Dimensions](https://mui.com/x/react-data-grid/column-dimensions/) - Flex-based approach
