# Plan: Comprehensive E2E Regression Test Suite

## Context

Recent commits (bc14677, 3de42ec, 98e335b, c6218c8) fixed critical bugs:

### Fixed Issues:
1. **_cs_id lineage preservation** - remove_duplicates now uses `FIRST(_cs_id)` to maintain row identity
2. **OPFS file locking** - diff engine tracks registered Parquet snapshots to prevent "Access Handles cannot be created" errors
3. **Missing removed rows in preview mode** - uses _cs_id-based JOIN instead of key-based for "Compare with Preview"
4. **Internal column leakage** - filters `duckdb_schema`, `_cs_id`, `__base` from UI surfaces
5. **Memory optimization** - filters columns early in diff engine to reduce overhead
6. **Eager timeline init** - eliminates 3-second wait on first edit by creating snapshots during upload
7. **Binder errors on diff export** - dynamic ORDER BY detection for chunked Parquet files

### User's Test Goals:

**Goal 1:** Ensure we don't lose the "Original" state when doing manual edits
- Pass: Diff view opens instantly, no IO Error, no disabled button

**Goal 2:** Ensure system doesn't crash on large files or memory leaks
- Pass: Diff loads successfully (Binder/Parquet schema fixed), shows Added/Modified/Removed correctly

**Goal 3:** Ensure internal DuckDB metadata doesn't leak into UI
- Pass: No columns named `_cs_id`, `duckdb_schema`, `row_id` in UI or console errors

## Existing Test Coverage (122 tests across 10 files)

### Already Covered ✅:
- Basic diff functionality (FR-B2: Visual Diff)
- Compare with Preview mode (after single transformation)
- Compare Two Tables mode
- _cs_id exclusion from diff value comparison
- Audit + Undo/Redo features
- Memory optimization (5k rows)

### Gaps Identified ❌:

#### Gap 1: Original Snapshot Preservation (Goal 1)
- Missing: Multiple manual edits before diff
- Missing: Diff button enabled state verification
- Missing: No IO Error when opening diff after edits
- Missing: Instant diff open (no 3-second delay)

#### Gap 2: Large File & Memory Handling (Goal 2)
- Missing: remove_duplicates with large file (verify _cs_id lineage preserved)
- Missing: Diff with chunked Parquet snapshots (100k+ rows)
- Missing: All 3 diff statuses with large files (Added, Modified, Removed)
- Missing: No Binder Error (internal columns filtered from schema)
- Missing: File locking prevention on diff pagination
- Missing: Diff export with chunked Parquet (ORDER BY detection)

#### Gap 3: Internal Column Leakage (Goal 3)
- Missing: Grid columns don't show internal columns
- Missing: Transformation pickers don't show internal columns
- Missing: Diff grid doesn't show internal columns (except Status)
- Missing: Export CSV doesn't include internal columns
- Missing: Console errors don't leak internal columns
- Missing: Diff schema banner doesn't show internal columns

## Implementation Plan

### Test 1: Original Snapshot Preservation After Multiple Manual Edits
**File:** `e2e/tests/feature-coverage.spec.ts` (add to existing FR-B2 serial group)

**Purpose:** Verify Goal 1 - Original state persists through multiple manual edits

**Steps:**
1. Load basic-data.csv (5 rows)
2. Apply 3 manual edits (edit different cells)
3. Verify timeline has "Original" snapshot in store
4. Open Diff view
5. Verify diff button is enabled (not disabled)
6. Verify diff opens instantly (< 1 second, no 3-second delay)
7. Verify no IO Error in console
8. Switch to "Compare with Preview" mode
9. Run comparison (no key columns needed - uses _cs_id internally)
10. Verify diff shows 3 modified rows (the edited ones)

**High-Fidelity Assertions:**
- Assert specific row IDs are modified (Rule 1: identity, not cardinality)
- Assert exact previous/new values (Rule 2: positive assertions)
- Assert timeline store has `originalSnapshotName` property set
- Assert diff state `mode === 'compare-preview'`

---

### Test 2: _cs_id Lineage Preservation Through remove_duplicates (Large File)
**File:** `e2e/tests/transformations.spec.ts` (add to existing serial group)

**Purpose:** Verify Goal 2 - remove_duplicates preserves row identity for diff matching

**Steps:**
1. Generate CSV with duplicates (10k rows, 3k unique after dedup)
2. Upload and import
3. Query `_cs_id` values before transformation (sample 10 rows)
4. Run remove_duplicates transformation
5. Query `_cs_id` values after transformation
6. Verify remaining rows have SAME `_cs_id` as before (FIRST aggregation preserved them)
7. Open Diff view → Compare with Preview
8. Verify diff shows 7,000 "REMOVED" rows (not "ADDED" due to broken lineage)
9. Verify diff shows 0 "ADDED" rows
10. Verify diff shows 0 "MODIFIED" rows (dedup doesn't change values)

**High-Fidelity Assertions:**
- Assert `_cs_id` values match before/after for kept rows (Rule 1)
- Assert exact removed count = 7,000 (not just `> 0`)
- Assert Added = 0, Modified = 0 (Rule 2: exact states)

---

### Test 3: Diff with Chunked Parquet Snapshots (100k+ Rows)
**File:** `e2e/tests/memory-optimization.spec.ts` (add to existing serial group)

**Purpose:** Verify Goal 2 - Chunked Parquet files load correctly in diff without errors

**Steps:**
1. Generate large CSV (100k rows, realistic columns)
2. Upload and import (triggers Parquet-backed snapshot due to size)
3. Verify OPFS contains `original_*_part_0.parquet`, `_part_1.parquet`, etc.
4. Apply transformation (e.g., Uppercase on column)
5. Open Diff view → Compare with Preview
6. Verify diff loads without:
   - "IO Error: No files found that match the pattern"
   - "Binder Error: column duckdb_schema does not exist"
   - "Access Handles cannot be created" (file locking)
7. Verify diff shows 100k "MODIFIED" rows
8. Test pagination (scroll through diff grid)
9. Verify pagination doesn't throw file locking errors
10. Export diff to CSV
11. Verify export completes without Binder Error (ORDER BY detection works)

**High-Fidelity Assertions:**
- Assert no console errors matching "IO Error|Binder Error|Access Handles"
- Assert diff summary: `modified === 100000` (exact)
- Assert export CSV has 100k rows + header

---

### Test 4: Diff Shows All 3 Statuses with Large File
**File:** `e2e/tests/feature-coverage.spec.ts` (add to existing FR-B2 serial group)

**Purpose:** Verify Goal 2 - Large diff correctly identifies Added, Modified, Removed rows

**Steps:**
1. Upload fr_b2_base.csv (5 rows)
2. Upload fr_b2_new.csv (5 rows)
3. Scale up: Generate large versions (50k rows each with overlapping + unique data)
   - Base: rows 1-50,000
   - New: rows 5,000-55,000 (overlap 5k-50k, remove 1-4,999, add 50,001-55,000)
4. Open Diff view → Compare Two Tables
5. Select tables, key column (id)
6. Run comparison
7. Verify diff summary:
   - Added = 5,000 (new rows)
   - Removed = 4,999 (deleted rows)
   - Modified = 0 (overlapping rows unchanged)
   - Unchanged = 45,001
8. Verify grid visually shows green/red/yellow rows correctly

**High-Fidelity Assertions:**
- Assert exact counts (Rule 1: identity)
- Assert diff pills show correct numbers
- Assert store summary matches UI pills

---

### Test 5: Internal Columns Never Appear in Grid
**File:** `e2e/tests/feature-coverage.spec.ts` (new serial group "Internal Column Filtering")

**Purpose:** Verify Goal 3 - Grid never displays internal columns

**Steps:**
1. Upload basic-data.csv
2. Get grid column headers via page inspector
3. Assert headers include: `id`, `name`, `email`
4. Assert headers DO NOT include: `_cs_id`, `duckdb_schema`, `row_id`, any `*__base`
5. Apply Trim transformation (creates `name__base` column)
6. Verify grid still doesn't show `name__base`
7. Export to CSV
8. Verify CSV headers match grid headers (no internal columns)

**High-Fidelity Assertions:**
- Assert `gridColumns.map(c => c.name)` excludes internal patterns
- Assert exported CSV first line doesn't contain internal column names

---

### Test 6: Transformation Pickers Don't Show Internal Columns
**File:** `e2e/tests/feature-coverage.spec.ts` (same serial group as Test 5)

**Purpose:** Verify Goal 3 - Transformation UI only shows user columns

**Steps:**
1. Load basic-data.csv
2. Apply Trim transformation (creates `name__base`)
3. Open Clean panel → Add Transformation
4. Select "Uppercase" transformation
5. Get column dropdown options
6. Assert options include: `id`, `name`, `email`
7. Assert options DO NOT include: `_cs_id`, `name__base`, `duckdb_schema`

**High-Fidelity Assertions:**
- Assert column picker has exact set `['id', 'name', 'email']`

---

### Test 7: Diff Grid Doesn't Show Internal Columns (Except Status)
**File:** `e2e/tests/feature-coverage.spec.ts` (same serial group as Test 5)

**Purpose:** Verify Goal 3 - Diff grid only shows Status + user columns

**Steps:**
1. Upload fr_b2_base.csv, fr_b2_new.csv
2. Open Diff view → Compare Two Tables
3. Select tables, run comparison
4. Get diff grid column headers
5. Assert headers include: `Status`, `id`, `name`, `email`
6. Assert headers DO NOT include: `_cs_id`, `row_id`, `a_row_id`, `b_row_id`, `duckdb_schema`

**High-Fidelity Assertions:**
- Assert diff columns = `['Status', 'id', 'name', 'email']` (exact set)

---

### Test 8: Diff Schema Banner Doesn't Show Internal Columns
**File:** `e2e/tests/feature-coverage.spec.ts` (same serial group as Test 5)

**Purpose:** Verify Goal 3 - Schema change warnings filter internal columns

**Steps:**
1. Upload table1.csv (columns: id, name, email)
2. Upload table2.csv (columns: id, name, age, _cs_id - manually injected)
3. Open Diff view → Compare Two Tables
4. Select tables
5. Verify schema change banner appears
6. Assert banner shows: "New columns: age" (not `_cs_id`)
7. Assert banner shows: "Removed columns: email"

**High-Fidelity Assertions:**
- Assert banner text doesn't contain `_cs_id` or `duckdb_schema`

---

### Test 9: Console Errors Don't Leak Internal Columns
**File:** `e2e/tests/feature-coverage.spec.ts` (same serial group as Test 5)

**Purpose:** Verify Goal 3 - No internal column names appear in console output

**Steps:**
1. Setup console listener to capture all logs/errors/warnings
2. Load basic-data.csv
3. Apply multiple transformations
4. Open diff view
5. Export CSV
6. Collect all console output
7. Assert no console message contains: `_cs_id`, `duckdb_schema`, `row_id`, `__base`
8. Allow exception for intentional debug logs (e.g., "[Timeline] Original snapshot created")

**High-Fidelity Assertions:**
- Assert `consoleMessages.filter(m => /_cs_id|duckdb_schema|row_id/.test(m)).length === 0`

---

### Test 10: File Locking Prevention on Diff Pagination
**File:** `e2e/tests/memory-optimization.spec.ts` (add to existing serial group)

**Purpose:** Verify Goal 2 - Pagination doesn't re-register Parquet files

**Steps:**
1. Generate large CSV (100k rows)
2. Upload, apply transformation (triggers chunked Parquet snapshot)
3. Open Diff view → Compare with Preview
4. Run comparison (creates diff result table with chunked Parquet)
5. Scroll to bottom of diff grid (triggers pagination)
6. Scroll back to top (triggers another pagination call)
7. Repeat scroll 5 times
8. Verify no console errors: "Access Handles cannot be created"
9. Close diff view
10. Re-open diff view
11. Verify no file locking errors

**High-Fidelity Assertions:**
- Assert console has 0 errors matching "Access Handles|file locking|OPFS"

---

## Critical Files to Modify

### New Test File (if needed):
- `e2e/tests/internal-column-filtering.spec.ts` (consolidate Tests 5-9)

### Existing Files to Extend:
- `e2e/tests/feature-coverage.spec.ts` (Tests 1, 4, 7, 8)
- `e2e/tests/transformations.spec.ts` (Test 2)
- `e2e/tests/memory-optimization.spec.ts` (Tests 3, 10)

### New Test Fixtures Needed:
- `e2e/fixtures/csv/with-duplicates-10k.csv` (programmatically generated in test)
- `e2e/fixtures/csv/large-dataset-100k.csv` (programmatically generated in test)
- `e2e/fixtures/csv/overlapping-base-50k.csv` (programmatically generated in test)
- `e2e/fixtures/csv/overlapping-new-50k.csv` (programmatically generated in test)

## Verification Strategy

All tests will follow the High-Fidelity Testing Standard:

### Rule 1: Assert Identity, Not Just Cardinality
- ✅ "The removed rows are IDs [1, 5, 9]"
- ❌ "There are 3 removed rows"

### Rule 2: Assert Exact States, Avoid `not.toEqual`
- ✅ `expect(value).toBe('Expected Value')`
- ❌ `expect(value).not.toBe(oldValue)`

### Rule 3: Visual Validation Requires CSS/DOM Checks
- ✅ Assert grid column headers don't include internal names
- ❌ Just check that diff view opened

### Console Error Monitoring
All tests will capture console output and assert:
- No "IO Error" messages
- No "Binder Error" messages
- No "Access Handles cannot be created" messages
- No internal column names in output (except intentional debug logs)

## Execution Plan

1. **Phase 1:** Add Tests 1, 2, 5, 6 (foundational tests, ~2 hours)
2. **Phase 2:** Add Tests 3, 10 (large file tests, ~3 hours)
3. **Phase 3:** Add Tests 4, 7, 8, 9 (comprehensive coverage, ~2 hours)
4. **Phase 4:** Run full suite, validate no regressions (~1 hour)

**Total Estimate:** ~8 hours of test implementation

## Success Criteria

✅ All 10 new tests pass consistently
✅ No console errors during test execution
✅ No regressions in existing 122 tests
✅ Coverage for all 3 user goals achieved
✅ Tests catch the exact bugs that were recently fixed (if code is reverted, tests fail)
