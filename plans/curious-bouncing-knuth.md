# Plan: Fix E2E Test Infrastructure for Browser Stability

## Context

**Current Status:**
- **1 test passing**: Test 2 (_cs_id lineage preservation) ✅
- **4 tests failing**: Tests 1, 3, 4, 17 - all crash with "Target page, context or browser has been closed"
- **6 tests skipped**: Due to serial mode failures

**Root Causes Identified:**

1. **DuckDB Memory Limit Too Low in Tests**
   - Test environment: 256MB (configured in `src/lib/duckdb/index.ts:145`)
   - Production: 1843MB (1.8 GB)
   - 500-row diff operations exceed 256MB, causing browser crashes

2. **afterEach Hook Missing DuckDB Reinitialization**
   - Current hook reloads page but doesn't wait for DuckDB to reinitialize
   - Tests start before DuckDB is ready, causing failures
   - Located in serial test groups (feature-coverage.spec.ts, memory-optimization.spec.ts)

3. **Playwright Limitations for Large Dataset Testing**
   - Playwright best practices: "not recommended" for serial mode
   - Browser contexts accumulate memory even with page reloads
   - Better suited for correctness testing, not scale testing

## Proposed Solution: Three-Tier Fix

### Fix 1: Increase Test Environment Memory (Immediate Hotfix)

**File:** `src/lib/duckdb/index.ts`
**Line:** 145

**Current:**
```typescript
const memoryLimit = isTestEnv ? '256MB' : '1843MB'
```

**Change to:**
```typescript
const memoryLimit = isTestEnv ? '1GB' : '1843MB'
```

**Rationale:**
- 256MB is insufficient for 500-row diff operations
- 1GB provides headroom while staying well below browser limits
- Chrome for Testing (Playwright 1.57+) has higher memory usage
- Production already uses 1843MB successfully

---

### Fix 2: Insert afterEach Hook with DuckDB Reinitialization

**Files to Modify:**
1. `e2e/tests/feature-coverage.spec.ts` (FR-B2: Visual Diff serial group)
2. `e2e/tests/memory-optimization.spec.ts` (Chunked Parquet serial group)

**Current State:**
- NO afterEach hook exists in these serial groups
- Tests currently run sequentially, accumulating memory until browser crashes

**Insert this afterEach hook:**
```typescript
test.afterEach(async () => {
  // Reload page after each test to prevent memory accumulation in serial mode
  await page.reload()
  await page.waitForLoadState('networkidle')

  // CRITICAL: Wait for DuckDB to reinitialize after reload
  // Without this, tests start before DuckDB is ready and fail
  await inspector.waitForDuckDBReady()
})
```

**Where to Insert:**
- **FR-B2: Visual Diff** (`feature-coverage.spec.ts`): After `test.afterAll` hook (around line 428)
- **Memory Optimization** (`memory-optimization.spec.ts`): After `test.afterAll` hook (around line 423)

**Data Persistence Safety:**
✅ **Safe to use** - All tests in these groups re-initialize their data:
- Upload CSV files at start of each test
- Run `DROP TABLE IF EXISTS` before creating tables
- No dependencies between tests

**Rationale:**
- `page.reload()` clears JavaScript state, including DuckDB instance and browser memory
- Wipes in-memory database (safe because tests reload data)
- DuckDB reinitialization takes 2-10 seconds (cold start)
- `waitForDuckDBReady()` ensures DuckDB is accessible before next test starts
- Prevents "Target page, context or browser has been closed" errors

---

### Fix 3: Long-Term Architecture - Headless Integration Tests (Optional)

**Philosophy:** Keep E2E tests small, move scale validation to headless integration tests

**E2E Tests (Playwright):**
- **Purpose:** Validate UI interactions and user workflows
- **Dataset Size:** 5-100 rows (minimal, fast)
- **What to Test:** Button clicks, dropdowns, navigation, visual feedback
- **Example:** "Test 2 validates _cs_id preservation logic with 100 rows"

**Headless Integration Tests (Direct DuckDB):**
- **Purpose:** Validate data processing correctness at scale
- **Dataset Size:** 10k-100k rows
- **What to Test:** SQL logic, transformations, diff algorithms
- **Implementation:** Node.js script that directly uses `window.__db` API
- **No browser UI:** Just DuckDB WASM + test assertions

**Example Headless Test Structure:**
```typescript
// e2e/integration/dedup-lineage.test.ts
import { AsyncDuckDB } from '@duckdb/duckdb-wasm'

test('remove_duplicates preserves _cs_id with 10k rows', async () => {
  const db = await initDuckDB()
  const conn = await db.connect()

  // Generate 10k rows programmatically
  await conn.query('CREATE TABLE test AS SELECT ...')

  // Run dedup transformation
  await conn.query('CREATE TABLE deduped AS SELECT DISTINCT ON (id) * FROM test')

  // Verify _cs_id preservation
  const result = await conn.query('SELECT COUNT(*) WHERE original._cs_id = deduped._cs_id')
  expect(result).toBe(3000)
})
```

**Benefits:**
- No browser memory overhead
- Faster execution (no UI rendering)
- Can test true "large file" scenarios (100k+ rows)
- E2E tests stay fast and stable

**Decision Point:** Implement now or defer?
- **Implement now:** If you want robust large-dataset validation
- **Defer:** If Fix 1 + Fix 2 make tests stable enough

---

## Critical Files to Modify

### Immediate Fixes (Required):
1. **`src/lib/duckdb/index.ts`**
   - Line 145: Change `'256MB'` → `'1GB'`

2. **`e2e/tests/feature-coverage.spec.ts`**
   - After line 428 (test.afterAll hook): **INSERT** new afterEach hook

3. **`e2e/tests/memory-optimization.spec.ts`**
   - After line 423 (test.afterAll hook): **INSERT** new afterEach hook

### Long-Term (Optional):
4. **`e2e/integration/` (new directory)**
   - Create headless integration test suite
   - Move large dataset tests from Playwright to Node.js

---

## Verification Strategy

### After Fix 1 + Fix 2:

Run regression tests:
```bash
npm test -- --grep "regression test|should preserve _cs_id lineage|should load.*Parquet snapshots|should prevent file locking errors"
```

**Expected Results:**
- ✅ Test 2 (_cs_id lineage): Still passes
- ✅ Test 1, 3, 4, 17: Now pass (no more browser crashes)
- ✅ All 10 regression tests pass
- ⏱️ Total runtime: ~10-15 minutes (serial mode with page reloads)

**Success Criteria:**
- Zero "Target page, context or browser has been closed" errors
- All waitForTableLoaded calls complete within timeout
- Console shows DuckDB reinitializing after each test: `[DuckDB] MVP bundle, 1GB limit, compression enabled`

### After Fix 3 (if implemented):

Run headless integration tests:
```bash
npm run test:integration
```

**Expected Results:**
- 10k-100k row tests run in < 1 minute
- No browser overhead
- Pure DuckDB logic validation

---

## Implementation Order

1. **Phase 1 (10 min):** Apply Fix 1 (increase memory to 1GB)
   - Test with: `npm test -- --grep "should preserve _cs_id lineage"`
   - Verify Test 2 still passes with higher memory limit

2. **Phase 2 (15 min):** Apply Fix 2 (add DuckDB reinitialization)
   - Test with full regression suite
   - Verify all tests pass

3. **Phase 3 (Optional, 2-3 hours):** Implement Fix 3 (headless tests)
   - Create integration test framework
   - Migrate large dataset tests
   - Update CI pipeline

---

## Risk Assessment

### Fix 1: Increase Memory to 1GB
- **Risk:** Low
- **Downside:** Slightly higher memory usage in tests (acceptable)
- **Upside:** Prevents browser crashes during diff operations

### Fix 2: Add DuckDB Reinitialization
- **Risk:** Low
- **Downside:** Tests run ~2-5s slower per test (acceptable)
- **Upside:** Ensures DuckDB is ready before each test, prevents flakes

### Fix 3: Headless Integration Tests
- **Risk:** Medium (new infrastructure)
- **Downside:** Requires new test framework, CI config
- **Upside:** Enables true large-file validation without browser limitations

---

## Success Criteria

✅ All 10 regression tests pass consistently
✅ No "Target page, context or browser has been closed" errors
✅ Test runtime acceptable (< 20 minutes for full suite)
✅ Tests validate critical bug fixes:
   - _cs_id lineage preservation
   - Internal column filtering
   - Diff operation stability
   - File locking prevention
