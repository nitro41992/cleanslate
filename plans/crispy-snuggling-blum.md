# Fix: Merge Duplicates deletes both "keep" and "remove" rows

## Context

When using the Matcher to merge duplicate pairs, ALL matched rows are being deleted — including the ones marked as "keep". The Diff view confirms: 48 rows removed, 0 added, meaning both sides of each duplicate pair were deleted.

**Root cause:** The deletion SQL in `mergeDuplicates()` uses the **match column value** to identify which row to delete:

```sql
DELETE FROM "table" WHERE "employee_name" = 'Lacey Mckinney'
```

Since duplicates are found *because* they share similar/identical values in the match column, this WHERE clause matches **both** the keep and remove rows, deleting them all.

## Fix

**File:** `src/lib/fuzzy-matcher.ts` — lines 1223-1237

Change the DELETE to use `_cs_id` (the unique row identifier that exists on every table) instead of the match column:

**Before:**
```typescript
const rowToDelete = pair.keepRow === 'A' ? pair.rowB : pair.rowA
const keyValue = rowToDelete[keyColumn]
if (keyValue !== null && keyValue !== undefined) {
  await query(
    `DELETE FROM "${tableName}" WHERE "${keyColumn}" = '${String(keyValue).replace(/'/g, "''")}'`
  )
}
```

**After:**
```typescript
const rowToDelete = pair.keepRow === 'A' ? pair.rowB : pair.rowA
const csId = rowToDelete[CS_ID_COLUMN]
if (csId !== null && csId !== undefined) {
  await query(
    `DELETE FROM "${tableName}" WHERE "${CS_ID_COLUMN}" = ${Number(csId)}`
  )
}
```

This also requires adding the `CS_ID_COLUMN` import at the top of the file:
```typescript
import { CS_ID_COLUMN } from '@/lib/duckdb'
```

### Why `_cs_id` is safe
- Every table gets a `_cs_id` column on import (via `snapshot-storage.ts`)
- `getTableColumns()` returns all columns including `_cs_id`, so `rowA`/`rowB` in MatchPair already contain it
- `_cs_id` is unique per row — the DELETE will target exactly one row

## Verification

1. Upload `fuzzy_duplicate_claims_dataset` (or similar file with duplicates)
2. Run the Matcher on a column (e.g., `employee_name`)
3. Mark several pairs as merged (keep one, remove the other)
4. Click "Apply Merges"
5. Open Diff view — should show N rows REMOVED (only the "remove" side), 0 ADDED, rest SAME
6. Verify the "keep" rows are still in the table with correct data
