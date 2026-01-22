# Fix Remaining E2E Test Failures

## Overview

After implementing initial fixes, 6 tests still fail. This plan addresses the remaining failures.

**Current Status:** 78 passed, 6 failed, 1 flaky

---

## Remaining Failures

### Fix 1: Visual Diff - "should identify added, removed, and modified rows"

**File:** `feature-coverage.spec.ts:492`

**Problem:** Test opens diff view after previous test left it in "Compare with Preview" mode. The test expects "Compare Two Tables" mode but doesn't explicitly select it.

**Fix:** After opening diff view, explicitly select "Compare Two Tables" mode:
```typescript
// Line ~514 - after openDiffView()
await laundromat.openDiffView()
await diffView.selectCompareTablesMode()  // ADD THIS LINE
```

---

### Fix 2: Fuzzy Matcher - "should open match view and find duplicates"

**File:** `feature-coverage.spec.ts:569`

**Problem:** The matching process completes but pairs may not appear in time. The `findDuplicates()` method only waits 500ms which may not be enough.

**Fix:** Increase wait time in `findDuplicates()` page object method:
```typescript
// In match-view.page.ts, line ~73
async findDuplicates(): Promise<void> {
  await expect(this.findDuplicatesButton).toBeEnabled()
  await this.findDuplicatesButton.click()
  // Wait for async operation to start
  await this.page.waitForTimeout(1000)  // Increase from 500ms
}
```

---

### Fix 3: Merge Audit Drill-Down - "should display row data"

**File:** `feature-coverage.spec.ts:670`

**Problem:** Cascades from Fix 2 - if fuzzy matching fails, this test can't proceed. Also, line 690 waits for progress bar that may never appear.

**Fix:** Depends on Fix 2. Additionally, make the wait more resilient:
```typescript
// Line ~690 - wait for progress OR results
await Promise.race([
  page.locator('[role="progressbar"]').waitFor({ state: 'hidden', timeout: 30000 }),
  matchView.waitForPairs()
])
```

---

### Fix 4: Left Join - "should perform left join preserving unmatched orders"

**File:** `feature-coverage.spec.ts:1043`

**Problem:** Radio button selector `getByLabel('Left')` doesn't match the actual UI structure. Previous test leaves "Inner" selected.

**Fix:** Use role-based selector for radio button:
```typescript
// Line ~1086 - change from getByLabel to getByRole
await page.getByRole('radio', { name: /left/i }).click()
await page.waitForTimeout(200)  // Wait for selection to register
```

---

### Fix 5: Diff Compare with Preview - "should support Compare with Preview mode"

**File:** `feature-coverage.spec.ts:1300`

**Problem:** 500ms wait after transformation isn't enough for snapshot creation. The timeline system may need more time.

**Fix:** Increase wait time and add explicit verification:
```typescript
// Line ~1313 - increase wait
await page.waitForTimeout(1000)  // Increase from 500ms

// OR better: wait for toast to confirm transformation applied
await expect(page.getByText('Transformation Applied')).toBeVisible({ timeout: 5000 })
```

---

### Fix 6: Audit Export - "should export manual edit details as CSV"

**File:** `audit-details.spec.ts:361`

**Problem:** Uses deprecated `switchToDataPreviewTab()` and `switchToAuditLogTab()` methods. Race condition when sidebar opens.

**Fix:** Replace deprecated methods and add explicit waits:
```typescript
// Line ~365 - replace deprecated method
await laundromat.closeAuditSidebar()  // Instead of switchToDataPreviewTab()

// Line ~372 - replace and wait for content
await laundromat.openAuditSidebar()  // Instead of switchToAuditLogTab()
await page.waitForTimeout(300)  // Wait for sidebar animation
```

---

## Files to Modify

| File | Line | Change |
|------|------|--------|
| `feature-coverage.spec.ts` | ~514 | Add `selectCompareTablesMode()` call |
| `feature-coverage.spec.ts` | ~1086 | Change to `getByRole('radio', { name: /left/i })` |
| `feature-coverage.spec.ts` | ~1313 | Increase wait to 1000ms |
| `match-view.page.ts` | ~73 | Increase wait in `findDuplicates()` to 1000ms |
| `audit-details.spec.ts` | ~365, 372 | Replace deprecated methods with explicit calls |

---

## Implementation Order

1. **Fix 4 (Left Join)** - Isolated radio button selector fix
2. **Fix 5 (Diff Preview)** - Timing increase
3. **Fix 6 (Audit Export)** - Deprecated method replacement
4. **Fix 2 (Fuzzy Matcher)** - Page object timing fix
5. **Fix 1 & 3 (Visual Diff & Merge)** - Depend on earlier fixes

---

## Verification

```bash
# Run specific failing tests
npm test -- --grep "should identify added, removed, and modified rows"
npm test -- --grep "should open match view and find duplicates"
npm test -- --grep "should display row data in merge audit"
npm test -- --grep "should perform left join"
npm test -- --grep "Compare with Preview"
npm test -- --grep "should export manual edit details"

# Run full suite
npm test
```

---

## Note on TDD Tests

14 tests are expected to fail - these are TDD tests marked with `test.fail()` for unimplemented features (Title Case, Remove Accents, Smart Scrubber, etc.). These are NOT bugs - they document future work.
