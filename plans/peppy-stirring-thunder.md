# Fix: Table Switching Race Conditions

## Problem Summary

When switching between tables or deleting tables, components throw errors like:
```
Error: Catalog Error: Table with name messy_HR_data does not exist!
```

### Root Causes

1. **Components query frozen tables**: When switching tables, the old table is "frozen" (dropped from DuckDB memory) before `activeTableId` updates. Components that use `tableName` from stores (like `scrubberStore`) or props try to query tables that no longer exist in DuckDB.

2. **`isContextSwitching` flag not checked**: The `tableStore` has an `isContextSwitching` flag that's `true` during freeze/thaw, but components don't check it before making DuckDB queries.

3. **Panel stores hold stale references**: Feature stores (`scrubberStore`, `standardizerStore`) maintain their own `tableId`/`tableName` that don't automatically update when the active table changes.

### Affected Components

Components that query DuckDB with `tableName` and need guards:
- `src/components/scrub/ScrubPreview.tsx` - `getData(tableName, ...)`
- `src/components/grid/DataGrid.tsx` - `getDataArrowWithKeyset(tableName, ...)`
- `src/features/scrubber/ScrubberPage.tsx` - `getData(tableName, ...)`

## Implementation Plan

### Step 1: Add `isContextSwitching` guard to ScrubPreview

**File**: `src/components/scrub/ScrubPreview.tsx`

Add guard before the debounced query:

```typescript
// Add import
import { useTableStore } from '@/stores/tableStore'

// Inside component, add subscription
const isContextSwitching = useTableStore((s) => s.isContextSwitching)

// In useEffect (around line 75), add early return BEFORE setIsLoading(true)
if (isContextSwitching) {
  setPreview(null)
  setIsLoading(false)
  return
}
```

### Step 2: Add `isContextSwitching` guard to DataGrid

**File**: `src/components/grid/DataGrid.tsx`

Add guard in the data loading useEffect (around line 1189):

```typescript
// Add store subscription near other hooks
const isContextSwitching = useTableStore((s) => s.isContextSwitching)

// In useEffect, add check after isBusy check (around line 1226)
// Don't fetch during context switch - table may be frozen
if (isContextSwitching) {
  console.log('[DATAGRID] Skipping fetch - context switch in progress')
  return
}
```

### Step 3: Add `isContextSwitching` guard to ScrubberPage

**File**: `src/features/scrubber/ScrubberPage.tsx`

Add guard in `handlePreview` and `handleApply` functions:

```typescript
const isContextSwitching = useTableStore((s) => s.isContextSwitching)

// In handlePreview, add early check
if (!tableName || rules.length === 0 || isContextSwitching) return

// In handleApply, add early check
if (!tableId || !tableName || rules.length === 0 || isContextSwitching) return
```

## Verification

1. Run dev server: `npm run dev`
2. Load two CSV files to create multiple tables
3. Open the Scrub panel and select a column for obfuscation
4. Rapidly switch between tables using the table dropdown
5. Verify no console errors about "Table does not exist"
6. Delete one of the tables
7. Verify no errors appear after deletion

## Files Changed

| File | Change |
|------|--------|
| `src/components/scrub/ScrubPreview.tsx` | Add `isContextSwitching` guard |
| `src/components/grid/DataGrid.tsx` | Add `isContextSwitching` guard |
| `src/features/scrubber/ScrubberPage.tsx` | Add `isContextSwitching` guard |
