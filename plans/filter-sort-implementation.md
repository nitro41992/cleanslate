# Plan: Data Grid Filtering & Sorting

**Status: ✅ COMPLETED**

## Summary

Added filtering and sorting capabilities to the data preview grid. Filters are **view operations** (not data mutations) - they modify SQL queries, not underlying data. This follows the same pattern as `columnPreferences` (widths, word wrap).

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

## Implementation Completed

### Phase 1: Types & State ✅

**File: `src/types/index.ts`** - Added:
- `FilterOperator` - Union type for all filter operations
- `ColumnFilter` - Individual filter configuration
- `TableViewState` - Filter/sort state container
- Extended `TableInfo` with optional `viewState` field

**File: `src/stores/tableStore.ts`** - Added actions:
- `setFilter(tableId, filter)` - Add/update filter on column
- `removeFilter(tableId, column)` - Remove specific filter
- `clearFilters(tableId)` - Clear all filters
- `setSort(tableId, column, direction)` - Set sort configuration
- `clearViewState(tableId)` - Clear all view state
- `getViewState(tableId)` - Get current view state

### Phase 2: SQL Query Builder ✅

**File: `src/lib/duckdb/filter-builder.ts`**
- `buildWhereClause(filters)` - Generates SQL WHERE conditions
- `buildOrderByClause(sortColumn, direction)` - Generates ORDER BY with NULLS LAST
- `getFilterCategory(duckdbType)` - Maps DuckDB types to filter categories
- `getOperatorsForCategory(category)` - Returns valid operators per type
- `formatFilterForDisplay(filter)` - Human-readable filter description

### Phase 3: Data Layer Integration ✅

**File: `src/lib/duckdb/index.ts`**
- Extended `KeysetCursor` with `whereClause` and `orderByClause`
- Updated `getTableDataWithKeyset()` to apply filter/sort SQL
- Added `getFilteredRowCount()` for displaying filtered counts

**File: `src/hooks/useDuckDB.ts`**
- Added `getFilteredDataWithKeyset()` method
- Added `getFilteredCount()` method

### Phase 4: UI Components ✅

**File: `src/components/grid/filters/ColumnHeaderMenu.tsx`**
- Dropdown triggered by clicking column header
- Sort Ascending/Descending options
- Filter input (type-specific via FilterFactory)
- Apply/Clear buttons

**File: `src/components/grid/filters/FilterFactory.tsx`**
- Returns correct filter component based on column type
- Text filter: dropdown + text input
- Numeric filter: dropdown + number input(s)
- Date filter: date picker(s) + relative options
- Boolean filter: radio buttons

**File: `src/components/grid/filters/ActiveFiltersBar.tsx`**
- Shows active filters as dismissible badges
- Displays filtered row count vs total
- Clear All button

**File: `src/components/grid/DataGrid.tsx`**
- Integrated header click handler for ColumnHeaderMenu
- Reads viewState for data fetching with filters/sort
- Shows sort indicators (↑↓) in column titles
- Displays ActiveFiltersBar when filters active
- Uses effective row count for grid rendering

### Phase 5: E2E Tests ✅

**File: `e2e/tests/filter-sort.spec.ts`**
- 7 tests passing
- Text filter tests (contains operator)
- Sort tests (ascending, descending)
- Combined filter and sort tests
- Filter clear operations (all filters, sort, view state)

---

## Files Created

| File | Purpose |
|------|---------|
| `src/lib/duckdb/filter-builder.ts` | SQL WHERE/ORDER BY generation |
| `src/components/grid/filters/ColumnHeaderMenu.tsx` | Header dropdown menu |
| `src/components/grid/filters/ActiveFiltersBar.tsx` | Filter badges display |
| `src/components/grid/filters/FilterFactory.tsx` | Filter component factory |
| `src/components/grid/filters/index.ts` | Module exports |
| `e2e/tests/filter-sort.spec.ts` | E2E tests |

## Files Modified

| File | Changes |
|------|---------|
| `src/types/index.ts` | Added `ColumnFilter`, `FilterOperator`, `TableViewState` types |
| `src/stores/tableStore.ts` | Added filter/sort actions |
| `src/lib/duckdb/index.ts` | Accept WHERE/ORDER BY in keyset query |
| `src/hooks/useDuckDB.ts` | Added filtered data methods |
| `src/components/grid/DataGrid.tsx` | Integrated header menu, filters bar, sort indicators |

---

## Edge Cases Handled

1. **Empty results**: Filtered count shows "0 of N rows"
2. **NULL handling**: `is_empty` includes both NULL and empty string via SQL `(col IS NULL OR col = '')`
3. **NULLS LAST**: Sort always uses NULLS LAST for predictable ordering
4. **SQL injection**: Values escaped via `escapeStringValue()` and `escapeLikePattern()`
5. **Case insensitivity**: Text filters use ILIKE for case-insensitive matching

---

## Verification

### Manual Testing
- [x] Upload CSV with mixed data types
- [x] Apply text filter (contains) → verify only matching rows shown
- [x] Apply numeric filter (>) → verify correct filtering
- [x] Apply sort → verify order changes with ↑↓ indicator
- [x] Clear filters → verify all rows return
- [x] View state persists with table preferences

### E2E Tests
```bash
npx playwright test "filter-sort.spec.ts" --timeout=120000 --retries=0 --reporter=line
# 7 passed (15.3s)
```

### Build Verification
```bash
npm run build  # ✅ Successful
npm run lint   # ✅ No new errors in filter/sort files
```
