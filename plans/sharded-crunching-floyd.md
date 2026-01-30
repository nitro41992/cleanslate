# Plan: Fix DATE/TIMESTAMP Display After Cast Type

## Problem

After casting a column to DATE or TIMESTAMP, the grid displays raw milliseconds (e.g., `1704067200000`) instead of formatted dates (e.g., `2024-01-01 00:00:00`). Users expect:

1. **Display**: Nicely formatted datetime values in the grid
2. **Filtering**: Native datetime comparison (not string comparison)

## Root Cause Analysis

The formatting and filtering logic already exist and work correctly:
- `formatValueByType()` in `DataGrid.tsx:233-301` handles DATE → `YYYY-MM-DD` and TIMESTAMP → `YYYY-MM-DD HH:MM:SS`
- `buildFilterCondition()` in `filter-builder.ts` uses native SQL date types for filtering

### Root Cause: Column Types Hardcoded to VARCHAR on Import

**Location**: `src/hooks/useDuckDB.ts:231-235`

```typescript
const columns: ColumnInfo[] = result.columns.map((name) => ({
  name,
  type: 'VARCHAR',  // ❌ Always VARCHAR regardless of actual data!
  nullable: true,
}))
```

This means:
1. On import, ALL columns are typed as VARCHAR in the store
2. Even after DuckDB schema changes (via cast_type), the grid may use stale types
3. `formatValueByType()` sees `columnType = 'VARCHAR'` and just does `String(value)` → shows milliseconds

### Secondary Issue: Column Types Not Refreshed After Transforms

After `cast_type` runs:
1. The SQL converts the column to DATE/TIMESTAMP in DuckDB ✓
2. `ctx.db.getTableColumns()` returns the new type ✓
3. `executor.updateTableStore()` is called with new columns ✓
4. BUT: Need to verify the store update propagates to DataGrid

## Implementation Plan

### Step 1: Fix Import to Use Actual DuckDB Column Types

**File**: `src/hooks/useDuckDB.ts`

After table creation, query `information_schema.columns` to get actual types:

```typescript
// Instead of hardcoding VARCHAR:
const columns: ColumnInfo[] = await getTableColumns(tableName)
```

This ensures:
- Numeric columns show as BIGINT/DOUBLE (not VARCHAR)
- DATE/TIMESTAMP columns from Parquet are correctly typed
- Filter UI shows correct operators (numeric vs text)

### Step 2: Verify Cast Type Updates Column Types

**File**: `src/lib/commands/transform/tier3/cast-type.ts`

The command already returns updated columns at line 159. Verify this flows correctly by:
1. Adding a debug log before returning to confirm types
2. Checking that `updateTableStore()` receives the columns

### Step 3: Add Column Schema Refresh After Parquet Restore

**File**: `src/hooks/usePersistence.ts`

When restoring from OPFS on page load, the column types come from `app-state.json` which may have stale types. After loading each table:

```typescript
// After importTableFromParquet completes:
const freshColumns = await getTableColumns(tableName)
tableStore.updateTable(tableId, { columns: freshColumns })
```

### Step 4: Ensure Timeline Restore Refreshes Column Types

**File**: `src/lib/commands/timeline-engine.ts`

After snapshot restore (undo), refresh column types from DuckDB:

```typescript
// In undoTimeline() after table restore:
const freshColumns = await db.getTableColumns(tableName)
return { ...result, columns: freshColumns }
```

## Files to Modify

| File | Change |
|------|--------|
| `src/hooks/useDuckDB.ts` | Line 231-235: Query actual column types instead of hardcoding VARCHAR |
| `src/hooks/usePersistence.ts` | Refresh column types after Parquet restore |
| `src/lib/commands/timeline-engine.ts` | Return fresh column types after undo |

## Verification Plan

1. **Import Test**: Import CSV with numeric column containing milliseconds → should show as BIGINT
2. **Cast Test**: Cast BIGINT column to TIMESTAMP → grid should show formatted datetime
3. **Persistence Test**: Cast, refresh page → format should persist
4. **Undo Test**: Cast, apply another transform, undo → format should persist
5. **Filter Test**: Filter on TIMESTAMP column → should offer date operators (before, after, between)
