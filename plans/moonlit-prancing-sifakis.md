# Plan: Data Grid Filtering & Sorting

## Summary

Add filtering and sorting capabilities to the data preview grid. Filters are **view operations** (not data mutations) - they modify SQL queries, not underlying data. This follows the same pattern as `columnPreferences` (widths, word wrap).

## Industry Standard Approach

Based on research ([MUI X Data Grid](https://mui.com/x/react-data-grid/filtering/), [AG Grid](https://www.ag-grid.com/javascript-data-grid/filtering/), [KendoReact](https://www.telerik.com/kendo-react-ui/components/grid/filtering/)), the standard pattern is:

1. **Column header dropdown menu** with sort options + filter input
2. **Type-specific filter operators**:
   - Text: contains, equals, starts with, ends with, is empty
   - Numeric: =, >, <, >=, <=, between
   - Date: equals, before, after, between, last N days
   - Boolean: true, false, is empty
3. **Active filters bar** showing dismissible badges above grid
4. **Sort indicators** (↑↓) in column headers

## Architecture

### Key Insight: VIEW Operations, Not Commands

Filtering/sorting do **not**:
- Modify DuckDB tables
- Create audit log entries
- Affect undo/redo history

They **do**:
- Modify SQL WHERE/ORDER BY clauses
- Persist as UI preferences (like column widths)
- Reset when clearing or on user action

---

## Implementation Plan

### Phase 1: Types & State (Foundation)

**File: `src/types/index.ts`** - Add new interfaces:

```typescript
export type FilterOperator =
  // Text
  | 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'is_empty' | 'is_not_empty'
  // Numeric
  | 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'between'
  // Date
  | 'date_eq' | 'date_before' | 'date_after' | 'date_between' | 'last_n_days'
  // Boolean
  | 'is_true' | 'is_false'

export interface ColumnFilter {
  column: string
  operator: FilterOperator
  value: string | number | boolean | null
  value2?: string | number  // For "between" operators
}

export interface TableViewState {
  filters: ColumnFilter[]
  sortColumn: string | null
  sortDirection: 'asc' | 'desc'
}
```

**File: `src/types/index.ts`** - Extend `TableInfo`:

```typescript
export interface TableInfo {
  // ... existing fields
  viewState?: TableViewState  // Filter/sort configuration
}
```

**File: `src/stores/tableStore.ts`** - Add actions:

```typescript
// New actions
setFilter: (tableId: string, filter: ColumnFilter) => void
removeFilter: (tableId: string, column: string) => void
clearFilters: (tableId: string) => void
setSort: (tableId: string, column: string | null, direction: 'asc' | 'desc') => void
clearViewState: (tableId: string) => void
```

---

### Phase 2: SQL Query Builder

**New File: `src/lib/duckdb/filter-builder.ts`**

Utility to convert filters/sort to SQL clauses:

```typescript
export function buildWhereClause(filters: ColumnFilter[], columnTypes: Map<string, string>): string
export function buildOrderByClause(sortColumn: string | null, sortDirection: 'asc' | 'desc'): string
export async function getFilteredRowCount(tableName: string, whereClause: string): Promise<number>
```

Key implementation details:
- Use `ILIKE` for case-insensitive text matching
- Handle NULLs: `is_empty` = `(col IS NULL OR col = '')`
- Use `NULLS LAST` in ORDER BY for predictable sorting
- Escape values properly to prevent SQL injection

---

### Phase 3: Data Layer Integration

**File: `src/lib/duckdb/index.ts`** - Modify `getTableDataWithKeyset`:

```typescript
export interface FilteredKeysetCursor extends KeysetCursor {
  whereClause?: string
  orderByClause?: string
}
```

**File: `src/hooks/useDuckDB.ts`** - Add filtered data method:

```typescript
const getFilteredDataWithKeyset = useCallback(
  async (tableName, cursor, limit, filters, sortColumn, sortDirection, columnTypes) => {
    const whereClause = buildWhereClause(filters, columnTypes)
    const orderByClause = buildOrderByClause(sortColumn, sortDirection)
    return getTableDataWithKeyset(tableName, { ...cursor, whereClause, orderByClause }, limit)
  },
  []
)
```

---

### Phase 4: UI Components

**New File: `src/components/grid/ColumnHeaderMenu.tsx`**

Dropdown menu triggered by clicking column header:
- Sort Ascending / Sort Descending options
- Divider
- Filter input (type-specific based on column type)
- Apply / Clear buttons

**New Files: `src/components/grid/filters/`**

```
filters/
  TextFilter.tsx      # Dropdown for operator + text input
  NumericFilter.tsx   # Dropdown for operator + number input(s)
  DateFilter.tsx      # Date picker(s) + relative options
  BooleanFilter.tsx   # True/False/Empty radio buttons
  FilterFactory.tsx   # Returns correct component based on column type
```

**New File: `src/components/grid/ActiveFiltersBar.tsx`**

Shows active filters as dismissible badges:
```
[name contains "John" ×] [age > 30 ×] [Clear All]
```

**File: `src/components/grid/DataGrid.tsx`** - Integrate:

1. Add header click handler to open `ColumnHeaderMenu`
2. Read `viewState` from table and pass to data fetching
3. Add sort indicators to column headers
4. Show `ActiveFiltersBar` when filters active
5. Show empty state when filtered results = 0

---

### Phase 5: Persistence

Filter/sort state persists with other table preferences in `app-state.json`. The existing persistence system handles this automatically since `viewState` is part of `TableInfo`.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/lib/duckdb/filter-builder.ts` | SQL WHERE/ORDER BY generation |
| `src/components/grid/ColumnHeaderMenu.tsx` | Header dropdown menu |
| `src/components/grid/ActiveFiltersBar.tsx` | Filter badges display |
| `src/components/grid/filters/TextFilter.tsx` | Text column filter UI |
| `src/components/grid/filters/NumericFilter.tsx` | Numeric column filter UI |
| `src/components/grid/filters/DateFilter.tsx` | Date column filter UI |
| `src/components/grid/filters/BooleanFilter.tsx` | Boolean column filter UI |
| `src/components/grid/filters/FilterFactory.tsx` | Filter component factory |
| `e2e/tests/filter-sort.spec.ts` | E2E tests |

## Files to Modify

| File | Changes |
|------|---------|
| `src/types/index.ts` | Add `ColumnFilter`, `FilterOperator`, `TableViewState` types |
| `src/stores/tableStore.ts` | Add filter/sort actions |
| `src/lib/duckdb/index.ts` | Accept WHERE/ORDER BY in keyset query |
| `src/hooks/useDuckDB.ts` | Add `getFilteredDataWithKeyset` method |
| `src/components/grid/DataGrid.tsx` | Integrate header menu, filters bar, sort indicators |

---

## Edge Cases

1. **Empty results**: Show helpful message with "Clear Filters" button
2. **NULL handling**: `is_empty` includes both NULL and empty string
3. **Large datasets**: Debounce filter input (300ms), cache filtered count
4. **Performance**: Keyset pagination works with filters (O(1) at any depth)

---

## Verification

1. **Manual testing**:
   - Upload CSV with mixed data types
   - Apply text filter (contains) → verify only matching rows shown
   - Apply numeric filter (>) → verify correct filtering
   - Apply sort → verify order changes
   - Clear filters → verify all rows return
   - Refresh page → verify filters persist

2. **E2E tests**: `npm run test e2e/tests/filter-sort.spec.ts`

3. **Performance check**: Filter 100k row table, verify <200ms response
