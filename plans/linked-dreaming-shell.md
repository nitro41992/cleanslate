# Plan: Fix Diff Misalignment When Adding Rows

## Problem Statement

When a row is inserted in the middle of a table, the diff preview becomes inaccurate. All rows after the insertion point appear as "modified" because the diff uses `_cs_id` for matching, and `InsertRowCommand` shifts `_cs_id` values to make room for the new row.

**Example:**
- Original table: rows with `_cs_id` = 1, 2, 3, 4, 5
- Insert after row 2: row 3 becomes `_cs_id = 4`, row 4 becomes `_cs_id = 5`, etc.
- Snapshot still has original IDs: row 3 = `_cs_id = 3`
- Diff tries to match `a._cs_id = b._cs_id`:
  - Snapshot row 3 (`_cs_id=3`) matches current row 3 (the NEW empty row)
  - Snapshot row 4 (`_cs_id=4`) matches current row 4 (was originally row 3)
  - Result: Everything after insertion appears modified

## Root Cause

The diff engine (in `src/lib/diff-engine.ts`) uses two matching modes:
- **`two-tables`**: Uses user-selected key columns (works correctly)
- **`preview`**: Uses `_cs_id` matching (`a._cs_id = b._cs_id`) - **this is broken for row insertions**

The `_cs_id` is a **positional identifier** that changes when rows are inserted/deleted, not a **stable identity** for diff purposes.

## Recommended Solution: Add Stable Origin ID

Add a separate `_cs_origin_id` column that is a UUID assigned at import time and **never changes** - even when rows are inserted or deleted.

This is the industry-standard approach used by:
- [daff](https://github.com/paulfitz/daff) - uses `--id` flag for stable row identity
- [SQL Data Compare](https://documentation.red-gate.com/sdc/troubleshooting/unexpected-behavior-technical-questions/what-s-a-comparison-key) - requires comparison keys that uniquely identify rows
- [Beyond Compare](https://www.scootersoftware.com/v4help/sessiondataalignment.html) - offers key-based alignment for data comparison

### Implementation

#### 1. Add `_cs_origin_id` Column to Schema

**Files to modify:**
- `src/lib/duckdb/index.ts` - Add column at import time

```sql
-- At import time, assign both:
SELECT
  ROW_NUMBER() OVER () as "_cs_id",     -- For ordering (can change)
  gen_random_uuid() as "_cs_origin_id",  -- For identity (never changes)
  *
FROM read_csv_auto('file.csv')
```

#### 2. Update InsertRowCommand - Don't Touch Origin IDs

**File:** `src/lib/commands/data/insert-row.ts`

Currently shifts `_cs_id` for all subsequent rows. Change to:
- Continue shifting `_cs_id` for ordering
- Assign a NEW `_cs_origin_id` to the inserted row
- Do NOT modify existing rows' `_cs_origin_id`

#### 3. Update Diff Engine to Use Origin ID in Preview Mode

**File:** `src/lib/diff-engine.ts`

Change line 640-641:
```typescript
// FROM:
const diffJoinCondition = diffMode === 'preview'
  ? `a."_cs_id" = b."_cs_id"`

// TO:
const diffJoinCondition = diffMode === 'preview'
  ? `a."_cs_origin_id" = b."_cs_origin_id"`
```

#### 4. Handle Existing Tables (No Migration)

Tables created before this change won't have `_cs_origin_id`. Fall back to `_cs_id` matching for these tables (current behavior). New imports will get the fix automatically.

#### 5. Propagate Through Commands That Regenerate Tables

Commands that use `ROW_NUMBER() OVER ()` need to preserve `_cs_origin_id`:
- `src/lib/combiner-engine.ts` (stack/join operations)
- Tier 3 undo snapshots
- Any CTAS operations

---

## Alternative Approaches Considered

### A. Content-Based Matching (LCS/Myers Diff)
- Hash row content and find optimal alignment using Longest Common Subsequence
- **Rejected**: Too complex, slower for large tables, unclear results for duplicate rows

### B. Fractional IDs (No Shifting)
- Insert row between 5 and 6 gets `_cs_id = 5.5`
- **Rejected**: Eventually runs out of precision, complicates ordering

### C. Re-align Before Diff
- Detect insertions by analyzing content differences
- **Rejected**: Heuristic-based, unreliable, adds latency

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/duckdb/index.ts` | Add `_cs_origin_id` at import |
| `src/lib/commands/data/insert-row.ts` | Preserve origin IDs when inserting |
| `src/lib/commands/data/delete-row.ts` | No change needed (origin ID deleted with row) |
| `src/lib/diff-engine.ts` | Use `_cs_origin_id` for preview matching |
| `src/lib/combiner-engine.ts` | Preserve origin IDs in stack/join |
| `src/lib/opfs/snapshot-storage.ts` | Ensure snapshots include origin ID |

## Testing Plan

1. **Unit test**: Insert row, verify `_cs_origin_id` unchanged for other rows
2. **E2E test**: Insert row in middle, verify diff shows only 1 "added" row (not all subsequent as "modified")
3. **Migration test**: Open existing table without `_cs_origin_id`, verify graceful fallback

## Design Decisions

1. **Migration strategy**: New imports only. Existing tables will fall back to current `_cs_id` matching behavior.
2. **ID type**: UUID string (36-char format like `a1b2c3d4-e5f6-...`). Guaranteed unique, no collision risk.

## Verification

1. Import a CSV file
2. Insert a row in the middle (e.g., after row 3)
3. Apply an unrelated Tier 3 transform (triggers snapshot)
4. Open diff preview
5. **Expected**: Only 1 row shows as "added" (the new row). All other rows show as "unchanged"
6. **Current behavior**: All rows after insertion show as "modified"

---

## Implementation Status: COMPLETED ✓

### Summary of Changes

All planned changes have been implemented:

1. **`src/lib/duckdb/index.ts`** ✓
   - Added `CS_ORIGIN_ID_COLUMN` constant (`_cs_origin_id`)
   - Updated `filterInternalColumns()` to exclude `_cs_origin_id`
   - Updated `isInternalColumn()` to recognize `_cs_origin_id`
   - Added `tableHasOriginId()` helper function
   - Updated `loadCSV()`, `loadJSON()`, `loadParquet()`, `loadXLSX()` to add `_cs_origin_id` column with `gen_random_uuid()::VARCHAR`
   - Updated `duplicateTable()` to handle `_cs_origin_id` (preserves for snapshots, regenerates for user copies)

2. **`src/lib/commands/data/insert-row.ts`** ✓
   - Updated to assign new UUID to `_cs_origin_id` for inserted rows only
   - Existing rows' `_cs_origin_id` values are NOT modified (the fix!)
   - Backwards compatible with tables that don't have `_cs_origin_id`

3. **`src/lib/diff-engine.ts`** ✓
   - Updated to use `_cs_origin_id` for preview mode matching when both tables have it
   - Falls back to `_cs_id` matching for backwards compatibility with older tables
   - Added logging to show which matching column is being used

4. **`src/lib/combiner-engine.ts`** ✓
   - Updated `stackTables()` to regenerate both `_cs_id` and `_cs_origin_id`
   - Updated `joinTables()` to regenerate both `_cs_id` and `_cs_origin_id`
   - This is correct because combined tables create new row identities

### Test Results

All tests pass:
- ✓ 3 diff regression tests
- ✓ 6 file upload tests
- ✓ 3 combiner tests
- ✓ 6 data manipulation tests (including insert row above/below)
