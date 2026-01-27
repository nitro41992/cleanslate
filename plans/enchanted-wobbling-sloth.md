# E2E Test Flakiness: Holistic Fix Plan

## Problem Summary
DuckDB-WASM tests are experiencing flakiness due to:
1. **Resource starvation** from parallel test execution (`fullyParallel: true`)
2. **Race conditions** where tests assert before WASM operations complete
3. **State leakage** between serial tests when UI dialogs block cleanup

## Implementation Plan

### Phase 1: Playwright Config Changes (High Impact)

**File:** `playwright.config.ts`

| Setting | Current | Proposed | Rationale |
|---------|---------|----------|-----------|
| `fullyParallel` | `true` | `false` | WASM is CPU/memory intensive; parallel execution causes GC pauses |
| `workers` (CI) | `2` | `1` | Single worker prevents memory contention with DuckDB-WASM |
| `workers` (local) | `1` | `1` | Keep unchanged |
| `expect.timeout` | `10000` | `15000` | More breathing room for DuckDB queries under load |

```typescript
// playwright.config.ts changes
export default defineConfig({
  fullyParallel: false,  // CHANGE: Disable for WASM stability
  workers: process.env.CI ? 1 : 1,  // CHANGE: Single worker in CI
  expect: {
    timeout: 15000,  // CHANGE: Increase from 10s to 15s
  },
  // ... rest unchanged
});
```

---

### Phase 2: Cleanup Helper Enhancement

**File:** `e2e/helpers/cleanup-helpers.ts`

Add Escape key handling to `coolHeapLight` to force-close any open modals:

```typescript
export async function coolHeapLight(page: Page): Promise<void> {
  // NEW: Force-close stacked modals with Escape key
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); // Twice for nested dialogs

  // Existing panel close logic...
}
```

**Note on Audit Pruning:** Audit entries are derived from the timeline (see `auditStore.ts:1-15`). We cannot prune them without affecting undo/redo. The existing "warn only" behavior is correct - the real fix is proper page isolation (fresh page per heavy test) rather than trying to prune timeline-derived entries.

---

### Phase 3: Standardize afterEach Pattern

**Files:** All `e2e/tests/*.spec.ts` using `test.describe.serial`

Ensure consistent cleanup pattern:

```typescript
test.afterEach(async () => {
  // 1. Force-close modals (handled by enhanced coolHeapLight)
  await coolHeapLight(page);

  // 2. Optional: Reset UI store state if exposed
  await page.evaluate(() => {
    window.__CLEANSLATE_STORES__?.uiStore?.getState?.()?.reset?.();
  }).catch(() => {}); // Ignore if not exposed
});
```

---

### Phase 4: Audit Flaky Test Files

**Priority files to review/update:**

1. `e2e/tests/audit-details.spec.ts` - Already uses `expect.poll()`, verify timeouts are adequate
2. `e2e/tests/column-ordering.spec.ts` - Already uses fresh page per test, verify wait patterns
3. Any tests with `waitForTimeout()` calls - Replace with semantic waits

**Pattern to enforce:**
```typescript
// ❌ AVOID
await page.click('#transform-btn');
await expect(page.locator('.toast')).toBeVisible();
const data = await inspector.getTableData('my_table'); // Race condition

// ✅ CORRECT
await page.click('#transform-btn');
await inspector.waitForTransformComplete(tableId);  // Wait for data
const data = await inspector.getTableData('my_table');  // Guaranteed ready
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `playwright.config.ts` | Disable `fullyParallel`, reduce workers, increase expect timeout |
| `e2e/helpers/cleanup-helpers.ts` | Add Escape key to `coolHeapLight` for modal cleanup |

---

## Verification

1. **Run full test suite locally:**
   ```bash
   npm run test
   ```

2. **Run with CI simulation (single worker):**
   ```bash
   CI=true npm run test
   ```

3. **Run flaky test file multiple times:**
   ```bash
   npx playwright test e2e/tests/audit-details.spec.ts --repeat-each=5
   ```

4. **Check for `waitForTimeout` violations:**
   ```bash
   npm run test:lint-patterns
   ```

---

## Risk Assessment

- **Low risk:** Config changes are reversible and don't affect test logic
- **Low risk:** Escape key in cleanup - benign if no modals are open, helpful if they are
