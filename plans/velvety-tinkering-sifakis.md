# Regression Testing: Large-Scale Dataset Validation

**Status:** 📝 PLANNING
**Branch:** `opfs-ux-polish`
**Date:** January 24, 2026
**Goal:** Add regression tests for recent bug fixes with 100k+ row datasets

---

## Executive Summary

**Recent Bug Fixes Requiring Test Coverage:**

1. **Diff Export Binder Error** (commit `98e335b`)
   - Bug: Large diff operations (>100k rows) crashed with "Binder Error: Referenced column _cs_id not found"
   - Fix: Added `getOrderByColumn()` to detect correct ORDER BY column (row_id vs _cs_id)
   - **Current Test Coverage:** ❌ NONE

2. **Standardize Performance** (commit `98e335b`)
   - Bug: 1M row standardize took 5-10 seconds
   - Fix: CommandMetadata optimization (skip snapshot, pre-audit, diff view, VACUUM)
   - Result: 1M rows now takes 0.5-1s (10x faster)
   - **Current Test Coverage:** ❌ NONE

3. **Diff RAM Spikes** (commit `39852ed`)
   - Bug: Diff operations caused permanent RAM increases
   - Fix: Added VACUUM after diff temp table cleanup
   - **Current Test Coverage:** ❌ NONE

4. **Diff Chunked Parquet NotFoundError** (commit `1270bee`) - **JUST FIXED**
   - Bug: Large diff (>250k rows) exported to chunked OPFS files but fetchDiffPage looked for single file
   - Error: "NotFoundError: A requested file or directory could not be found"
   - Fix: Updated fetchDiffPage() and cleanupDiffTable() to handle chunked files
   - **Current Test Coverage:** ❌ NONE

**Current State:** Only 1 test file (`memory-optimization.spec.ts`) tests large datasets, max 5k rows. No tests for 100k+ scenarios that exposed these bugs.

**Latest Discovery:** Found additional bug during testing - diff operations with 1M+ rows export to chunked OPFS files but UI fails to load them (NotFoundError). Fixed in commit `1270bee`.

---

## Test File Structure

### Create New File: `e2e/tests/large-scale-regression.spec.ts`

**Rationale:**
- Separate from existing memory tests (which focus on compression)
- Clear separation allows CI to skip large tests if needed
- Easier to manage timeouts for scale-specific scenarios

**Organization (by operation type):**
```
large-scale-regression.spec.ts
├── Serial Group 1: Diff Export Regression (100k-250k rows)
├── Serial Group 2: Standardize Performance Regression (100k-1M rows)
├── Serial Group 3: Memory Stability (VACUUM verification)
└── Serial Group 4: OPFS Chunking Boundary (250k threshold)
```

**Test Pattern:**
```typescript
test.describe.serial('Diff Export Regression (100k+ rows)', () => {
  let page: Page
  let inspector: StoreInspector
  let diffView: DiffViewPage

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    inspector = createStoreInspector(page)
    diffView = new DiffViewPage(page)
    await page.goto('/')
    await inspector.waitForDuckDBReady()  // Only once per group
  })

  test.afterAll(async () => {
    await page.close()
  })

  // Tests share same DuckDB context (fast)
})
```

---

## Dataset Generation Strategy

### Create Helper: `e2e/helpers/data-generator.ts`

**Programmatic Generation (Don't Commit Large CSVs):**
- 100k row CSV = ~5-10MB → bloats repo
- 1M row CSV = ~50MB → unacceptable
- Programmatic generation is fast (<1s for 100k rows)

**Generator Functions:**

```typescript
/**
 * Generate two tables for diff testing with controlled overlap
 */
export async function generateDiffTables(config: {
  rowCount: number
  addedPercent: number      // % rows only in Table B
  removedPercent: number    // % rows only in Table A
  modifiedPercent: number   // % rows in both but different values
  unchangedPercent: number  // % rows identical
}): Promise<{ tableA: File, tableB: File }>

/**
 * Generate table with duplicate values for standardization testing
 */
export async function generateStandardizeData(config: {
  rowCount: number
  uniqueValues: number      // e.g., 1000 unique names
  variantFactor: number     // e.g., 3 = each name has 3 variants
}): Promise<File>

/**
 * Generate generic large CSV
 */
export async function generateLargeCSV(
  rowCount: number,
  columns: Array<{name: string, type: 'id' | 'text' | 'email' | 'number' | 'date'}>
): Promise<File>
```

**Implementation Pattern (from existing memory-optimization.spec.ts):**
```typescript
async function generateLargeCSV(rowCount: number): Promise<File> {
  const lines = ['id,name,email,value']
  for (let i = 0; i < rowCount; i++) {
    lines.push(`${i},Name${i},email${i}@example.com,${Math.random()}`)
  }
  return new File([lines.join('\n')], `large_${rowCount}.csv`, { type: 'text/csv' })
}
```

**Performance:** 100k rows generated in ~500ms, 1M rows in ~5s

---

## Test Scenarios (Priority Order)

### CRITICAL Priority - Regression Prevention

#### Test 1: Diff Export Binder Error Fix (100k rows)

**File:** `large-scale-regression.spec.ts:20-80`

**Scenario:**
1. Generate Table A (100k rows)
2. Generate Table B (100k rows, 10% modified from A)
3. Upload both tables
4. Open Diff panel → Compare Two Tables mode
5. Select both tables, choose `id` as key column
6. Run comparison (creates temp table with 110k rows)
7. Export diff results as CSV
8. Verify: No "Binder Error: Referenced column _cs_id not found"

**Assertions:**
```typescript
// High-fidelity: Verify export completes
await expect(page.getByText('Export complete')).toBeVisible({ timeout: 60000 })

// Verify file downloaded
const download = await downloadPromise
expect(download.suggestedFilename()).toContain('_diff_')

// Verify row count (100k unchanged + 10k modified)
const exportedData = await parseCSV(await download.path())
expect(exportedData.length).toBe(110_000)

// CRITICAL: Verify diff columns (row_id, not _cs_id)
const columns = Object.keys(exportedData[0])
expect(columns).toContain('row_id')
expect(columns).toContain('diff_status')
```

**Data Characteristics:**
```typescript
const { tableA, tableB } = await generateDiffTables({
  rowCount: 100_000,
  addedPercent: 0,
  removedPercent: 0,
  modifiedPercent: 10,
  unchangedPercent: 90
})
```

**Performance Threshold:** Export completes in < 30s for 100k rows

**Timeout:** 120s (diff + export)

---

#### Test 2: Standardize Performance Fix (100k rows)

**File:** `large-scale-regression.spec.ts:85-150`

**Scenario:**
1. Generate table with 100k rows, 1000 unique names (100 variants each)
2. Upload to Data Laundromat
3. Open Value Standardization panel
4. Select column, run fingerprint clustering
5. Select all clusters → Apply standardization
6. Measure total execution time

**Assertions:**
```typescript
const startTime = performance.now()

// ... run standardization ...

const endTime = performance.now()
const executionTime = endTime - startTime

// CRITICAL: Must complete in < 2 seconds (was 5-10s before fix)
expect(executionTime).toBeLessThan(2000)

// Verify audit entry created
const auditEntries = await inspector.getAuditEntries(tableId)
const standardizeEntry = auditEntries.find(e => e.action.includes('Standardize'))
expect(standardizeEntry).toBeDefined()
expect(standardizeEntry.rowsAffected).toBe(expectedRowsAffected)

// Verify CommandMetadata optimization flags used
// (No snapshot created, no diff view created)
const tables = await inspector.getTables()
const snapshotTables = tables.filter(t => t.name.includes('snapshot_'))
expect(snapshotTables.length).toBe(0)  // No snapshot for standardize
```

**Data Characteristics:**
```typescript
const csvFile = await generateStandardizeData({
  rowCount: 100_000,
  uniqueValues: 1000,
  variantFactor: 100  // "John Smith", "JOHN SMITH", "john smith", etc.
})
```

**Performance Thresholds:**
- 100k rows: < 2s ✅
- 250k rows: < 5s (if tested)
- 500k rows: < 10s (if tested)

**Timeout:** 30s (generous, should complete in ~1s)

---

#### Test 3: Memory Stability (VACUUM Fix)

**File:** `large-scale-regression.spec.ts:155-220`

**Scenario:**
1. Load table with 100k rows
2. Capture baseline memory
3. Run diff comparison (creates temp table)
4. Close diff
5. Capture memory after first diff
6. Run diff again (2nd comparison)
7. Close diff
8. Capture memory after second diff
9. Verify memory returns to baseline (< 50MB delta)

**Assertions:**
```typescript
const memBefore = await getMemoryUsage(page)

// Run 3 diff operations
for (let i = 0; i < 3; i++) {
  await diffView.selectCompareTwoTablesMode()
  await diffView.runComparison()
  await diffView.close()
}

const memAfter = await getMemoryUsage(page)
const memoryDelta = memAfter - memBefore

// CRITICAL: Memory should return to baseline after VACUUM
expect(memoryDelta).toBeLessThan(50 * 1024 * 1024)  // < 50MB

// Verify VACUUM was executed (check console logs)
const logs = await page.evaluate(() => window.__CONSOLE_LOGS__)
expect(logs.some(log => log.includes('VACUUM completed'))).toBe(true)
```

**Helper Function:**
```typescript
async function getMemoryUsage(page: Page): Promise<number> {
  // Chrome only: performance.memory API
  return await page.evaluate(() => {
    if ('memory' in performance) {
      return (performance as any).memory.usedJSHeapSize
    }
    return 0  // Graceful degradation for non-Chrome browsers
  })
}
```

**Timeout:** 120s (multiple diff operations)

---

#### Test 4: OPFS Chunking Boundary (250k rows)

**File:** `large-scale-regression.spec.ts:225-280`

**Scenario:**
1. Generate table with 250,001 rows (just over chunking threshold)
2. Upload to Data Laundromat
3. Trigger snapshot creation (run a Tier 3 transform like remove_duplicates)
4. Verify chunked Parquet files created in OPFS
5. Verify import from chunked snapshot works correctly

**Assertions:**
```typescript
// Trigger snapshot creation
await transformPicker.addTransformation('Remove Duplicates', {
  column: 'id'
})
await laundromat.clickRunRecipe()

// Verify chunked file pattern in OPFS
const opfsFiles = await inspector.runQuery(`
  SELECT * FROM glob('/cleanslate/snapshots/*.parquet')
`)

// CRITICAL: Should use _part_0, _part_1 naming for >250k rows
const chunkFiles = opfsFiles.filter(f => f.path.includes('_part_'))
expect(chunkFiles.length).toBeGreaterThan(0)
expect(chunkFiles.some(f => f.path.includes('_part_0'))).toBe(true)

// Verify undo works with chunked snapshot
await executor.undo(tableId)
const restoredData = await inspector.getTableData(tableName, 5)
expect(restoredData.length).toBe(5)  // Sample verification
```

**Timeout:** 120s (250k row operations)

---

#### Test 5: Diff Chunked Parquet Loading (250k+ rows)

**File:** `large-scale-regression.spec.ts:285-350`

**Scenario:**
1. Generate Table A (300k rows)
2. Generate Table B (300k rows, 10% modified)
3. Upload both tables
4. Run diff comparison (creates 330k row result → triggers chunked export)
5. **CRITICAL:** View diff results in grid
6. Verify: No "NotFoundError" when loading chunked Parquet files
7. Scroll through diff results (triggers pagination)
8. Close diff → verify cleanup removes all chunk files

**Assertions:**
```typescript
// Verify diff completed and exported to OPFS
await expect(page.getByText(/Diff completed/i)).toBeVisible({ timeout: 120000 })

// CRITICAL: Verify grid loads from chunked files (no NotFoundError)
await expect(page.getByRole('grid')).toBeVisible({ timeout: 30000 })

// Verify first row loads
const firstRow = await page.getByRole('gridcell').first()
await expect(firstRow).toBeVisible()

// Check console for chunked file pattern
const logs = await page.evaluate(() => {
  return (window as any).__CONSOLE_LOGS__ || []
})
const chunkLog = logs.find(log => log.includes('_part_') && log.includes('.parquet'))
expect(chunkLog).toBeDefined()  // Should see chunked file logs

// Scroll to trigger pagination (load from chunk files)
await page.mouse.wheel(0, 1000)
await page.waitForTimeout(1000)

// Close diff
await page.getByRole('button', { name: /close/i }).click()

// Verify cleanup removed chunk files
const opfsFiles = await inspector.runQuery(`
  SELECT * FROM glob('/cleanslate/snapshots/*.parquet')
`)
const diffChunks = opfsFiles.filter(f => f.path.includes('_diff_') && f.path.includes('_part_'))
expect(diffChunks.length).toBe(0)  // All chunks cleaned up
```

**Data Characteristics:**
```typescript
const { tableA, tableB } = await generateDiffTables({
  rowCount: 300_000,  // Above 250k chunking threshold
  addedPercent: 0,
  removedPercent: 0,
  modifiedPercent: 10,
  unchangedPercent: 90
})
```

**Performance Threshold:** Grid loads in < 10s from chunked OPFS files

**Timeout:** 180s (large diff + chunked file operations)

---

### HIGH Priority - Scale Validation

#### Test 6: Diff Export at OPFS Chunking Boundary (250k rows)

**Scenario:** Same as Test 1, but with 250k rows to verify chunked Parquet export

**Performance Threshold:** < 60s for 250k row diff export

#### Test 7: Standardize Stress Test (500k rows)

**Scenario:** Same as Test 2, but with 500k rows to verify optimization holds at scale

**Performance Threshold:** < 10s for 500k row standardize

---

## Performance Thresholds Reference

**Expected Execution Times:**

| Operation | 50k rows | 100k rows | 250k rows | 500k rows | 1M rows |
|-----------|----------|-----------|-----------|-----------|---------|
| **Diff Export** | < 5s | < 15s | < 30s | < 60s | < 120s |
| **Standardize** | < 1s | < 2s | < 5s | < 10s | < 20s |
| **Snapshot (Parquet)** | < 2s | < 3s | < 5s | < 8s | < 15s |
| **Import (Parquet)** | < 2s | < 3s | < 5s | < 8s | < 15s |

**Memory Thresholds:**

| Operation | Expected RAM Delta | Max Acceptable |
|-----------|-------------------|----------------|
| **Diff (temp table)** | +100-200MB | +300MB |
| **After VACUUM** | Baseline | +50MB |
| **Snapshot Export** | +50MB (buffer) | +150MB |
| **Standardize (100k)** | +20MB | +100MB |

---

## CI/Local Execution Strategy

### Environment-Based Test Skipping

**Configuration:**
```typescript
// large-scale-regression.spec.ts
const LARGE_SCALE_TESTS_ENABLED =
  process.env.RUN_LARGE_TESTS === 'true' || !process.env.CI

test.describe.serial('Large Scale Regression', () => {
  test.skip(!LARGE_SCALE_TESTS_ENABLED, 'Skipping large tests in CI')

  // All large-scale tests
})
```

**Default Behavior:**
- **CI:** Skip large tests (save runtime, fast feedback)
- **Local:** Always run (catch regressions early)

**Manual Trigger:**
```bash
# Run all tests including large-scale
RUN_LARGE_TESTS=true npm test

# Run only large-scale tests
npm test large-scale-regression.spec.ts
```

**Rationale:**
- Large tests add ~5-10 minutes to CI runtime
- Most commits don't affect large-scale behavior
- Manual trigger available for critical changes (diff, standardize, memory)

---

## Implementation Sequence

### Phase 1: Foundation (Week 1)

**Day 1-2: Data Generator**
- Create `e2e/helpers/data-generator.ts`
- Implement `generateDiffTables()` (100k rows in ~500ms)
- Implement `generateStandardizeData()` (100k rows with duplicates)
- Implement `generateLargeCSV()` (generic large dataset)

**Day 3-4: Test File Setup**
- Create `e2e/tests/large-scale-regression.spec.ts`
- Set up serial groups with shared DuckDB context
- Add memory tracking helper (`getMemoryUsage()`)

**Day 5: Diff Export Test (Test 1)**
- Implement 100k row diff export test
- Verify binder error fix
- Add performance assertions (< 30s)

### Phase 2: Core Regression Tests (Week 2)

**Day 1-2: Standardize Performance Test (Test 2)**
- Implement 100k row standardize test
- Verify < 2s execution time
- Verify CommandMetadata optimizations

**Day 3-4: Memory Stability Test (Test 3)**
- Implement VACUUM regression test
- Add memory tracking before/after diff
- Verify < 50MB delta after 3 diff operations

**Day 5: OPFS Chunking Test (Test 4)**
- Implement 250k row chunking boundary test
- Verify `_part_0.parquet` files created
- Test undo with chunked snapshots

### Phase 3: Scale Testing (Week 3 - Optional)

**Day 1-2: 250k Row Tests**
- Add Test 5: Diff export with 250k rows
- Verify chunked Parquet export works

**Day 3-4: 500k Row Tests**
- Add Test 6: Standardize with 500k rows
- Verify < 10s threshold

**Day 5: Documentation & Baselines**
- Document performance baselines
- Update CLAUDE.md with new test patterns
- Create README in `e2e/tests/` explaining large-scale tests

---

## Critical Files to Modify

### New Files (Create)

1. **`e2e/helpers/data-generator.ts`** (~150 lines)
   - `generateDiffTables()` - Generate 2 tables with controlled overlap
   - `generateStandardizeData()` - Generate data with duplicate variants
   - `generateLargeCSV()` - Generic large dataset generator

2. **`e2e/tests/large-scale-regression.spec.ts`** (~400 lines)
   - Serial Group 1: Diff Export Regression (Test 1, Test 5)
   - Serial Group 2: Standardize Performance (Test 2, Test 6)
   - Serial Group 3: Memory Stability (Test 3)
   - Serial Group 4: OPFS Chunking (Test 4)

3. **`e2e/helpers/memory-tracker.ts`** (~50 lines)
   - `getMemoryUsage()` - Chrome performance.memory API wrapper
   - `trackMemoryDelta()` - Before/after helper

### Modified Files

4. **`playwright.config.ts`** (update timeout for large tests)
   ```typescript
   projects: [
     {
       name: 'chromium',
       use: {
         ...devices['Desktop Chrome'],
         launchOptions: {
           args: ['--enable-precise-memory-info']  // For performance.memory
         }
       },
     },
   ]
   ```

5. **`package.json`** (add test commands)
   ```json
   "scripts": {
     "test:large": "playwright test large-scale-regression.spec.ts",
     "test:quick": "playwright test --ignore-snapshots large-scale-regression.spec.ts"
   }
   ```

---

## Verification Plan

### End-to-End Test Verification

**Step 1: Run Tests Locally**
```bash
# Run all large-scale tests
npm test large-scale-regression.spec.ts

# Verify all 4 critical tests pass
# Expected output:
# ✅ should export diff results with 100k+ rows (binder error fix)
# ✅ should standardize 100k rows in < 2 seconds
# ✅ should maintain stable RAM during multiple diff operations
# ✅ should use chunked Parquet export at 250k boundary
```

**Step 2: Verify Performance Thresholds**
- Diff export 100k rows: Completes in < 30s
- Standardize 100k rows: Completes in < 2s
- Memory delta after 3 diffs: < 50MB
- Chunked files created at 250k boundary

**Step 3: Verify CI Behavior**
```bash
# Simulate CI environment
CI=true npm test

# Expected: Large tests skipped
# Output: "Skipping large tests in CI"

# Manual trigger
RUN_LARGE_TESTS=true npm test
# Expected: All tests run
```

**Step 4: Regression Verification**
- Revert fix in `snapshot-storage.ts` (remove `getOrderByColumn()`)
- Run Test 1 → Should FAIL with binder error ✅
- Restore fix → Test 1 passes ✅

- Revert fix in `registry.ts` (remove CommandMetadata for standardize)
- Run Test 2 → Should FAIL with timeout (> 2s) ✅
- Restore fix → Test 2 passes ✅

### Success Criteria

**Regression Prevention:**
- ✅ Diff export binder error never occurs again (100k+ rows)
- ✅ Standardize stays < 2s for 100k rows
- ✅ Memory returns to baseline after diff operations
- ✅ OPFS chunking works correctly at 250k boundary

**Scale Confidence:**
- ✅ All critical operations handle 100k rows gracefully
- ✅ Performance thresholds documented and enforced
- ✅ Test suite completes in < 10 minutes (with large tests enabled)

**Developer Experience:**
- ✅ Large tests run locally by default (catch regressions early)
- ✅ Large tests skipped in CI by default (fast feedback)
- ✅ Manual trigger available for thorough validation
- ✅ Clear documentation of test patterns

---

## Risk Assessment

**Risk Level:** 🟢 LOW

**Risks:**

1. **Large tests may be flaky in CI**
   - Mitigation: Skip by default, manual trigger for validation
   - Impact: Low (local tests still catch regressions)

2. **Performance thresholds may vary across machines**
   - Mitigation: Conservative thresholds with 2x safety margin
   - Impact: Low (failures indicate real regressions, not false positives)

3. **Data generation may be slow**
   - Mitigation: Optimize with batch string concatenation
   - Impact: Low (100k rows in ~500ms is acceptable)

**Benefits:**
- ✅ Prevents regression of critical bug fixes
- ✅ Validates large-scale performance optimizations
- ✅ Builds confidence in OPFS chunking and memory management
- ✅ Establishes baseline for future performance work

---

## Notes

**Why Not Use Committed Fixtures?**
- 100k row CSV = ~5-10MB → bloats repo
- 1M row CSV = ~50MB → unacceptable for version control
- Programmatic generation is fast and flexible

**Why Skip in CI by Default?**
- Large tests add 5-10 minutes to CI runtime
- Most commits don't affect large-scale behavior
- Manual trigger provides safety net for critical changes

**Future Enhancements:**
- Add 1M row test suite (optional, very slow)
- Add streaming export verification for gigabyte-scale data
- Add concurrent operation testing (multiple users)
- Add browser memory leak detection (extended sessions)
