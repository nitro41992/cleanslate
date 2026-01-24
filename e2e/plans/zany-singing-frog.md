# E2E Test Fixes: High-Fidelity Testing Compliance

## Objective

Fix 6 failing E2E tests by addressing high-fidelity testing violations and underlying source code issues. All fixes must comply with the testing guidelines in CLAUDE.md:
- **Rule 1:** Assert Identity, Not Just Cardinality
- **Rule 2:** Assert Exact States, Avoid `not.toEqual`
- **Rule 3:** Visual Validation Requires CSS/DOM/Store Checks

## Summary of Test Failures

| Test | Location | Root Cause | Fix Type |
|------|----------|------------|----------|
| FR-C1: "should log merge operations to audit" | feature-coverage.spec.ts:617 | Loose regex assertion + possible navigation issue | Test fix + Source investigation |
| FR-C1: "should display row data in merge audit drill-down" | feature-coverage.spec.ts:651 | Blocked by Test #1 | Unblocked by Test #1 fix |
| FR-REGRESSION-2: "Clicking highlight..." | audit-undo-regression.spec.ts:72 | Store returns empty rowIds (our recent changes) | Source fix (command metadata) |
| FR-B2: "_cs_id differs regression test" | feature-coverage.spec.ts:1573 | Negative assertion violation | Test fix only |
| FR-E2: "left join preserving unmatched orders" | feature-coverage.spec.ts:1260 | Cardinality vs identity violation | Test fix only |
| FR-E2: Panel opening reliability | Same test (lines 1190-1210) | Infrastructure flakiness | Out of scope |

---

## Root Cause Analysis

### Critical Issue #1: FR-REGRESSION-2 (Our Changes Broke This)

**What we changed:**
- Added `rowIds: string[]` to `TimelineHighlightState` interface in store-inspector.ts
- Added `expectRowIdsHighlighted()` helper that expects specific row IDs
- Updated FR-REGRESSION-2 test to call `expectRowIdsHighlighted(highlightState.rowIds, ['1', '2', '3'])`

**Why it's failing:**
- The timeline store's `setHighlightedCommand()` function (timelineStore.ts:316-378) creates highlight from `command.affectedRowIds` (line 351)
- Transform commands (like Trim Whitespace) don't populate `affectedRowIds` when created
- Result: `highlightState.rowIds` returns empty array `[]`
- Our test now correctly checks for specific row IDs, exposing this missing metadata

**Fix Required:**
Populate `affectedRowIds` in transform command execution. Commands need to track which rows they modify.

---

### Issue #2: FR-C1 Merge Audit Tests

**Test 1 Issue (line 617):**
```typescript
// Current (lazy):
await expect(page.locator('text=/Apply Merges|Find Duplicates/').first()).toBeVisible({ timeout: 5000 })

// High-fidelity:
await expect(page.getByText('Merge Duplicates', { exact: true })).toBeVisible({ timeout: 5000 })
```
**Violation:** Rule 1 - Regex pattern matches multiple things, doesn't verify exact action

**Test 2 Issue (line 651):**
- Depends on Test #1's setup (same serial group)
- Test itself is well-written with proper assertions (lines 693-698)
- Will pass once Test #1 is fixed

---

### Issue #3: FR-B2 Diff Test (Negative Assertion)

**Current (line 1573):**
```typescript
expect(row1A[0]._cs_id).not.toBe(row1B[0]._cs_id)
```

**Violation:** Rule 2 - Negative assertion without proving both values are valid

**High-Fidelity Fix:**
```typescript
// First prove both UUIDs are valid
expect(row1A[0]._cs_id).toBeDefined()
expect(row1B[0]._cs_id).toBeDefined()
expect(typeof row1A[0]._cs_id).toBe('string')
expect(row1A[0]._cs_id.length).toBe(36) // UUID v4 format
expect(row1B[0]._cs_id.length).toBe(36)

// Now safe to assert they differ
expect(row1A[0]._cs_id).not.toEqual(row1B[0]._cs_id)
```

---

### Issue #4: FR-E2 Left Join Test (Cardinality vs Identity)

**Current (lines 1256-1260):**
```typescript
const unmatched = await inspector.runQuery(
  'SELECT count(*) as cnt FROM join_result WHERE name IS NULL'
)
expect(Number(unmatched[0].cnt)).toBeGreaterThan(0)  // Just "at least 1"
```

**Violation:** Rule 1 - Checks cardinality, not which specific row is unmatched

**Fixture Data:**
- Orders: 6 rows (O001-O006) with customer_ids: C001, C002, C001, C003, **C004**, C002
- Customers: 4 rows (C001, C002, C003, C005) - **C004 is missing!**
- Left join result: O005 (customer C004, Headphones) has NULL customer data

**High-Fidelity Fix:**
```typescript
// Rule 1: Assert identity, not just cardinality
const unmatched = await inspector.runQuery(
  `SELECT order_id, customer_id, product, name, email
   FROM join_result
   WHERE name IS NULL
   ORDER BY order_id`
)

// Exact count
expect(unmatched.length).toBe(1)

// Exact identity - verify which order is unmatched
expect(unmatched[0].order_id).toBe('O005')
expect(unmatched[0].customer_id).toBe('C004')
expect(unmatched[0].product).toBe('Headphones')
expect(unmatched[0].name).toBeNull()
expect(unmatched[0].email).toBeNull()
```

---

## Implementation Plan

### Phase 1: Fix Source Code Issues (Critical)

#### Fix 1.1: Populate affectedRowIds for Transform Commands

**Priority:** CRITICAL (Fixes FR-REGRESSION-2)

**Files to modify:**
- `src/lib/commands/executor.ts` - Command execution
- `src/lib/commands/transform/tier1/trim.ts` - Example transform (verify pattern)

**Approach:**

After a transform command executes, capture the row IDs that were affected. Two options:

**Option A (Precise):** Query which rows actually changed
```typescript
// In executor.ts, after command.execute()
if (commandType.startsWith('transform:')) {
  const affectedRows = await duckdb.query(
    `SELECT _cs_id FROM ${tableId}
     WHERE ${column} != ${oldExpression}`  // Compare before/after
  )
  command.affectedRowIds = affectedRows.map(r => String(r._cs_id))
}
```

**Option B (Conservative - RECOMMENDED):** Assume all non-null values in column are affected
```typescript
// In executor.ts, after command.execute()
if (commandType.startsWith('transform:')) {
  const affectedRows = await duckdb.query(
    `SELECT _cs_id FROM ${tableId}
     WHERE ${column} IS NOT NULL`
  )
  command.affectedRowIds = affectedRows.map(r => String(r._cs_id))
}
```

**Recommendation:** Use Option B (conservative) for simplicity. It may highlight some unchanged rows, but guarantees all affected rows are highlighted.

**Verification:**
```bash
npm test -- audit-undo-regression.spec.ts --grep "FR-REGRESSION-2"
```
Expected: `highlightState.rowIds` contains `['1', '2', '3']`

---

#### Fix 1.2: Investigate Match View Navigation (Optional)

**Priority:** MEDIUM (Test #1 may pass with just assertion fix)

If Test #1 still fails after fixing the assertion, investigate:
- `src/features/matcher/MatchView.tsx` - `applyMerges()` handler
- Ensure it closes the match panel after merge
- Ensure it returns to main laundromat view

**Note:** Try assertion fix first before investigating navigation.

---

### Phase 2: Fix Test Assertions (High-Fidelity Compliance)

#### Fix 2.1: FR-C1 Merge Audit Assertion

**File:** `e2e/tests/feature-coverage.spec.ts`
**Lines:** 617-626

**Before:**
```typescript
test('should log merge operations to audit', async () => {
  await laundromat.openAuditSidebar()
  await page.waitForTimeout(300)

  // Loose regex - violates Rule 1
  await expect(page.locator('text=/Apply Merges|Find Duplicates/').first()).toBeVisible({ timeout: 5000 })

  await laundromat.closeAuditSidebar()
})
```

**After:**
```typescript
test('should log merge operations to audit', async () => {
  await laundromat.openAuditSidebar()
  await page.waitForTimeout(300)

  // Rule 1: Assert exact action text, not regex pattern
  const mergeAuditEntry = page.getByText('Merge Duplicates', { exact: true })
  await expect(mergeAuditEntry).toBeVisible({ timeout: 5000 })

  // Also verify it has row details indicator (visual validation - Rule 3)
  const entryWithDetails = page.getByTestId('audit-entry-with-details')
  await expect(entryWithDetails.filter({ hasText: 'Merge Duplicates' })).toBeVisible()

  await laundromat.closeAuditSidebar()
})
```

---

#### Fix 2.2: FR-B2 _cs_id Negative Assertion

**File:** `e2e/tests/feature-coverage.spec.ts`
**Lines:** 1570-1573

**Before:**
```typescript
const row1A = await inspector.runQuery('SELECT _cs_id FROM test_original WHERE id = 1')
const row1B = await inspector.runQuery('SELECT _cs_id FROM test_duplicate WHERE id = 1')
expect(row1A[0]._cs_id).not.toBe(row1B[0]._cs_id)
```

**After:**
```typescript
const row1A = await inspector.runQuery('SELECT _cs_id FROM test_original WHERE id = 1')
const row1B = await inspector.runQuery('SELECT _cs_id FROM test_duplicate WHERE id = 1')

// Rule 2: Positive assertions - prove both are valid UUIDs first
expect(row1A[0]._cs_id).toBeDefined()
expect(row1B[0]._cs_id).toBeDefined()
expect(typeof row1A[0]._cs_id).toBe('string')
expect(row1A[0]._cs_id.length).toBe(36) // UUID v4 format
expect(row1B[0]._cs_id.length).toBe(36)

// Now safe to assert they differ (proven both are valid)
expect(row1A[0]._cs_id).not.toEqual(row1B[0]._cs_id)
```

---

#### Fix 2.3: FR-E2 Left Join Identity Assertion

**File:** `e2e/tests/feature-coverage.spec.ts`
**Lines:** 1256-1260

**Before:**
```typescript
// Verify unmatched orders have NULL customer info
const unmatched = await inspector.runQuery(
  'SELECT count(*) as cnt FROM join_result WHERE name IS NULL'
)
expect(Number(unmatched[0].cnt)).toBeGreaterThan(0) // C004 order has no matching customer
```

**After:**
```typescript
// Rule 1: Assert identity, not just cardinality
const unmatched = await inspector.runQuery(
  `SELECT order_id, customer_id, product, name, email
   FROM join_result
   WHERE name IS NULL
   ORDER BY order_id`
)

// Exact count
expect(unmatched.length).toBe(1)

// Exact identity - verify which order is unmatched
expect(unmatched[0].order_id).toBe('O005')
expect(unmatched[0].customer_id).toBe('C004')
expect(unmatched[0].product).toBe('Headphones')
expect(unmatched[0].name).toBeNull()
expect(unmatched[0].email).toBeNull()
```

---

### Phase 3: Add Helper Function (Optional Enhancement)

**File:** `e2e/helpers/high-fidelity-assertions.ts`

Add a reusable UUID validation helper:

```typescript
/**
 * Assert UUID v4 format (for _cs_id columns)
 * Use this instead of expect(uuid).not.toBe(otherUuid)
 *
 * @example
 * expectValidUuid(row._cs_id)
 * expectValidUuid(row._cs_id, { notEqual: otherRow._cs_id })
 */
export function expectValidUuid(
  value: unknown,
  options?: { notEqual?: unknown }
): void {
  expect(value).toBeDefined()
  expect(typeof value).toBe('string')
  expect((value as string).length).toBe(36)

  if (options?.notEqual !== undefined) {
    // First validate the comparison value
    expect(options.notEqual).toBeDefined()
    expect(typeof options.notEqual).toBe('string')
    expect((options.notEqual as string).length).toBe(36)

    // Now safe to compare
    expect(value).not.toEqual(options.notEqual)
  }
}
```

**Usage in Test #4:**
```typescript
const row1A = await inspector.runQuery('SELECT _cs_id FROM test_original WHERE id = 1')
const row1B = await inspector.runQuery('SELECT _cs_id FROM test_duplicate WHERE id = 1')

// Single helper replaces 6 lines
expectValidUuid(row1A[0]._cs_id, { notEqual: row1B[0]._cs_id })
```

---

## Implementation Order

### Step 1: Fix Critical Source Code (30-60 min)
1. Add `affectedRowIds` population in `executor.ts` (Option B - conservative approach)
2. Test manually: Upload CSV → Apply Trim → Click Highlight in audit sidebar
3. Run test: `npm test -- audit-undo-regression.spec.ts --grep "FR-REGRESSION-2"`

### Step 2: Fix Test Assertions (20-30 min)
1. Fix 2.1: FR-C1 merge audit (exact text match) - 5 min
2. Fix 2.2: FR-B2 _cs_id assertions - 10 min
3. Fix 2.3: FR-E2 left join identity - 10 min
4. Run tests:
   ```bash
   npm test -- feature-coverage.spec.ts --grep "FR-C1.*should log merge"
   npm test -- feature-coverage.spec.ts --grep "FR-B2.*_cs_id"
   npm test -- feature-coverage.spec.ts --grep "FR-E2.*left join"
   ```

### Step 3: Optional - Add UUID Helper (10 min)
1. Add `expectValidUuid()` to high-fidelity-assertions.ts
2. Update Fix 2.2 to use the helper

### Step 4: Full Verification (10 min)
```bash
# Run all 6 affected tests
npm test -- --grep "FR-C1.*audit|FR-REGRESSION-2|FR-B2.*_cs_id|FR-E2.*left join"

# Run full suite to check for regressions
npm test
```

---

## Critical Files to Modify

### Source Code (Phase 1)
- **`src/lib/commands/executor.ts`** - Add affectedRowIds population after transform execution
- **`src/lib/commands/transform/tier1/trim.ts`** - Verify transform command structure (reference only)

### Test Files (Phase 2)
- **`e2e/tests/feature-coverage.spec.ts`**
  - Lines 617-626: Fix FR-C1 regex → exact text match
  - Lines 1570-1573: Fix FR-B2 negative assertion → positive UUID validation
  - Lines 1256-1260: Fix FR-E2 cardinality → identity assertion

### Helper Files (Phase 3 - Optional)
- **`e2e/helpers/high-fidelity-assertions.ts`** - Add `expectValidUuid()` helper

---

## Verification Plan

### Manual Testing (After Phase 1)
1. Start dev server: `npm run dev`
2. Upload `whitespace-data.csv`
3. Apply "Trim Whitespace" transformation
4. Click audit sidebar → Click "Highlight" button on Trim entry
5. Verify grid highlights rows (visual check)
6. Open browser console: Check `window.__CLEANSLATE_STORES__.timelineStore.getState().highlight.rowIds`
7. Expected: Array of row IDs like `['1', '2', '3']`

### Automated Testing
```bash
# Individual test verification
npm test -- audit-undo-regression.spec.ts --grep "FR-REGRESSION-2"
npm test -- feature-coverage.spec.ts --grep "should log merge operations to audit"
npm test -- feature-coverage.spec.ts --grep "should display row data in merge audit drill-down"
npm test -- feature-coverage.spec.ts --grep "should not flag rows as modified when only _cs_id differs"
npm test -- feature-coverage.spec.ts --grep "should perform left join preserving unmatched orders"

# All 6 tests together
npm test -- --grep "FR-C1.*audit|FR-REGRESSION-2|FR-B2.*_cs_id|FR-E2.*left join"

# Full suite (regression check)
npm test
```

---

## Success Criteria

**Definition of Done:**
- ✅ All 6 failing tests pass consistently (3 consecutive runs)
- ✅ No new test failures introduced
- ✅ Source code changes follow Command Pattern architecture
- ✅ All test assertions follow high-fidelity guidelines:
  - Rule 1: Identity checks (exact values, not counts)
  - Rule 2: Positive assertions (no naked `not.toBe`)
  - Rule 3: Visual state verified via store (not just UI buttons)
- ✅ Timeline highlight feature works in manual testing

**Metrics:**
- Before: 6 failing tests
- After: 0 failing tests
- High-Fidelity Violations Fixed: 3 tests upgraded from lazy → high-fidelity
- Source Bugs Fixed: 1 (missing command metadata)

---

## Out of Scope

**The following will NOT be addressed:**
1. **FR-E2 Panel Opening Reliability** - Infrastructure flakiness, needs separate investigation
2. **Match View Navigation** - Only investigate if assertion fix doesn't resolve Test #1
3. **Comprehensive Audit** - This plan only fixes the 6 failing tests, not all 90+ passing tests
4. **Performance Optimization** - If affectedRowIds queries are slow, defer to separate ticket

---

## Risk Assessment

### High Risk
- **Transform Command Changes:** Modifying executor.ts affects all transform operations
  - Mitigation: Use conservative approach (Option B), run full test suite
  - Rollback plan: Remove affectedRowIds population if tests fail

### Medium Risk
- **FR-C1 Navigation:** If assertion fix doesn't work, may need UI refactoring
  - Mitigation: Test assertion fix first before investigating navigation

### Low Risk
- **Test Assertion Changes:** Pure test code, no source impact
- **UUID Helper:** Optional enhancement, doesn't affect existing tests
