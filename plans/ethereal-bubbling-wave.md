# Test Plan: Diff Regression Prevention

## Summary

Add E2E tests to prevent regressions of diff-related bugs fixed in recent commits. The plan focuses on test gaps identified from analyzing the last 10 commits and existing test coverage.

## Recent Fixes Requiring Test Coverage

| Commit | Fix | Current E2E Coverage |
|--------|-----|---------------------|
| 5d8ecf3 | insert-row not assigning `_cs_origin_id` | **NONE** |
| 75b4f7b | Tables missing `_cs_origin_id` in fetch queries | **NONE** (unit test preferred) |
| d8027c5 | Formula Builder dropping `_cs_origin_id` | **COVERED** in diff-filtering.spec.ts |
| 9b68947 | Audit drill-down row numbers using wrong ID | **NONE** |
| 5996e2b | Row matching after insertions using wrong column | **COVERED** in diff-row-insertion.spec.ts |

---

## New Tests to Add

### 1. Row Number Display for Added Rows (Priority: HIGH)

**File:** `e2e/tests/diff-row-insertion.spec.ts` (existing)

**Test:** `diff shows correct row numbers for newly inserted rows (not "-")`

**Scenario:**
1. Load table with 5 rows
2. Insert a new row at position 2
3. Open Diff View, run comparison
4. Verify the added row has actual row number (not "-" or null)

**Key Assertions:**
```typescript
// Verify _cs_origin_id is populated for new row
const newRow = await inspector.runQuery<{ _cs_origin_id: string }>(
  `SELECT "_cs_origin_id" FROM basic_data WHERE "_cs_id" = '2'`
)
expect(newRow[0]._cs_origin_id).toBeTruthy()

// Verify diff row number is populated (not null)
const diffTableName = (await inspector.getDiffState()).diffTableName
const addedRows = await inspector.runQuery<{ b_row_num: number }>(
  `SELECT b_row_num FROM "${diffTableName}" WHERE diff_status = 'added'`
)
expect(addedRows[0]?.b_row_num).not.toBeNull()
expect(typeof addedRows[0]?.b_row_num).toBe('number')
```

---

### 2. Audit Drill-Down Row Numbers After Insertion (Priority: HIGH)

**File:** `e2e/tests/audit-row-tracking.spec.ts` (new file)

**Test:** `audit drill-down shows correct row numbers after row insertion`

**Scenario:**
1. Load table with 5 rows
2. Edit cell in row 3 (Bob -> "Bob Edited")
3. Insert a new row above row 3 (Bob shifts to row 4)
4. Open audit log, click on the earlier edit entry
5. Verify the row number shows 4 (updated), not 3 (stale)

**Key Assertions:**
```typescript
// Open audit detail modal
const editEntry = page.locator('[data-testid="audit-entry"]').filter({ hasText: 'Edit Cell' }).first()
await editEntry.click()

// Verify row number in detail view
await expect.poll(async () => {
  const rowText = await page.locator('[data-testid="manual-edit-detail-row"]').textContent()
  return rowText
}, { timeout: 10000 }).toContain('Row 4')
```

---

### 3. Multiple Consecutive Row Insertions (Priority: MEDIUM)

**File:** `e2e/tests/diff-row-insertion.spec.ts` (existing)

**Test:** `diff correctly handles multiple consecutive row insertions`

**Scenario:**
1. Load table with 5 rows
2. Insert rows at positions 1, 3, 5
3. Open Diff View, run comparison
4. Verify 3 added rows with distinct row numbers

**Key Assertions:**
```typescript
expect(diffState.summary?.added).toBe(3)
const addedRows = await inspector.runQuery<{ b_row_num: number }>(
  `SELECT b_row_num FROM "${diffTableName}" WHERE diff_status = 'added' ORDER BY b_row_num`
)
expect(addedRows.map(r => r.b_row_num)).toEqual([1, 3, 5])
```

---

### 4. Row Deletion Maintains Stable Identity (Priority: MEDIUM)

**File:** `e2e/tests/diff-row-insertion.spec.ts` (existing)

**Test:** `diff correctly identifies removed rows after deletion`

**Scenario:**
1. Load table with 5 rows
2. Delete row 2 (Jane Smith)
3. Open Diff View, run comparison
4. Verify 1 removed, 0 modified (no false positives from shifted rows)

**Key Assertions:**
```typescript
expect(diffState.summary).toEqual({
  added: 0,
  removed: 1,
  modified: 0,
  unchanged: 4
})
```

---

### 5. Unit Test: Missing _cs_origin_id Fallback (Priority: LOW)

**File:** `src/lib/__tests__/diff-engine.test.ts` (new file)

**Reason for unit test:** Creating a table without `_cs_origin_id` is difficult in E2E (all new tables have it). Unit test can mock `tableHasOriginId()` to return false.

**Test:** `fetchDiffPage falls back to _cs_id when _cs_origin_id is missing`

---

## Files to Modify

| File | Action |
|------|--------|
| `e2e/tests/diff-row-insertion.spec.ts` | Add tests 1, 3, 4 |
| `e2e/tests/audit-row-tracking.spec.ts` | Create new file with test 2 |
| `e2e/page-objects/diff-view.page.ts` | No changes needed |
| `src/lib/__tests__/diff-engine.test.ts` | Create new file with test 5 |

---

## Implementation Order

1. **Test 1:** Row number display for added rows (5d8ecf3 regression)
2. **Test 2:** Audit drill-down row numbers (9b68947 regression)
3. **Test 3:** Multiple insertions (edge case)
4. **Test 4:** Row deletion (inverse case)
5. **Test 5:** Unit test for fallback (defensive coverage)

---

## Test Setup Pattern

All new tests use Tier 3 isolation (fresh browser context per test):

```typescript
let browser: Browser
let context: BrowserContext
let page: Page

test.setTimeout(120000)

test.beforeAll(async ({ browser: b }) => {
  browser = b
})

test.beforeEach(async () => {
  context = await browser.newContext()
  page = await context.newPage()
  // Re-initialize page objects
})

test.afterEach(async () => {
  await context.close().catch(() => {})
})
```

---

## Verification

After implementation, run:

```bash
# Run all diff-related tests
npx playwright test "diff-row-insertion.spec.ts" "audit-row-tracking.spec.ts" --timeout=90000 --retries=0 --reporter=line

# Run specific new tests
npx playwright test "diff-row-insertion.spec.ts" -g "row numbers" --timeout=60000 --retries=0 --reporter=line
```

Expected: All tests pass, specifically verifying:
- Added rows show actual row numbers in diff view
- Audit drill-down shows updated row numbers after insertions
- Multiple insertions and deletions are handled correctly

---

## Implementation Status: COMPLETE ✅

### Tests Implemented

| Test | File | Status |
|------|------|--------|
| Row number display for added rows | `e2e/tests/diff-row-insertion.spec.ts` | ✅ PASS |
| Multiple consecutive row insertions | `e2e/tests/diff-row-insertion.spec.ts` | ✅ PASS |
| Row deletion maintains stable identity | `e2e/tests/diff-row-insertion.spec.ts` | ✅ PASS |
| Audit drill-down after row insertion | `e2e/tests/audit-row-tracking.spec.ts` | ✅ PASS |
| Audit drill-down for deleted rows | `e2e/tests/audit-row-tracking.spec.ts` | ✅ PASS |
| Multiple edits with dynamic row numbers | `e2e/tests/audit-row-tracking.spec.ts` | ✅ PASS |
| Unit test: fallback SQL generation | `src/lib/__tests__/diff-engine-fallback.test.ts` | ✅ PASS |

### Files Created/Modified

| File | Action |
|------|--------|
| `e2e/tests/diff-row-insertion.spec.ts` | Added 3 new tests |
| `e2e/tests/audit-row-tracking.spec.ts` | Created (3 tests) |
| `src/lib/__tests__/diff-engine-fallback.test.ts` | Created (11 unit tests) |

### Test Results

```
Running 9 E2E tests using 1 worker
  ✓ audit drill-down shows correct row numbers after row insertion (8.3s)
  ✓ audit drill-down shows (deleted) for rows that no longer exist (8.3s)
  ✓ multiple edits show correct dynamic row numbers after insertions (9.4s)
  ✓ diff shows only actual changes after row insertion (not shifted rows) (8.7s)
  ✓ diff detects manual cell edits in preview mode (8.0s)
  ✓ diff correctly handles multiple edits on same row after insertion (9.2s)
  ✓ diff shows correct row numbers for newly inserted rows (not "-") (8.0s)
  ✓ diff correctly handles multiple consecutive row insertions (9.0s)
  ✓ diff correctly identifies removed rows after deletion (8.5s)
  9 passed (1.3m)

Running 11 unit tests
  ✓ src/lib/__tests__/diff-engine-fallback.test.ts (11 tests) 4ms
  11 passed
```
