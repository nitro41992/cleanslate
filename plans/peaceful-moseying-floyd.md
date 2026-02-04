# E2E Test Plan: Recipe Functionality

## Status: ✅ COMPLETE

**Implemented:** 2026-02-03
**All 17 tests passing**

## Overview

Create comprehensive E2E tests for the recipe feature, which allows users to save, export, import, and apply transformation workflows across tables.

## Files to Create

### 1. Test File
**`e2e/tests/recipe.spec.ts`**

### 2. Helper Extensions
**`e2e/helpers/download-helpers.ts`** - Add JSON download helper

### 3. Store Inspector Extension
**`e2e/helpers/store-inspector.ts`** - Add recipe store methods

### 4. Fixtures
- `e2e/fixtures/json/valid-recipe.json`
- `e2e/fixtures/json/invalid-recipe.json`
- `e2e/fixtures/json/recipe-with-hash.json`

---

## Test Structure

**Isolation Strategy:** Tier 2 with fresh browser context per test (recipes persist to OPFS)

```typescript
test.describe('Recipe Functionality', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  // ... page objects

  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => { browser = b })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    // Re-init all page objects
    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try { await context.close() } catch {}
  })
})
```

---

## Test Scenarios

### Group A: Recipe Creation (3 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| A1 | Create recipe from single transform via audit sidebar | Recipe has 1 step, requiredColumns includes target column |
| A2 | Create recipe from multiple transforms | Steps in correct order, all columns captured |
| A3 | Non-compatible commands excluded from recipe | edit:cell excluded, only transform included |

**Key Selector:** `data-testid="export-as-recipe-btn"` in AuditSidebar

**Flow:**
1. Upload `basic-data.csv`
2. Apply transform(s)
3. Open audit sidebar via `laundromat.openAuditSidebar()`
4. Click export as recipe button
5. Fill dialog (Recipe Name input)
6. Click "Create Recipe"
7. Verify via store inspection

### Group B: Recipe Export/Import (3 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| B1 | Export recipe to JSON file | JSON structure correct (name, steps, requiredColumns) |
| B2 | Import valid recipe JSON | Recipe added to store, steps loaded |
| B3 | Reject invalid recipe JSON | Error toast, no recipe added |

**Download Pattern:**
```typescript
const downloadPromise = page.waitForEvent('download')
await page.getByRole('button', { name: /export/i }).click()
const download = await downloadPromise
// Parse JSON content
```

**Import Pattern:**
```typescript
// Use hidden file input + setInputFiles
await page.getByRole('button', { name: /import/i }).click()
// Handle native file input
```

### Group C: Recipe Application (4 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| C1 | Apply recipe with exact column match | Data transformed, verified via SQL |
| C2 | Apply with case-insensitive match | "NAME" matches "name", no dialog |
| C3 | Apply with normalized match | "first_name" matches "First Name" |
| C4 | Apply requiring manual column mapping | Mapping dialog appears, user maps columns |

**Column Mapping Dialog Selectors:**
- Dialog: `page.getByRole('dialog').filter({ hasText: 'Column Mapping' })`
- Unmapped badge: `getByText('unmapped')`
- Map select: `getByRole('combobox')` within row

**Verification via SQL:**
```typescript
const rows = await inspector.runQuery('SELECT name, email FROM basic_data')
expect(rows[0].name).toBe('JOHN DOE')  // uppercase applied
```

### Group D: Secret Handling (2 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| D1 | Hash operation prompts for secret | Secret dialog appears, hash applied |
| D2 | Reject short secret (<5 chars) | Apply button disabled |

**Secret Dialog:** Part of `useRecipeExecution` hook, rendered via `secretDialogElement`

### Group E: Step Management (3 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| E1 | Toggle step enabled/disabled | Disabled step not executed |
| E2 | Reorder steps up/down | Execution order changes |
| E3 | Remove step from recipe | Step count decreases |

**Step Selectors:**
- Switch: `getByRole('switch')` within step card
- Up/Down: `getByRole('button', { name: /up|down/i })`
- Remove: `getByRole('button', { name: 'Remove step' })`

### Group F: Error Handling (2 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| F1 | Invalid command type in imported recipe | Error on apply |
| F2 | Unmapped required columns | Error message shown |

### Group G: Persistence (2 tests)

| Test | Description | Key Assertions |
|------|-------------|----------------|
| G1 | Recipe persists across reload | Recipe still exists after reload |
| G2 | Recipe selection persists | Selected recipe maintained |

**Persistence Pattern:**
```typescript
await inspector.saveAppState()
await page.reload()
await inspector.waitForDuckDBReady()
// Verify via store
```

---

## Helper Extensions

### download-helpers.ts - Add:

```typescript
export interface JSONDownloadResult {
  filename: string
  content: object
}

export async function downloadRecipeJSON(
  page: Page,
  triggerFn: () => Promise<void>
): Promise<JSONDownloadResult> {
  const downloadPromise = page.waitForEvent('download')
  await triggerFn()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  if (stream) {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
  }
  const content = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  return { filename: download.suggestedFilename(), content }
}
```

### store-inspector.ts - Add:

```typescript
// Add to StoreInspector interface
getRecipeState: () => Promise<{
  recipes: Recipe[]
  selectedRecipeId: string | null
  isProcessing: boolean
  executionError: string | null
}>

waitForRecipeExecutionComplete: (timeout?: number) => Promise<void>
```

---

## Fixtures

### valid-recipe.json
```json
{
  "name": "Test Recipe",
  "description": "E2E test recipe",
  "version": "1.0",
  "requiredColumns": ["name", "email"],
  "steps": [
    {
      "id": "step1",
      "type": "transform:trim",
      "label": "Trim name",
      "column": "name",
      "enabled": true
    },
    {
      "id": "step2",
      "type": "transform:uppercase",
      "label": "Uppercase email",
      "column": "email",
      "enabled": true
    }
  ],
  "createdAt": "2024-01-01T00:00:00.000Z",
  "modifiedAt": "2024-01-01T00:00:00.000Z"
}
```

### invalid-recipe.json
```json
{
  "description": "Missing name and steps"
}
```

### recipe-with-hash.json
```json
{
  "name": "Hash Recipe",
  "description": "Recipe with hash step",
  "version": "1.0",
  "requiredColumns": ["ssn"],
  "steps": [
    {
      "id": "step1",
      "type": "scrub:hash",
      "label": "Hash SSN",
      "column": "ssn",
      "enabled": true
    }
  ],
  "createdAt": "2024-01-01T00:00:00.000Z",
  "modifiedAt": "2024-01-01T00:00:00.000Z"
}
```

---

## Critical UI Selectors

| Element | Selector |
|---------|----------|
| Export as Recipe (Audit) | `data-testid="export-as-recipe-btn"` |
| Recipe Name Input | `getByLabel('Recipe Name')` |
| Create Recipe Button | `getByRole('button', { name: 'Create Recipe' })` |
| Apply Button | `getByRole('button', { name: 'Apply' })` |
| Import Button | Upload icon button (no test ID) |
| Export Button | Download icon button (no test ID) |
| Delete Button | Trash icon button |
| Column Mapping Dialog | `getByRole('dialog').filter({ hasText: 'Column Mapping' })` |
| Secret Dialog | `getByRole('dialog').filter({ hasText: 'Secret Required' })` |

---

## Verification Methods

### Primary: SQL Queries
```typescript
const rows = await inspector.runQuery('SELECT * FROM basic_data')
expect(rows[0].name).toBe('TRIMMED VALUE')
```

### Secondary: Store Inspection
```typescript
const state = await inspector.getRecipeState()
expect(state.recipes).toHaveLength(1)
expect(state.recipes[0].steps).toHaveLength(2)
```

### UI: Only when necessary
```typescript
await expect(page.getByText('Recipe created')).toBeVisible()
```

---

## Test Run Command

```bash
npx playwright test "recipe.spec.ts" --timeout=90000 --retries=0 --reporter=line
```

---

## Implementation Order

1. ✅ **Store inspector extensions** - Add `getRecipeState()` and `waitForRecipeExecutionComplete()`
2. ✅ **Download helper** - Add `downloadRecipeJSON()`
3. ✅ **JSON fixtures** - Create 3 fixture files
4. ✅ **Test file** - Implement in order: A → B → C → D → E → F → G

## Implementation Notes

### Key Changes Made

1. **RecipeStepCard accessibility** - Added `aria-label` attributes to step action buttons for E2E testability:
   - "Move step up" / "Move step down" for reorder
   - "Disable step" / "Enable step" for toggle (with `aria-pressed`)
   - "Delete step" for removal

2. **Test patterns used**:
   - SQL polling via `expect.poll()` for data verification (per e2e/CLAUDE.md guidelines)
   - Recipe button selection (not combobox - UI uses button list)
   - `saveAppState()` + polling after reload for persistence tests

3. **Test counts by group**:
   - Group A (Recipe Creation): 3 tests
   - Group B (Export/Import): 3 tests
   - Group C (Recipe Application): 3 tests
   - Group D (Secret Handling): 2 tests
   - Group E (Step Management): 3 tests
   - Group F (Error Handling): 1 test
   - Group G (Persistence): 2 tests
