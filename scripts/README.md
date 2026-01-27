# E2E Test Monitoring Scripts

This directory contains monitoring and analysis tools for the CleanSlate E2E test suite, implementing Phase 3 of the flaky test mitigation plan.

## Available Scripts

### 1. Pattern Detection (`detect-flaky-patterns.ts`)

**Purpose:** Automatically detect common flakiness patterns in test code.

**Usage:**
```bash
npm run test:lint-patterns
```

**What it Detects:**
- `picker.apply()` without `waitForTransformComplete()`
- `waitForTimeout()` usage (violates "No Sleep" rule)
- `Promise.race()` for operation completion detection
- `editCell()` without prior `waitForGridReady()`
- Cardinality assertions instead of identity assertions

**When to Run:**
- Before committing new tests
- During code review
- Weekly as part of test health check
- In CI as a warning (not blocker)

**Example Output:**
```
⚠️  Found 15 potential flakiness issues:

e2e/tests/audit-details.spec.ts:396
  Pattern: editCell() without prior waitForGridReady()
  Suggestion: Add await inspector.waitForGridReady() before grid interaction
```

---

### 2. Flakiness Analysis (`analyze-flaky-tests.ts`)

**Purpose:** Track which tests are flaky and trending over time.

**Usage:**
```bash
# First run tests with JSON reporter
npx playwright test --reporter=json

# Then analyze the results
npm run test:analyze
```

**What it Does:**
- Parses Playwright JSON report
- Identifies flaky tests (passed on retry)
- Identifies failed tests (all attempts failed)
- Calculates flakiness rate
- Stores historical data in `test-results/`
- Fails if flakiness rate exceeds 5% threshold

**Output:**
- Console summary of flaky and failed tests
- JSON report saved to `test-results/YYYY-MM-DD-flaky-report.json`

**Example Output:**
```
📊 Test Results Summary
========================
Flaky Tests: 3
Failed Tests: 0

⚠️  Flaky Tests:
  - e2e/tests/export.spec.ts:FR-B1: Export CSV (2 retries, 12s)

📝 Report written to: test-results/2026-01-27-flaky-report.json
✅ Flakiness rate: 4% (threshold: 5%)
```

**Historical Tracking:**
```bash
# View trend over time
ls test-results/*-flaky-report.json
cat test-results/$(ls -t test-results/*-flaky-report.json | head -1)
```

---

### 3. Memory Monitor Helper (`e2e/helpers/memory-monitor.ts`)

**Purpose:** Detect memory leaks before they cause "Target Closed" crashes.

**Usage in Tests:**
```typescript
import { logMemoryUsage, assertMemoryUnderLimit } from '../helpers/memory-monitor'

test('fuzzy matcher with large dataset', async ({ page }) => {
  await logMemoryUsage(page, 'before load')

  await laundromat.uploadFile(getFixturePath('large-dataset.csv'))
  await wizard.import()
  await logMemoryUsage(page, 'after import')

  await matchView.findDuplicates()
  await inspector.waitForMergeComplete()
  await logMemoryUsage(page, 'after matching')

  // Assert cleanup worked
  await coolHeap(page, inspector, { dropTables: true })
  await assertMemoryUnderLimit(page, 60, 'after cleanup') // Should be <60%
})
```

**Functions:**
- `logMemoryUsage(page, label)` - Logs current heap usage
- `assertMemoryUnderLimit(page, maxPercent, label)` - Throws if usage exceeds threshold

**When to Use:**
- Heavy tests (Parquet files, large CSVs, matcher operations)
- Serial test groups with state accumulation
- When investigating "Target Closed" errors

**Example Output:**
```
[Memory before load] 45MB / 512MB (9%)
[Memory after import] 123MB / 512MB (24%)
[Memory after matching] 287MB / 512MB (56%)
⚠️  High memory usage: 82%
```

---

## Integration with CI

### Optional: Add to GitHub Actions

```yaml
# .github/workflows/e2e-tests.yml
- name: Run E2E tests
  run: npx playwright test --reporter=json

- name: Analyze test flakiness
  if: always()
  run: npm run test:analyze

- name: Upload flakiness report
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: flakiness-report
    path: test-results/*-flaky-report.json
```

---

## Monitoring Workflow

### Weekly Health Check
```bash
# 1. Run full test suite with JSON reporter
npx playwright test --reporter=json

# 2. Analyze flakiness
npm run test:analyze

# 3. Check for pattern violations
npm run test:lint-patterns

# 4. Review historical trends
cat test-results/$(ls -t test-results/*-flaky-report.json | head -1)
```

### Before Committing New Tests
```bash
# Run pattern detection to catch issues early
npm run test:lint-patterns
```

### After Test Failures
```bash
# 1. Review flaky tests
npm run test:analyze

# 2. Add memory monitoring to failing tests
# (see memory-monitor.ts usage above)

# 3. Check for anti-patterns
npm run test:lint-patterns
```

---

## Thresholds and Alerts

### Flakiness Rate Threshold: 5%
- **Green (0-5%):** Acceptable - monitor trends
- **Yellow (5-10%):** Warning - investigate flaky tests
- **Red (>10%):** Critical - immediate action required

### Memory Usage Thresholds:
- **<60%:** Healthy - normal operation
- **60-80%:** Elevated - monitor for leaks
- **>80%:** Critical - cleanup needed or memory leak

---

## Troubleshooting

### "Report file not found" error
```bash
# Make sure to run tests with JSON reporter first
npx playwright test --reporter=json
```

### Pattern detection false positives
- `editCell()` warnings: Some tests properly wait via other means (e.g., `waitForTableLoaded()`)
- Cardinality assertions: Acceptable for dynamic data (UUIDs, timestamps)
- These are warnings, not errors - use judgment

### Memory monitoring shows `null`
- Chrome's `performance.memory` API may be unavailable
- Memory monitoring is optional - tests will still pass

---

## Related Documentation

- **Plan:** `plans/happy-jingling-scroll.md` - Full mitigation plan (Phase 1-3)
- **Guidelines:** `e2e/CLAUDE.md` - E2E testing best practices
- **Helpers:** `e2e/helpers/` - Wait helpers, cleanup utilities, store inspector
