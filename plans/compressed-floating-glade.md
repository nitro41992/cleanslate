# Plan: Add Row Numbers to Diff View

## Status: COMPLETED ✓

### Implementation Complete
Row numbers are now displayed in the diff grid. All diff tests pass (13/14 tests, 1 skipped for unrelated reason).

### Bug Investigation Results
The reported bug (1000 added, 1000 removed instead of 1 modified) was investigated:
1. Added debug logging to verify column lists include matching columns
2. Created E2E test with 1000 rows to verify behavior
3. Test passed - diff correctly showed: 1 modified, 999 unchanged, 0 added, 0 removed
4. The bug may have been a transient issue or already fixed by prior changes

---

## Original Summary
Add row number display to the diff grid so users can correlate diff results with the main data preview grid. Row numbers will show the current table's **visual row position** for added/modified rows, and "-" for deleted rows.

## Requirements
- Show row number from **current table (B)** in the diff grid ✓
- Display in first column (left side of grid) ✓
- Added rows: show row number ✓
- Deleted rows: show dash "-" ✓

## Implementation Summary

### Changes Made

**File: `src/lib/diff-engine.ts`**
1. Added `b_row_num` to `DiffRow` interface (line 237-238)
2. Added `b._row_num as b_row_num` to narrow diff table creation (line 758)
3. Added `d.b_row_num` to all pagination queries:
   - `fetchDiffPage` (lines 1033, 1074, 1098)
   - `fetchDiffPageWithKeyset` (lines 1187, 1197, 1267, 1290)
4. Added `b_row_num` to materialized index table (lines 1503, 1517)

**File: `src/components/diff/VirtualizedDiffGrid.tsx`**
1. Added "Row #" column as first column in `gridColumns` (lines 226-231)
2. Updated `getCellContent` to handle row number column at col 0 (lines 537-548)
3. Updated column index offset calculation: `statusColOffset = blindMode ? 1 : 2` (line 552-553)
4. Added custom `drawCell` styling for row number column (lines 639-654)
5. Updated status column handling to col 1 (line 657)
6. Updated data column index offset to col - 2 (line 672)

## Verification

All diff tests pass:
```bash
npx playwright test "diff" --timeout=90000 --retries=0 --reporter=line
# 13 passed (1 skipped)
```

Key test coverage:
- Diff with row insertion: Correctly shows only actual changes
- Diff with manual cell edits: Correctly detects edits in preview mode
- Compare Two Tables mode: Correctly identifies added/removed/modified rows
- 100-row regression test: Verifies correct diff summary
- 1000-row stress test: Verified correct behavior (1 modified, 999 unchanged)
