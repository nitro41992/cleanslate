# E2E Test Stabilization Plan

## Summary

Stabilize E2E tests by increasing V8 memory limits, adding explicit OPFS skip logic, and enhancing fallback monitoring.

**Key Finding:** The `fr_c1_dedupe.csv` fixture is already minimal (8 rows, 444 bytes) - no reduction needed.

---

## Changes

### 1. Increase V8 Memory Limit (High Priority)

**File:** `playwright.config.ts`

Add `launchOptions` with memory flags to both projects:

```typescript
projects: [
  {
    name: 'chromium-memory-intensive',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        args: [
          '--js-flags=--max-old-space-size=4096',
          '--enable-precise-memory-info',
        ],
      },
    },
    testMatch: /memory-optimization|opfs-persistence/,
    fullyParallel: false,
  },
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        args: ['--js-flags=--max-old-space-size=4096'],
      },
    },
    testIgnore: /memory-optimization|opfs-persistence/,
  },
],
```

**Rationale:** Default V8 heap is ~1.7GB. This increases to 4GB, providing headroom for DuckDB-WASM (1.8GB limit) plus test framework overhead.

---

### 2. Add OPFS Skip Logic (Medium Priority)

**File:** `e2e/tests/opfs-persistence.spec.ts`

**Step A:** Add helper function after imports:

```typescript
async function checkOPFSSupport(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      if (typeof navigator.storage?.getDirectory !== 'function') return false
      if (typeof FileSystemFileHandle !== 'undefined') {
        return 'createSyncAccessHandle' in FileSystemFileHandle.prototype
      }
      return false
    } catch { return false }
  })
}
```

**Step B:** Add skip logic to all three `test.beforeAll` blocks:

```typescript
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto('/')

  const supportsOPFS = await checkOPFSSupport(page)
  if (!supportsOPFS) {
    test.skip(true, 'OPFS with sync access handles not supported')
    return
  }
  // ... rest of setup
})
```

**Step C:** Remove soft assertion patterns (replace if-else with direct assertions).

---

### 3. Enhance Fallback Monitoring (Low Priority)

**File:** `src/lib/commands/executor.ts`

**Step A:** Add metrics interface after `MAX_SNAPSHOTS_PER_TABLE`:

```typescript
interface FallbackMetrics {
  predicateSuccess: number
  baseColumnSuccess: number
  allRowsFallback: number
  allStrategiesFailed: number
}

let fallbackMetrics: FallbackMetrics = {
  predicateSuccess: 0,
  baseColumnSuccess: 0,
  allRowsFallback: 0,
  allStrategiesFailed: 0,
}
```

**Step B:** Add success logging for Strategies 1 and 2 (Strategy 3 already has logging):

```typescript
// After Strategy 1 succeeds:
fallbackMetrics.predicateSuccess++
console.log(`[EXECUTOR] Strategy 1 (predicate) succeeded: ${affectedRowIds.length} rows`)

// After Strategy 2 succeeds:
fallbackMetrics.baseColumnSuccess++
console.log(`[EXECUTOR] Strategy 2 (__base column) succeeded: ${affectedRowIds.length} rows`)
```

**Step C:** Add `getFallbackMetrics()` method to CommandExecutor class.

**Step D:** Reset metrics in `resetCommandExecutor()`.

---

## Files to Modify

| File | Change |
|------|--------|
| `playwright.config.ts` | Add launchOptions with V8 memory flags |
| `e2e/tests/opfs-persistence.spec.ts` | Add OPFS detection helper and skip logic |
| `src/lib/commands/executor.ts` | Add metrics tracking and enhanced logging |

---

## Verification

```bash
# 1. Verify memory-intensive tests pass without OOM
npm run test -- --project=chromium-memory-intensive

# 2. Verify OPFS tests skip on Firefox
npx playwright test opfs-persistence.spec.ts --browser=firefox
# Expected: "Skipped: OPFS with sync access handles not supported"

# 3. Run full test suite
npm run test

# 4. Check console output for fallback logging
npm run test:headed audit-undo-regression.spec.ts
# Look for: [EXECUTOR] Strategy N succeeded
```
