# Fix: Table Switching Race Conditions

## Problem Summary

When switching between tables or deleting tables, components throw errors like:
```
Error: Catalog Error: Table with name messy_HR_data does not exist!
```

### Root Causes

1. **ScrubPreview uses stale `tableName`**: The `scrubberStore` maintains its own `tableName` which doesn't update when the user switches tables via `TableSelector`. During the freeze/thaw process, the old table is dropped from DuckDB but `ScrubPreview` still tries to query it.

2. **Components don't check `isContextSwitching`**: The `tableStore` has an `isContextSwitching` flag, but components like `ScrubPreview` and `DataGrid` don't check it before making DuckDB queries.

3. **Panel stores hold stale references**: When tables switch, feature panel stores (`scrubberStore`, `standardizerStore`, etc.) retain their old table references and continue trying to query non-existent tables.

## Files to Modify

1. `src/components/scrub/ScrubPreview.tsx` - Add `isContextSwitching` guard
2. `src/components/grid/DataGrid.tsx` - Add `isContextSwitching` guard
3. `src/components/panels/ScrubPanel.tsx` - Reset state when active table changes
4. `src/features/standardizer/StandardizeView.tsx` - Add `isContextSwitching` guard

## Implementation Plan

### Step 1: Add `isContextSwitching` guard to ScrubPreview

In `src/components/scrub/ScrubPreview.tsx`, add a check before querying:

```typescript
// Import at top
import { useTableStore } from '@/stores/tableStore'

// Inside component
const isContextSwitching = useTableStore((s) => s.isContextSwitching)

// In useEffect, add early return
if (isContextSwitching) {
  console.log('[ScrubPreview] Skipping fetch - context switch in progress')
  return
}
```

### Step 2: Add `isContextSwitching` guard to DataGrid

In `src/components/grid/DataGrid.tsx` around line 1220, add the guard:

```typescript
// Already has access to isContextSwitching via props or store
// Add check before data fetch in useEffect
if (isContextSwitching) {
  console.log('[DATAGRID] Skipping fetch - context switch in progress')
  return
}
```

### Step 3: Reset ScrubPanel state on table switch

In `src/components/panels/ScrubPanel.tsx`, add effect to clear scrubber state when active table changes:

```typescript
const activeTableId = useTableStore((s) => s.activeTableId)

useEffect(() => {
  // When active table changes, reset scrubber state
  if (tableId && tableId !== activeTableId) {
    setTable(null, null) // Clear scrubberStore state
  }
}, [activeTableId, tableId, setTable])
```

### Step 4: Add `isContextSwitching` guard to StandardizeView

Similar to ScrubPreview, add the guard before any DuckDB queries in StandardizeView.

## Verification

1. Load multiple tables into CleanSlate
2. Open the Scrub panel and select a column
3. Switch between tables rapidly using TableSelector
4. Verify no console errors about missing tables
5. Delete a table and verify no errors appear

## Alternative Considered

Could add try-catch around all DuckDB queries, but this would hide legitimate errors. The guard approach is more precise and maintains proper error visibility for actual bugs.
