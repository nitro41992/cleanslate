# Fix: DataGrid Refresh After Merge + E2E Tests

## Problem

After applying merges in the MatchView, the DataGrid doesn't refresh to show the updated data. The screenshot shows "fuzzy_matching_test 18 rows" even though the audit log says "Removed 2 duplicate rows from table".

## Root Cause

DataGrid's `useEffect` (line 99-113 in `DataGrid.tsx`) only depends on `[tableName, columns, getData]`. When `rowCount` changes after applying merges, the effect doesn't re-run, so the grid shows stale data.

```typescript
// CURRENT (broken) - Line 113
}, [tableName, columns, getData])  // Missing rowCount!
```

---

## Fix

**File: `src/components/grid/DataGrid.tsx`**

Add `rowCount` to the dependency array and reset state when it changes:

```typescript
// Line 99-113: Add rowCount to dependencies and reset state
useEffect(() => {
  if (!tableName || columns.length === 0) return

  setIsLoading(true)
  setData([])  // Clear stale data immediately
  setLoadedRange({ start: 0, end: 0 })  // Reset loaded range

  getData(tableName, 0, PAGE_SIZE)
    .then((rows) => {
      setData(rows)
      setLoadedRange({ start: 0, end: rows.length })
      setIsLoading(false)
    })
    .catch((err) => {
      console.error('Error loading data:', err)
      setIsLoading(false)
    })
}, [tableName, columns, getData, rowCount])  // <-- Add rowCount
```

---

## E2E Tests to Add

### 1. Create MatchView Page Object

**File: `e2e/page-objects/match-view.page.ts`**

Page object with methods for:
- `waitForOpen()` / `close()`
- `selectTable(name)` / `selectColumn(name)`
- `selectStrategy(strategy)`
- `findDuplicates()`
- `getPairCount()` / `getStats()`
- `mergePair(index)` / `mergeSelected()`
- `applyMerges()`

### 2. Create Test Fixture

**File: `e2e/fixtures/csv/fuzzy_matching_test.csv`**

The fixture already exists - used in the user's testing.

### 3. Update FR-C1 Tests in `feature-coverage.spec.ts`

Replace the existing TDD-failing tests with working tests:

**Tests to add:**
1. `should open match view from toolbar` - Verify overlay opens
2. `should find duplicates and display in list` - Verify pairs show in results
3. `should display similarity percentage in pair rows` - Verify "XX% Similar" format
4. `should mark pairs as merged and update stats` - Verify merge action works
5. `should apply merges and update preview row count` - **Critical test for this bug fix**
6. `should log merge operations to audit` - Verify audit entries

---

## Files to Modify/Create

| File | Action |
|------|--------|
| `src/components/grid/DataGrid.tsx` | Add `rowCount` to useEffect dependencies (line 113) |
| `e2e/page-objects/match-view.page.ts` | Create new page object |
| `e2e/tests/feature-coverage.spec.ts` | Update FR-C1 tests |
| `e2e/page-objects/laundromat.page.ts` | Update `openMatchPanel` to wait for `match-view` instead of `panel-match` |

---

## Implementation Steps

### Step 1: Fix DataGrid Refresh
1. Edit `src/components/grid/DataGrid.tsx` line 113
2. Add `rowCount` to dependency array
3. Add `setData([])` and `setLoadedRange({ start: 0, end: 0 })` before loading

### Step 2: Create MatchView Page Object
Create `e2e/page-objects/match-view.page.ts` with test selectors

### Step 3: Update Laundromat Page Object
Change `openMatchPanel` to `openMatchView` and wait for `match-view` testid

### Step 4: Update FR-C1 Tests
Replace TDD failing tests with working tests that verify:
- Pairs display in list
- Merges apply correctly
- Preview row count updates

### Step 5: Run Tests
```bash
npm test -- --grep "FR-C1"
npm run lint
```

---

## Verification

1. **Manual verification:**
   - Load `fuzzy_matching_test.csv` (20 rows)
   - Open Match view, select table/column
   - Find duplicates → verify pairs show in list
   - Mark 2 pairs as merged → verify stats update
   - Click "Apply Merges" → verify preview shows 18 rows (20 - 2)

2. **Automated tests:**
   ```bash
   npm test -- --grep "FR-C1"
   ```

3. **Lint check:**
   ```bash
   npm run lint
   ```

---

## Status

- [x] UI Revamp (Phases 1-5 from original plan) - **COMPLETE**
- [ ] Fix DataGrid refresh bug - **IN PROGRESS**
- [ ] Add E2E tests for matcher - **IN PROGRESS**
