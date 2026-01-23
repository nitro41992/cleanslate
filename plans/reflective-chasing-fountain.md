# Plan: Fix Test Failures & Highlight Feature

## Problem Summary

The test suite has two critical issues:

1. **Highlight Feature Bug (FR-REGRESSION-2)**: Highlight button returns `rowCount=0` when it should show affected rows
2. **Test Timeouts in audit-details.spec.ts**: Tests timing out at column selection, causing cascade failures

## Root Cause Analysis

### Issue 1: Highlight Feature Returns rowCount=0

**Data Flow:**
```
CommandExecutor.execute()
  ├─ Step 6: Creates diff view (v_diff_step_X) with _row_id and _change_type columns
  ├─ Step 7: Records timeline with highlightInfo (contains rowPredicate only)
  └─ Line 265: syncExecuteToTimelineStore() called WITHOUT affectedRowIds
       ├─ Line 868-873: appendCommand() called with options but NO affectedRowIds
       └─ timelineStore stores command with affectedRowIds = undefined
            └─ setHighlightedCommand() creates: rowIds: new Set([]) ← EMPTY SET
```

**Root Cause:**
- Diff view IS created correctly with `_row_id` column
- `affectedRowIds` are NEVER extracted from the diff view
- `syncExecuteToTimelineStore()` doesn't accept or pass affectedRowIds parameter
- `timelineStore.appendCommand()` always receives `undefined` for affectedRowIds
- Highlighting fails because `rowIds` Set is always empty

### Issue 2: Test Timeout at picker.selectColumn()

**Timeline:**
1. Test starts at line 46: `await loadTestData()` (~17-23s total)
2. Line 49: `await laundromat.openCleanPanel()` (~2-3s)
3. Line 50: `await picker.waitForOpen()` (~1-2s)
4. Line 51: `await picker.addTransformation('Find & Replace', { column: 'name' })`
   - Calls `selectTransformation()` - succeeds
   - Calls `selectColumn('name')` at transformation-picker.page.ts:40 - **TIMES OUT**
   - Race condition: Column dropdown not fully rendered before click attempt
   - No explicit wait for visibility
   - After 60s test timeout, Playwright kills page context
   - Error: "Target page has been closed" (secondary symptom)

**Root Cause:**
- `selectColumn()` method (lines 38-42) clicks combobox immediately without waiting for visibility
- Column selector only renders AFTER transformation is selected AND `requiresColumn=true`
- React rendering race condition - DOM element not ready when Playwright tries to click

### Issue 3: Duplicate DuckDB Initialization

**Structure:**
- audit-details.spec.ts has TWO separate `test.describe.serial` blocks:
  - Block 1 (line 16-207): 6 tests using `case-sensitive-data.csv`
  - Block 2 (line 209-428): 4 tests using `whitespace-data.csv`
- Each block initializes DuckDB independently in `beforeAll` hook
- **Waste:** 2-10s duplicated DuckDB cold start

### Issue 4: Sequential Execution (Low Priority)

**Configuration:**
- `workers: 1` forces sequential execution of 33 serial test groups
- Despite `fullyParallel: true`, only 1 worker available
- **Impact:** 30-60+ minute total test time
- **Historical reason:** "Force single worker to prevent OOM on constrained systems"

## Implementation Plan

### Part 1: Fix Highlight Feature (HIGHEST PRIORITY - Core Business Logic)

**Critical Files:**
- `src/lib/commands/executor.ts` (lines 229-265, 834-874)
- `src/stores/timelineStore.ts` (lines 171-228) - NO CHANGES NEEDED

**Implementation Steps:**

#### Step 1.1: Add Row ID Extraction Method

**Location:** executor.ts, after `captureTier1RowDetails()` method (~line 830)

```typescript
/**
 * Extract affected row IDs from diff view for highlighting support.
 * Non-critical - returns empty array if extraction fails.
 * Limits to MAX_HIGHLIGHT_ROWS to prevent OOM on large datasets.
 *
 * Note: Diff views (created by createTier1DiffView and createTier3DiffView)
 * explicitly alias _cs_id as _row_id, so this column is guaranteed to exist.
 */
private async extractAffectedRowIds(
  ctx: CommandContext,
  diffViewName: string | undefined
): Promise<string[]> {
  if (!diffViewName) return []

  try {
    const MAX_HIGHLIGHT_ROWS = 10000

    const sql = `
      SELECT _row_id
      FROM "${diffViewName}"
      WHERE _change_type != 'unchanged'
      LIMIT ${MAX_HIGHLIGHT_ROWS}
    `

    const result = await ctx.db.query<{ _row_id: string }>(sql)
    // Explicit string conversion for type safety (though _cs_id is already VARCHAR/UUID)
    return result.map(row => String(row._row_id))
  } catch (err) {
    console.warn('[EXECUTOR] Failed to extract affected row IDs from diff view:', err)
    return []
  }
}
```

**Rationale:**
- 10k row limit prevents memory issues on large transformations
- Try-catch ensures non-critical feature doesn't block command execution
- Filters `_change_type != 'unchanged'` to only get modified rows

#### Step 1.2: Call Extraction After Diff View Creation

**Location:** executor.ts, line 242 (after diff view creation, before timeline recording)

```typescript
// Step 6: Diff view
let diffViewName: string | undefined
if (!skipDiffView) {
  progress('diffing', 70, 'Creating diff view...')
  const rowPredicate = await command.getAffectedRowsPredicate(updatedCtx)
  const affectedColumn = (command.params as { column?: string })?.column || null
  diffViewName = await this.createDiffView(
    updatedCtx,
    tier,
    rowPredicate,
    affectedColumn,
    snapshotTableName
  )
}

// NEW: Extract affected row IDs from diff view
const affectedRowIds = await this.extractAffectedRowIds(updatedCtx, diffViewName)
```

#### Step 1.3: Update syncExecuteToTimelineStore Signature

**Location:** executor.ts, line 834 (method signature)

```typescript
private syncExecuteToTimelineStore(
  tableId: string,
  tableName: string,
  command: Command,
  auditInfo?: { affectedColumns: string[]; rowsAffected: number; hasRowDetails: boolean; auditEntryId: string },
  affectedRowIds?: string[]  // NEW PARAMETER
): void {
```

#### Step 1.4: Pass affectedRowIds to appendCommand

**Location:** executor.ts, line 868 (inside syncExecuteToTimelineStore)

```typescript
timelineStoreState.appendCommand(tableId, legacyCommandType, command.label, timelineParams, {
  auditEntryId: auditInfo?.auditEntryId ?? command.id,
  affectedColumns: auditInfo?.affectedColumns ?? (column ? [column] : []),
  rowsAffected: auditInfo?.rowsAffected,
  hasRowDetails: auditInfo?.hasRowDetails,
  affectedRowIds,  // NEW: Pass extracted row IDs
})
```

#### Step 1.5: Update Call Site

**Location:** executor.ts, line 265 (call to syncExecuteToTimelineStore)

```typescript
// Sync with legacy timelineStore for UI integration (highlight, drill-down)
this.syncExecuteToTimelineStore(
  ctx.table.id,
  ctx.table.name,
  command,
  auditInfo,
  affectedRowIds  // NEW: Pass extracted row IDs
)
```

**Edge Cases Handled:**
- Diff view doesn't exist → returns empty array immediately
- Query fails → try-catch returns empty array, logs warning
- Large datasets (100k+ rows) → LIMIT 10000 prevents OOM
- skipDiffView option → diffViewName is undefined, extraction returns []

**Testing Impact:**
- FR-REGRESSION-2 should pass (highlight rowCount > 0)
- Highlight button works correctly in UI

---

### Part 2: Fix Test Timeout (HIGH PRIORITY - Test Reliability)

**Critical Files:**
- `e2e/page-objects/transformation-picker.page.ts` (lines 38-42)

**Implementation Steps:**

#### Step 2.1: Add Explicit Waits to selectColumn Method

**Location:** transformation-picker.page.ts, lines 38-42

**Current Code:**
```typescript
async selectColumn(columnName: string): Promise<void> {
  const columnSelect = this.page.locator('[role="combobox"]').filter({ hasText: /Select column/ })
  await columnSelect.click()
  await this.page.getByRole('option', { name: columnName }).click()
}
```

**Updated Code:**
```typescript
async selectColumn(columnName: string): Promise<void> {
  // Wait for column selector to be visible (renders after transformation selected)
  const columnSelect = this.page.locator('[role="combobox"]').filter({ hasText: /Select column/ })
  await columnSelect.waitFor({ state: 'visible', timeout: 10000 })
  await columnSelect.click()

  // Wait for dropdown to open and option to be available
  const option = this.page.getByRole('option', { name: columnName })
  await option.waitFor({ state: 'visible', timeout: 5000 })
  await option.click()
}
```

**Rationale:**
- Explicit wait for column selector visibility before clicking
- Explicit wait for option visibility after dropdown opens
- Prevents race condition with React rendering
- Reasonable timeouts (10s for selector, 5s for option)

**Testing Impact:**
- audit-details.spec.ts Test 1 should no longer timeout at line 51
- All tests using `picker.addTransformation({ column: 'name' })` stabilized

---

### Part 3: Merge Duplicate Serial Blocks (MEDIUM PRIORITY - Performance)

**Critical Files:**
- `e2e/tests/audit-details.spec.ts` (lines 16-428)

**Implementation Steps:**

#### Step 3.1: Consolidate into Single Serial Block

**Current Structure:**
- Block 1 (lines 16-207): 6 tests, DuckDB init line 23-30
- Block 2 (lines 209-428): 4 tests, DuckDB init line 216-223

**New Structure:**
```typescript
test.describe.serial('Audit Row Details', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    // Single DuckDB initialization for all 10 tests
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()  // Only once!
  })

  test.afterAll(async () => {
    await page.close()
  })

  // Helper for case-sensitive data (used by tests 1-6)
  async function loadCaseSensitiveData() {
    await inspector.runQuery('DROP TABLE IF EXISTS case_sensitive_data')
    await laundromat.uploadFile(getFixturePath('case-sensitive-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('case_sensitive_data', 4)
  }

  // Helper for whitespace data (used by tests 7-10)
  async function loadWhitespaceData() {
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)
  }

  // Tests 1-6: Use loadCaseSensitiveData()
  test('should set hasRowDetails and auditEntryId after transformation', async () => {
    await loadCaseSensitiveData()
    // ... rest of test
  })

  // ... tests 2-6 with loadCaseSensitiveData()

  // Tests 7-10: Use loadWhitespaceData()
  test('should capture row details for trim transformation', async () => {
    await loadWhitespaceData()
    // ... rest of test
  })

  // ... tests 8-10 with loadWhitespaceData()
})
```

**Benefits:**
- Single DuckDB initialization (saves 2-10s)
- Tests remain independent via helper functions
- Follows existing pattern from transformations.spec.ts
- Eliminates duplicate page setup/teardown

**Testing Impact:**
- audit-details.spec.ts runs 2-10s faster
- Reduced risk of timeout cascades (fewer page contexts)

---

### Part 4: Optimize Workers Configuration (OPTIONAL - Overall Performance)

**Critical Files:**
- `playwright.config.ts` (line 8)

**Implementation:**

**Current:**
```typescript
workers: 1,  // Force single worker to prevent OOM on constrained systems
```

**Recommended (Conservative - Start Here):**
```typescript
workers: process.env.CI ? 2 : 1,  // Conservative parallelism, proven safe
```

**Alternative (Aggressive - Only if CI has 4+ vCPUs):**
```typescript
workers: process.env.CI ? 4 : 2,  // More aggressive, requires verification
```

**Rationale:**
- **Recommended approach:** CI uses 2 workers (safe for 2 vCPU / 7GB runners), local stays at 1
- **Memory per worker:** ~256MB DuckDB + ~200-300MB browser context = ~500-600MB total
- **CI safety:** 2 workers × 600MB = ~1.2GB peak (safe for 7GB runners)
- **Aggressive approach:** Only use 4 workers if CI runner has 4+ vCPUs and 16GB+ RAM
- **Local safety:** Keep local at 1 worker to preserve current stability (proven to work)

**Testing Impact:**
- Local test suite: Unchanged (stays at 1 worker for stability)
- CI test suite: 2x faster with 2 workers (~15-30 min vs 30-60 min)
- If using aggressive config: 4x faster with 4 workers (~8-15 min) but requires beefy CI runner

---

## Implementation Order

### Phase A: Critical Fixes (Do First)
1. **Part 1: Fix Highlight Feature** (5 changes in executor.ts)
   - Add extractAffectedRowIds method
   - Call after diff view creation
   - Update syncExecuteToTimelineStore signature
   - Pass affectedRowIds through pipeline

2. **Part 2: Fix Test Timeout** (1 change in transformation-picker.page.ts)
   - Add explicit waits to selectColumn method

### Phase B: Performance Optimization (Do Second)
3. **Part 3: Merge Serial Blocks** (1 change in audit-details.spec.ts)
   - Consolidate two blocks into one
   - Create fixture helper functions

### Phase C: Optional Enhancement
4. **Part 4: Increase Workers** (1 change in playwright.config.ts)
   - Conditional workers config for parallel execution

---

## Verification Plan

### Pre-Implementation Verification (Diff View Schema):
**Verify _row_id column exists in diff views:**
```bash
# Start dev server and open browser console
npm run dev

# In console, after uploading a file and applying a transformation:
await window.__duckdb.conn.query("SELECT * FROM v_diff_step_0 LIMIT 1")

# Expected output should include columns:
# - _row_id (VARCHAR/UUID from _cs_id)
# - _change_type (VARCHAR: 'added', 'removed', 'modified', 'unchanged')
# - _affected_column (VARCHAR)
# - ... other table columns
```

This confirms diff views created by `createTier1DiffView()` (src/lib/commands/diff-views.ts:70) and `createTier3DiffView()` (line 108) explicitly alias `_cs_id as _row_id`.

### Manual Testing (Highlight Feature):
```bash
# Start dev server
npm run dev

# In browser:
1. Upload a CSV file
2. Apply a transformation (e.g., Trim Whitespace)
3. Click "Highlight" button in audit sidebar
4. Verify: Grid shows yellow highlighting on affected rows
5. Open browser console → window.__zustand_stores.timelineStore
6. Find latest command entry
7. Verify: affectedRowIds array has values (not undefined or empty)
8. Verify: All row IDs are strings (not BigInt or numbers)
```

### Automated Testing:
```bash
# Test highlight feature
npm test -- --grep "FR-REGRESSION-2"

# Test audit details (should not timeout)
npm test -- audit-details.spec.ts

# Full test suite
npm test
```

### Success Criteria:
- ✅ FR-REGRESSION-2 passes (highlight rowCount > 0)
- ✅ audit-details.spec.ts passes all 10 tests without timeouts
- ✅ No "Target page has been closed" errors
- ✅ Timeline store contains affectedRowIds array for highlight commands
- ✅ Grid correctly highlights transformed rows when Highlight button clicked

---

## Risk Assessment

| Change | Risk Level | Mitigation |
|--------|-----------|------------|
| Add affectedRowIds extraction | **Low** | Try-catch wrapper, non-critical feature, 10k row limit |
| Add explicit waits to selectColumn | **Very Low** | Only adds safety, no behavioral change |
| Merge serial test blocks | **Low** | Tests remain independent via helpers, follows existing patterns |
| Increase workers to 2 | **Medium** | Conservative 2 workers stays within memory limits, CI-only option available |

---

## Files to Modify

### Part 1: Highlight Feature (src/lib/commands/executor.ts)
- Line ~830: Add `extractAffectedRowIds()` method
- Line 242: Call extraction after diff view creation
- Line 834: Update `syncExecuteToTimelineStore()` signature
- Line 868: Pass `affectedRowIds` to `appendCommand()`
- Line 265: Pass `affectedRowIds` to `syncExecuteToTimelineStore()`

### Part 2: Test Timeout (e2e/page-objects/transformation-picker.page.ts)
- Lines 38-42: Add explicit waits to `selectColumn()` method

### Part 3: Merge Serial Blocks (e2e/tests/audit-details.spec.ts)
- Lines 16-428: Consolidate into single serial block with fixture helpers

### Part 4: Workers Config (playwright.config.ts)
- Line 8: Change from `workers: 1` to conditional config

---

## Estimated Impact

- **Highlight feature**: Now works correctly (user-facing bug fixed)
- **Test reliability**: 95%+ pass rate (no more timeouts in audit-details)
- **Test suite runtime**:
  - With workers: 2 → 50% faster locally (15-30 min vs 30-60 min)
  - With workers: 4 in CI → 75% faster (8-15 min vs 30-60 min)
- **Memory safety**: Maintained within current limits
