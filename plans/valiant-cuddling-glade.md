# Test Coverage Plan: Last 5 Commits Regression Tests

## Summary

Analysis of the last 5 commits against existing E2E/unit tests reveals **5 critical gaps** where recent functionality lacks test coverage.

---

## Commit Analysis

| Commit | Feature | Test Coverage |
|--------|---------|---------------|
| 904ffb1 | Manual edit recognition in diff | **GAP** |
| 3037ddf | Row menu on inserted rows + green gutter | **GAP** |
| 2a3a62a | Column order in diff view | **GAP** |
| 2652a8b | `_cs_origin_id` for accurate diff after row insertion | **GAP** |
| 09d9bd5 | Persistence race condition + column deletion dialog | Partial (unit test exists) |

---

## Existing Test Coverage

### Well Covered
- **Row insert/delete basics**: `data-manipulation.spec.ts` - insert above/below, delete, undo
- **Column ordering**: `column-ordering.spec.ts` - Tier 1/2/3, combiners, undo/redo
- **Diff two tables**: `regression-diff.spec.ts`, `diff-filtering.spec.ts` - compare two tables, status/column filtering

### Gaps Identified

#### 1. Diff After Row Insertion (HIGH PRIORITY)
**Commit**: 2652a8b - `_cs_origin_id` feature

**Problem**: When a row is inserted, `_cs_id` values shift for all subsequent rows. Before `_cs_origin_id`, diff incorrectly showed ALL rows after insertion as "modified".

**Missing Test**: Verify diff correctly shows only ACTUAL changes after row insertion

**Proposed Test** (in `e2e/tests/diff-row-insertion.spec.ts`):
```typescript
test('diff shows only actual changes after row insertion', async () => {
  // 1. Load table with 5 rows
  // 2. Edit cell in row 3 (mark as dirty)
  // 3. Insert a new row at position 2 (shifts rows 3-5)
  // 4. Open diff (Compare with Preview)
  // 5. Assert: Only 2 rows show as modified:
  //    - The inserted row (new)
  //    - Row 3's edited cell (actual edit)
  // 6. Assert: Rows 4, 5 do NOT appear as modified (just shifted)
})
```

#### 2. Manual Cell Edit in Diff (HIGH PRIORITY)
**Commit**: 904ffb1 - fixes diff not recognizing manual edits

**Problem**: `dataVersion` doesn't increment for `edit:cell` commands, so diff preview didn't re-run.

**Missing Test**: Verify manual cell edit appears in diff preview

**Proposed Test** (in `e2e/tests/diff-row-insertion.spec.ts`):
```typescript
test('diff detects manual cell edits in preview mode', async () => {
  // 1. Load table
  // 2. Double-click cell, change value, press Enter
  // 3. Open diff (Compare with Preview)
  // 4. Assert: The edited row shows as "modified"
  // 5. Assert: summary.modified >= 1
})
```

#### 3. Row Menu on Inserted Rows (MEDIUM)
**Commit**: 3037ddf - fixes `csIdToRowIndex` mapping

**Problem**: After inserting a row, clicking its row marker didn't show context menu (mapping collision).

**Missing Test**: Verify row menu works on NEWLY inserted rows

**Proposed Test** (add to `data-manipulation.spec.ts`):
```typescript
test('row menu appears on newly inserted rows', async () => {
  // 1. Load table
  // 2. Insert row above row 1
  // 3. Click the NEW row's marker (position 1)
  // 4. Assert: Row menu appears with Insert/Delete options
})
```

#### 4. Green Gutter Indicator for New Rows (MEDIUM)
**Commit**: 3037ddf - adds visual indicator via `insertedRowCsIds`

**Missing Test**: Verify green indicator appears on inserted rows

**Proposed Test** (add to `data-manipulation.spec.ts`):
```typescript
test('inserted rows show green gutter indicator', async () => {
  // 1. Load table
  // 2. Insert row
  // 3. Assert: uiStore.insertedRowCsIds contains the new row's _cs_id
  // Note: Can't assert visual (canvas) but can verify state
})
```

#### 5. Column Order in Diff View (MEDIUM)
**Commit**: 2a3a62a - diff view respects user column order

**Missing Test**: Verify diff shows columns in user-arranged order

**Proposed Test** (in `e2e/tests/diff-filtering.spec.ts` or new file):
```typescript
test('diff view respects user column order', async () => {
  // 1. Load table with columns [id, name, email, status]
  // 2. Rearrange columns via store to [status, name, email, id]
  // 3. Apply transformation
  // 4. Open diff (Compare with Preview)
  // 5. Assert: Diff grid shows columns in [status, name, email, id] order
})
```

---

#### 6. Scroll Position Preservation During Operations (MEDIUM)
**Feature**: DataGrid.tsx preserves scroll position when rows/columns are added

**Existing Code**: `scrollPositionRef`, `stableScrollRef`, and scroll restore logic in DataGrid.tsx (lines 445-450, 1018-1028, 1264-1284)

**Missing Test**: Verify scroll position is maintained after row/column insertion

**Proposed Test** (in `e2e/tests/data-manipulation.spec.ts`):
```typescript
test('scroll position preserved after row insertion', async () => {
  // 1. Load table with 100+ rows
  // 2. Scroll down to row 50 (capture scroll position)
  // 3. Insert a row at current position
  // 4. Assert: Scroll position is still around row 50 (not reset to top)
})

test('scroll position preserved after column addition', async () => {
  // 1. Load table
  // 2. Scroll right to see last columns
  // 3. Add a new column
  // 4. Assert: Horizontal scroll position maintained
})
```

---

## Implementation Plan

### New Test File: `e2e/tests/diff-row-insertion.spec.ts`

| Test | Priority | Validates Commit |
|------|----------|-----------------|
| diff shows only actual changes after row insertion | HIGH | 2652a8b |
| diff detects manual cell edits in preview mode | HIGH | 904ffb1 |

### Updates to `e2e/tests/data-manipulation.spec.ts`

| Test | Priority | Validates Commit |
|------|----------|-----------------|
| row menu appears on newly inserted rows | MEDIUM | 3037ddf |
| inserted rows show green gutter indicator | MEDIUM | 3037ddf |
| scroll position preserved after row insertion | MEDIUM | DataGrid.tsx existing behavior |
| scroll position preserved after column addition | MEDIUM | DataGrid.tsx existing behavior |

### Updates to `e2e/tests/column-ordering.spec.ts` or `diff-filtering.spec.ts`

| Test | Priority | Validates Commit |
|------|----------|-----------------|
| diff view respects user column order | MEDIUM | 2a3a62a |

---

## Files to Create/Modify

1. **Create**: `e2e/tests/diff-row-insertion.spec.ts` - New file for diff + row manipulation tests (2 tests)
2. **Modify**: `e2e/tests/data-manipulation.spec.ts` - Add 4 tests:
   - Row menu on newly inserted rows
   - Green gutter indicator for inserted rows
   - Scroll position preserved after row insertion
   - Scroll position preserved after column addition
3. **Modify**: `e2e/tests/column-ordering.spec.ts` - Add diff column order test

---

## Verification

After implementation, run:
```bash
# Run new tests
npx playwright test "diff-row-insertion.spec.ts" --timeout=90000 --retries=0 --reporter=line

# Run modified test files
npx playwright test "data-manipulation.spec.ts" --timeout=90000 --retries=0 --reporter=line
npx playwright test "column-ordering.spec.ts" --timeout=90000 --retries=0 --reporter=line
```
