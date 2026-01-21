# E2E Test Update Plan for UI Redesign

## Critical Constraints

**NO TESTS WILL BE SKIPPED OR DELETED.** Every test will be fixed to work with the new UI architecture. All 72 tests will be preserved and updated to validate their respective requirements.

---

## Summary of Issues

The UI redesign changed from:
- Multi-route app (`/laundromat`, `/matcher`, `/combiner`, `/scrubber`, `/diff`) → **Single-page app** (`/`)
- Recipe-based transformations → **Direct-apply** transformations
- Separate pages → **Panel-based** workflow (slide-in sheets + Diff overlay)

---

## Complete Test Inventory (72 Tests)

| File | Test Count | Initial Status | Current Status | Fix Required |
|------|------------|----------------|----------------|--------------|
| feature-coverage.spec.ts | 30 | BROKEN | ✅ UPDATED | Panel toggle fix |
| transformations.spec.ts | 19 | PARTIAL | ✅ UPDATED | Panel toggle fix |
| export.spec.ts | 6 | BROKEN | ✅ UPDATED | Panel toggle fix |
| file-upload.spec.ts | 6 | OK | ✅ OK | None |
| audit-details.spec.ts | 9 | BROKEN | ✅ UPDATED | Panel toggle fix |
| e2e-flow.spec.ts | 3 | NEEDS REVIEW | ✅ UPDATED | Panel toggle fix |

**Test Run Results After Initial Fixes:** 21 failed, 26 did not run, 29 passed
**Root Cause:** Panel toggle behavior (Part 4 fix needed)

---

## Part 1: Page Object Updates

### 1.1 LaundromatPage (e2e/page-objects/laundromat.page.ts)

**File:** `e2e/page-objects/laundromat.page.ts`
**Line 39:** Change route from `/laundromat` to `/`

```typescript
// BEFORE (line 39)
async goto(): Promise<void> {
  await this.page.goto('/laundromat')
}

// AFTER
async goto(): Promise<void> {
  await this.page.goto('/')
}
```

### 1.2 DiffViewPage (e2e/page-objects/diff-view.page.ts)

**File:** `e2e/page-objects/diff-view.page.ts`
**Add:** Dual comparison mode selectors

```typescript
// Add to constructor (after line 34)
readonly comparePreviewModeButton: Locator
readonly compareTablesButton: Locator

// Initialize in constructor
this.comparePreviewModeButton = page.locator('button').filter({ hasText: 'Compare with Preview' })
this.compareTablesButton = page.locator('button').filter({ hasText: 'Compare Two Tables' })

// Add new methods after line 176
async selectComparePreviewMode(): Promise<void> {
  await this.comparePreviewModeButton.click()
}

async selectCompareTablesMode(): Promise<void> {
  await this.compareTablesButton.click()
}
```

---

## Part 2: Test File Fixes - Detailed Line-by-Line

### 2.1 feature-coverage.spec.ts (30 tests)

#### FR-A3: Text Cleaning Transformations (6 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should trim whitespace | 47-59 | FR-A3 | Replace `clickAddTransformation()` + `clickRunRecipe()` with `openCleanPanel()` + remove recipe call |
| should convert to uppercase | 61-73 | FR-A3 | Same fix |
| should convert to lowercase | 75-87 | FR-A3 | Same fix |
| should convert to title case | 89-107 | FR-A3 (TDD) | Same fix (test.fail() preserved) |
| should remove accents | 109-129 | FR-A3 (TDD) | Same fix (test.fail() preserved) |
| should remove non-printable | 131-150 | FR-A3 (TDD) | Same fix (test.fail() preserved) |

**Fix Pattern for lines 47-59:**
```typescript
// BEFORE (lines 50-54)
await laundromat.clickAddTransformation()
await picker.waitForOpen()
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await laundromat.clickRunRecipe()

// AFTER
await laundromat.openCleanPanel()
await picker.waitForOpen()
await picker.addTransformation('Trim Whitespace', { column: 'name' })
// No clickRunRecipe - addTransformation applies immediately
```

#### FR-A3: Finance & Number Transformations (3 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should unformat currency | 182-201 | FR-A3 (TDD) | Same fix pattern |
| should fix negatives | 203-222 | FR-A3 (TDD) | Same fix pattern |
| should pad zeros | 224-244 | FR-A3 (TDD) | Same fix pattern |

#### FR-A3: Dates & Structure Transformations (3 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should standardize dates | 276-298 | FR-A3 (TDD) | Same fix pattern |
| should calculate age | 300-320 | FR-A3 (TDD) | Same fix pattern |
| should split column | 322-344 | FR-A3 (TDD) | Same fix pattern |

#### FR-A3: Fill Down (1 test)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should fill down | 368-394 | FR-A3 (TDD) | Same fix pattern (lines 378, 386) |

#### FR-A6: Ingestion Wizard (3 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should show raw preview | 416-430 | FR-A6 | NONE - no transformation calls |
| should detect garbage headers | 432-456 | FR-A6 | NONE |
| should handle Row 1 header | 458-479 | FR-A6 | NONE |

#### FR-B2: Visual Diff (2 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should detect row changes | 501-508 | FR-B2 | Replace `page.goto('/diff')` with panel-based navigation |
| should identify added/removed/modified | 510-557 | FR-B2 | Replace route navigation with `openDiffView()` |

**Fix for lines 501-508:**
```typescript
// BEFORE (line 503)
await page.goto('/diff')

// AFTER
await laundromat.goto()
await inspector.waitForDuckDBReady()
await laundromat.openDiffView()
// Update assertion for new heading
await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 })
```

**Fix for lines 510-557:**
```typescript
// BEFORE (line 533-534)
await page.getByRole('link', { name: 'Diff' }).click()
await page.waitForURL('/diff')

// AFTER
await laundromat.openDiffView()
// Remove waitForURL - no longer uses routes
```

#### FR-C1: Fuzzy Matcher (3 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should load matcher page | 575-577 | FR-C1 | Replace route with panel |
| should detect duplicates | 579-592 | FR-C1 (TDD) | Same fix |
| should support blocking | 594-602 | FR-C1 (TDD) | Same fix |

**Fix for lines 564-577:**
```typescript
// BEFORE (line 566)
await page.goto('/matcher')

// AFTER
await page.goto('/')
await inspector.waitForDuckDBReady()
// Open match panel via toolbar
await page.getByTestId('toolbar-match').click()
// Update assertion for panel heading
await expect(page.locator('text=Fuzzy Matcher')).toBeVisible({ timeout: 10000 })
```

#### FR-D2: Obfuscation (5 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should load scrubber page | 620-622 | FR-D2 | Replace route with panel |
| should hash columns | 624-633 | FR-D2 (TDD) | Same fix |
| should redact PII | 635-644 | FR-D2 (TDD) | Same fix |
| should mask values | 646-654 | FR-D2 (TDD) | Same fix |
| should extract year | 656-664 | FR-D2 (TDD) | Same fix |

**Fix for lines 609-622:**
```typescript
// BEFORE (line 611)
await page.goto('/scrubber')

// AFTER
await page.goto('/')
await inspector.waitForDuckDBReady()
// Open scrub panel via toolbar
await page.getByTestId('toolbar-scrub').click()
// Update assertion for panel heading
await expect(page.locator('text=Smart Scrubber')).toBeVisible({ timeout: 10000 })
```

#### FR-E1: Combiner Stack (1 test)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should stack with Union All | 686-739 | FR-E1 | Replace link navigation with panel |

**Fix for line 705:**
```typescript
// BEFORE
await page.click('a[href="/combiner"]')
await expect(page.getByRole('heading', { name: /Combiner/i })).toBeVisible()

// AFTER
await laundromat.openCombinePanel()
await expect(page.locator('text=Stack').first()).toBeVisible()
```

#### FR-E2: Combiner Join (2 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should perform inner join | 761-815 | FR-E2 | Replace link navigation with panel (line 780) |
| should perform left join | 817-880 | FR-E2 | Replace link navigation with panel (line 840) |

#### FR-A4: Manual Cell Editing (3 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should show dirty indicator | 902-912 | FR-A4 | NONE - no transformation calls |
| should commit edit to audit | 914-950 | FR-A4 | NONE |
| should undo/redo edits | 952+ | FR-A4 | NONE |

---

### 2.2 transformations.spec.ts (19 tests)

All 8 serial groups need `laundromat.openCleanPanel()` added before `picker.waitForOpen()`.

| Serial Group | Tests | Lines | Fix |
|--------------|-------|-------|-----|
| Whitespace Data | 3 | 47, 61, 78 | Add openCleanPanel() |
| Mixed Case Data | 2 | 123, 135 | Add openCleanPanel() |
| Duplicates Data | 1 | 169 | Add openCleanPanel() |
| Empty Values Data | 1 | 212 | Add openCleanPanel() |
| Find Replace Data | 2 | 256, 271 | Add openCleanPanel() |
| Basic Data (Rename) | 1 | 308 | Add openCleanPanel() |
| Numeric Strings Data | 3 | 357, 373, 390 | Add openCleanPanel() |
| Case Sensitive Data | 3 | 439, 457, 475 | Add openCleanPanel() |

**Fix Pattern (example line 47-58):**
```typescript
// BEFORE
test('should apply trim transformation', async () => {
  await loadTestData()
  await picker.waitForOpen()  // Panel not opened!
  await picker.addTransformation('Trim Whitespace', { column: 'name' })
  // ...
})

// AFTER
test('should apply trim transformation', async () => {
  await loadTestData()
  await laundromat.openCleanPanel()  // ADD THIS
  await picker.waitForOpen()
  await picker.addTransformation('Trim Whitespace', { column: 'name' })
  // ...
})
```

---

### 2.3 export.spec.ts (6 tests)

| Test | Line | Requirement | Fix |
|------|------|-------------|-----|
| should export with filename | 35-44 | Export | NONE |
| should export correct headers | 46-57 | Export | NONE |
| should export all data rows | 59-73 | Export | NONE |
| should export transformed data | 75-94 | Export | Lines 83-86: Replace method calls |
| should export after multiple transforms | 96-120 | Export | Lines 104-112: Replace method calls |
| should export after deduplication | 122-138 | Export | Lines 129-132: Replace method calls |

**Fix for lines 75-94:**
```typescript
// BEFORE (lines 83-86)
await laundromat.clickAddTransformation()
await picker.waitForOpen()
await picker.addTransformation('Uppercase', { column: 'name' })
await laundromat.clickRunRecipe()

// AFTER
await laundromat.openCleanPanel()
await picker.waitForOpen()
await picker.addTransformation('Uppercase', { column: 'name' })
await laundromat.closePanel()  // Optional: close panel before export
```

---

### 2.4 audit-details.spec.ts (9 tests)

Review needed for transformation method calls. Apply same fix pattern as export.spec.ts.

---

### 2.5 e2e-flow.spec.ts (3 tests)

Review needed. Apply same fix pattern if using old transformation flow.

---

### 2.6 file-upload.spec.ts (6 tests)

**NO CHANGES REQUIRED** - These tests only cover file upload and ingestion wizard, no transformation calls.

---

## Part 3: New Tests for New Features

### 3.1 Persist as Table (Commit 4dba4ed)

**Add to feature-coverage.spec.ts:**

```typescript
test.describe.serial('Persist as Table', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('should create duplicate table with new name', async () => {
    // 1. Load and transform data
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data_v2')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Apply transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    // 3. Click Persist button
    await page.getByTestId('persist-table-btn').click()

    // 4. Enter new table name in dialog
    await page.getByLabel(/table name/i).fill('basic_data_v2')
    await page.getByRole('button', { name: /create/i }).click()

    // 5. Verify new table created
    await inspector.waitForTableLoaded('basic_data_v2', 5)
    const tables = await inspector.getTables()
    expect(tables.some(t => t.name === 'basic_data_v2')).toBe(true)

    // 6. Verify data was persisted correctly
    const data = await inspector.getTableData('basic_data_v2')
    expect(data[0].name).toBe('JOHN DOE')  // Uppercase applied
  })

  test('should log persist operation to audit', async () => {
    const auditEntries = await inspector.getAuditEntries()
    const persistEntry = auditEntries.find(e => e.action.includes('Persist'))
    expect(persistEntry).toBeDefined()
    expect(persistEntry?.entryType).toBe('A')
  })
})
```

### 3.2 Diff Dual Comparison Modes (Commit 7b86c9c)

**Add to feature-coverage.spec.ts:**

```typescript
test.describe.serial('FR-B2: Diff Dual Comparison Modes', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector
  let diffView: DiffViewPage

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    diffView = new DiffViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('should support Compare with Preview mode', async () => {
    // 1. Load table
    await inspector.runQuery('DROP TABLE IF EXISTS diff_preview_test')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Apply transformation to create difference
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    // 3. Open Diff view
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // 4. Select Compare with Preview mode (should be default)
    await diffView.selectComparePreviewMode()

    // 5. Select key column and run comparison
    await diffView.toggleKeyColumn('id')
    await diffView.runComparison()

    // 6. Verify results show modified rows
    const summary = await diffView.getSummary()
    expect(summary.modified).toBe(5)  // All 5 rows have uppercase names
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
  })

  test('should support Compare Two Tables mode', async () => {
    // 1. Upload two tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_base')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_new')

    await diffView.close()

    await laundromat.uploadFile(getFixturePath('fr_b2_base.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_base', 5)

    await laundromat.uploadFile(getFixturePath('fr_b2_new.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_new', 5)

    // 2. Open Diff view
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // 3. Select Compare Two Tables mode
    await diffView.selectCompareTablesMode()

    // 4. Select tables
    await diffView.selectTableA('fr_b2_base')
    await diffView.selectTableB('fr_b2_new')

    // 5. Select key column and run comparison
    await diffView.toggleKeyColumn('id')
    await diffView.runComparison()

    // 6. Verify expected differences
    const summary = await diffView.getSummary()
    expect(summary.added).toBe(1)      // Frank added
    expect(summary.removed).toBe(1)    // Charlie removed
    expect(summary.modified).toBe(3)   // Alice, Diana, Eve modified
  })
})
```

---

## Part 4: CRITICAL FIX - Panel Toggle Bug

### Issue Discovered During Implementation

After initial implementation, tests were run and **21 failed, 26 did not run, 29 passed**. The failures followed a pattern: **second tests in serial groups fail**.

**Root Cause:** Panel methods use simple `.click()` which **toggles** the panel state:
- First test: Panel is closed → click opens it ✅
- Second test: Panel is still open → click **closes** it ❌

### Fix: Make Panel Methods Idempotent

**File:** `e2e/page-objects/laundromat.page.ts`

The panel methods need to close any existing panel before opening the requested one:

```typescript
// BEFORE (current implementation - BROKEN)
async openCleanPanel(): Promise<void> {
  await this.cleanButton.click()  // Toggles - closes if already open!
}

// AFTER (idempotent - always ends with panel open)
async openCleanPanel(): Promise<void> {
  // Close any existing panel first to ensure clean state
  await this.page.keyboard.press('Escape')
  await this.page.waitForTimeout(100)
  // Now open the clean panel
  await this.cleanButton.click()
  // Wait for panel to be visible
  await this.page.getByTestId('transformation-picker').waitFor({ state: 'visible', timeout: 5000 })
}

async openMatchPanel(): Promise<void> {
  await this.page.keyboard.press('Escape')
  await this.page.waitForTimeout(100)
  await this.matchButton.click()
  await this.page.locator('text=Fuzzy Matcher').waitFor({ state: 'visible', timeout: 5000 })
}

async openCombinePanel(): Promise<void> {
  await this.page.keyboard.press('Escape')
  await this.page.waitForTimeout(100)
  await this.combineButton.click()
  await this.page.locator('text=Stack').first().waitFor({ state: 'visible', timeout: 5000 })
}

async openScrubPanel(): Promise<void> {
  await this.page.keyboard.press('Escape')
  await this.page.waitForTimeout(100)
  await this.scrubButton.click()
  await this.page.locator('text=Smart Scrubber').waitFor({ state: 'visible', timeout: 5000 })
}

async openDiffView(): Promise<void> {
  await this.page.keyboard.press('Escape')
  await this.page.waitForTimeout(100)
  await this.diffButton.click()
  await this.page.getByTestId('diff-view').waitFor({ state: 'visible', timeout: 5000 })
}
```

---

## Implementation Order (REVISED)

1. ✅ **Fix page objects** (laundromat.page.ts route, diff-view.page.ts dual modes) - DONE
2. ✅ **Fix transformations.spec.ts** (add openCleanPanel() calls) - DONE
3. ✅ **Fix export.spec.ts** (6 changes) - DONE
4. ✅ **Fix feature-coverage.spec.ts** (largest file) - DONE
5. ✅ **Fix audit-details.spec.ts** - DONE
6. ✅ **Fix e2e-flow.spec.ts** - DONE
7. 🔄 **FIX PANEL TOGGLE BUG** ← CURRENT PRIORITY
8. 🔲 **Add new tests** (Persist as Table, Diff dual modes)

---

## Verification

### Step 1: Verify Code Patterns (Already Passed)
```bash
# Verify no broken method calls remain
grep -r "clickAddTransformation\|clickRunRecipe" e2e/
# Expected: 0 results ✅ PASSED

# Verify no old routes remain
grep -r "goto('/laundromat')\|goto('/matcher')\|goto('/scrubber')\|goto('/diff')\|goto('/combiner')" e2e/
# Expected: 0 results ✅ PASSED
```

### Step 2: Verify Panel Toggle Fix
```bash
# Run transformations tests first (most isolated)
npm test -- e2e/tests/transformations.spec.ts

# Run export tests
npm test -- e2e/tests/export.spec.ts

# Run e2e flow tests
npm test -- e2e/tests/e2e-flow.spec.ts
```

### Step 3: Full Test Suite
```bash
# Run all tests
npm test

# Expected: All tests pass except those marked with test.fail() (TDD tests)
```

### Expected Results
- **file-upload.spec.ts**: 6/6 pass (no panel usage)
- **transformations.spec.ts**: ~16-19 pass (depending on TDD tests)
- **export.spec.ts**: 6/6 pass
- **e2e-flow.spec.ts**: 3/3 pass
- **audit-details.spec.ts**: 9/9 pass
- **feature-coverage.spec.ts**: Varies (many tests use `test.fail()` for TDD)

**Total Expected:** ~50+ tests pass, TDD-marked tests fail as expected
