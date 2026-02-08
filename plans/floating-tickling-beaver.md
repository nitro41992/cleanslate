# Fix: Empty grid when importing second table after diff close

## Context

When you import a large table (1M rows) while another table is already loaded, the grid shows column headers and the correct row count, but **all cells are empty**. The audit log confirms "0 rows" for the transform badge.

**Root cause**: A global `skipNextGridReload` flag in UIStore gets set when the diff view closes (its purpose is to prevent one unnecessary grid reload as the busy count drops). But when a new table is imported before the flag is consumed, the new table's DataGrid initial data fetch is incorrectly skipped — the flag was meant for the *previous* table, not the new one.

The log confirms this:
```
[DATAGRID] Skipping fetch - skipNextGridReload flag was set
```

## Fix (single file, ~6 lines)

**File**: `src/components/grid/DataGrid.tsx`

### Step 1: Add a ref to track the previous table name

Near the other refs (line ~469, after `skipNextReloadRef`):
```typescript
const prevTableNameRef = useRef(tableName)
```

### Step 2: Detect table change and clear stale skip flag

In the data-loading useEffect (line 1236), **before** the existing skip flag check (line 1239), add:

```typescript
// If the active table changed, any pending skip flag is stale — clear it
const tableChanged = tableName !== prevTableNameRef.current
if (tableChanged) {
  prevTableNameRef.current = tableName
  const pendingSkip = useUIStore.getState().skipNextGridReload
  if (pendingSkip) {
    useUIStore.getState().setSkipNextGridReload(false)
  }
}
```

### Step 3: Keep the ref in sync on non-table-change runs

At line 1256 (where `prevRowCountRef` is already updated), also sync the table name ref:
```typescript
prevRowCountRef.current = rowCount
prevTableNameRef.current = tableName
```

No other files change.

## Why this approach

| Scenario | `tableName` changed? | Skip flag | Result |
|---|---|---|---|
| Diff close, same table, `isBusy` drops | No | Consumed normally | Skip reload (correct, intended) |
| Import new table while flag set | Yes | Cleared as stale | Fetch data (correct, **the fix**) |
| Tab switch while flag set | Yes | Cleared as stale | Fetch data (correct) |
| Normal import, no flag | Yes | Already false | Fetch data (correct) |
| Transform after diff close | No | Cleared by executor L237 | Fetch data (correct) |

## Verification

1. `npm run build` — type check passes
2. Manual test: Load table A → open diff → close diff → import table B → grid should show data
3. Manual test: Load table A → import table B (no diff) → grid should show data
4. `npm run test` — E2E suite passes (especially diff and import tests)
