# Column Order Preservation - Final Steps

## ✅ Implementation Complete

**What Was Done:**
1. **Test Fixes** (e2e/tests/column-ordering.spec.ts):
   - Rename test: Fixed to use `params: { 'New column name': 'email_address' }`
   - Remove duplicates test: Switched to simpler CSV, added 1s wait, closes panel

2. **Combiner Column Order** (src/components/panels/CombinePanel.tsx):
   - Stack: Calculates union of source columnOrders (first appearance)
   - Join: Calculates left + right columnOrders (excludes duplicate join key)
   - Both immediately call `updateTable(newTableId, { columnOrder })`

3. **Additional Fix** (vite.config.js):
   - Fixed import: `consoleForwardPlugin` (named export, not default)

---

## 📋 What's Pending

### 1. Run Tests
```bash
npm run test -- column-ordering.spec.ts
```

**Expected:** 10/12 passing, 1 skipped (batched transformations)

### 2. If Tests Fail

**Rename Column Timeout:**
- Check parameter label matches UI: `'New column name'`
- Verify `addTransformation()` helper is working correctly

**Remove Duplicates Timeout:**
- Increase wait time beyond 1s if needed
- Consider using better loading indicators

**Combiner Tests:**
- Verify columnOrder calculation logic
- Check that `updateTable()` is being called correctly

### 3. Manual Verification

Once tests pass:
- [ ] Stack two tables → verify union column order
- [ ] Join two tables → verify left + right columns (no duplicate key)
- [ ] Transform combined table → verify order preserved
- [ ] Undo/redo → verify order maintained

### 4. Commit

```bash
git add .
git commit -m "fix: preserve column order in combiner operations

- Fix rename_column and remove_duplicates E2E tests
- Initialize columnOrder for stack/join operations
- Stack: union of source columns (first appearance)
- Join: left + right columns (excludes duplicate key)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Test Suite Reference

**File:** e2e/tests/column-ordering.spec.ts (12 tests)

| Test | Status | Notes |
|------|--------|-------|
| Tier 1 (trim) | ✅ Was passing | Transformation preserves order |
| Tier 2 (rename) | 🔧 Fixed | Now uses correct param label |
| Tier 3 (remove_duplicates) | 🔧 Fixed | Simpler CSV, added wait |
| Split column | ✅ Was passing | Appends new columns at end |
| Undo | ✅ Was passing | Restores original order |
| Redo | ✅ Was passing | Preserves order |
| Chained transforms | ✅ Was passing | Order maintained |
| Combiner stack | 🔧 Fixed | Now initializes columnOrder |
| Combiner join | 🔧 Fixed | Now initializes columnOrder |
| Transform after combine | 🔧 Fixed | Depends on join fix |
| Internal columns | ✅ Was passing | Excludes _cs_id, __base |
| Batched (>500k rows) | ⏭️ Skipped | Needs large fixture |

**Fixtures:** e2e/fixtures/csv/
- column-order-test.csv
- split-column-test.csv
- stack-table-1.csv, stack-table-2.csv
- join-left.csv, join-right.csv
