# Plan: Fix Word Wrap in Data Preview

## Problem Summary

Word wrap in the data grid doesn't work correctly:
1. Toggling wrap doesn't visually change how text is displayed in cells
2. Wrap state doesn't persist when scrolling
3. Unwrap/re-wrap cycle doesn't restore functionality

## Root Cause

**Two bugs in `src/components/grid/DataGrid.tsx`:**

1. **Line 1027**: `allowWrapping` is hardcoded to `true` instead of respecting the `wordWrapEnabled` prop
   ```typescript
   // Current (broken):
   allowWrapping: true,

   // Should be:
   allowWrapping: wordWrapEnabled,
   ```

2. **Line 1030**: `wordWrapEnabled` is missing from the `getCellContent` dependency array
   ```typescript
   // Current (broken):
   [data, columns, loadedRange.start, editable, rowIndexToCsId, tableId]

   // Should include:
   [data, columns, loadedRange.start, editable, rowIndexToCsId, tableId, wordWrapEnabled]
   ```

**Evidence**: The `VirtualizedDiffGrid.tsx` has the correct implementation at line 595-598:
```typescript
allowWrapping: wordWrapEnabled,
// ...dependency array includes wordWrapEnabled
```

## Implementation

### Step 1: Fix `getCellContent` in DataGrid.tsx

**File**: `src/components/grid/DataGrid.tsx`

**Change 1** (line 1027):
```typescript
// FROM:
allowWrapping: true,

// TO:
allowWrapping: wordWrapEnabled,
```

**Change 2** (line 1030):
```typescript
// FROM:
[data, columns, loadedRange.start, editable, rowIndexToCsId, tableId]

// TO:
[data, columns, loadedRange.start, editable, rowIndexToCsId, tableId, wordWrapEnabled]
```

### Step 2: Remove TEMP comment (line 1026)

Remove the comment `// TEMP: Hardcoded true for testing text wrap propagation` since we're fixing the issue.

## How It Works

The Glide Data Grid word wrap mechanism:

1. **`allowWrapping` on cells** - Tells the grid whether the cell content can wrap to multiple lines
2. **`rowHeight` prop** - Sets the height available for wrapped content (currently 120px when wrap enabled, 33px when disabled)
3. **Grid remount via `gridKey`** - Forces virtualization recalculation when row heights change

When `allowWrapping: false` (wordWrapEnabled off):
- Cell text truncates with ellipsis
- Row height is 33px

When `allowWrapping: true` (wordWrapEnabled on):
- Cell text wraps to multiple lines
- Row height is 120px (accommodates ~5 lines)

The grid remount strategy (incrementing `gridKey` on toggle) handles the virtualization correctly - the issue was purely that the cell property wasn't reading from state.

## Verification

### Manual Testing
1. Load a CSV with long text values
2. Click the wrap button (WrapText icon in toolbar)
3. Verify text wraps and rows expand
4. Scroll down past the initial viewport
5. Scroll back up
6. Verify wrap is still applied
7. Click wrap button again to disable
8. Verify rows collapse back to single line
9. Re-enable wrap
10. Verify wrap works again

### E2E Test

Create `e2e/tests/word-wrap.spec.ts`:

```typescript
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Word Wrap', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)
    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await context.close()
  })

  test('should toggle word wrap and persist across scroll', async () => {
    // Load table with content
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Get wrap button
    const wrapButton = page.getByRole('button').filter({ has: page.locator('svg.lucide-wrap-text') })

    // Initially wrap should be off
    const initialWrapState = await inspector.evaluateInStore('tableStore', (store) => {
      const tables = store.getState().tables
      const activeTable = tables[0]
      return activeTable?.columnPreferences?.wordWrapEnabled ?? false
    })
    expect(initialWrapState).toBe(false)

    // Enable wrap
    await wrapButton.click()

    // Verify wrap is enabled
    const wrapEnabled = await inspector.evaluateInStore('tableStore', (store) => {
      const tables = store.getState().tables
      const activeTable = tables[0]
      return activeTable?.columnPreferences?.wordWrapEnabled ?? false
    })
    expect(wrapEnabled).toBe(true)

    // Verify button shows active state (amber highlight)
    await expect(wrapButton).toHaveClass(/bg-amber-500/)

    // Disable wrap
    await wrapButton.click()

    // Verify wrap is disabled
    const wrapDisabled = await inspector.evaluateInStore('tableStore', (store) => {
      const tables = store.getState().tables
      const activeTable = tables[0]
      return activeTable?.columnPreferences?.wordWrapEnabled ?? false
    })
    expect(wrapDisabled).toBe(false)

    // Re-enable wrap (the key test - this was broken before)
    await wrapButton.click()

    // Verify wrap is enabled again
    const wrapReEnabled = await inspector.evaluateInStore('tableStore', (store) => {
      const tables = store.getState().tables
      const activeTable = tables[0]
      return activeTable?.columnPreferences?.wordWrapEnabled ?? false
    })
    expect(wrapReEnabled).toBe(true)
  })
})
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/grid/DataGrid.tsx` | Fix `allowWrapping` (line 1027) and dependency array (line 1030) |

## No New Components Needed

The existing shadcn Button component is already used for the wrap toggle. No new components required.

## Sources

- [Glide Data Grid API docs](https://docs.grid.glideapps.com/api/dataeditor/important-props) - rowHeight can be a callback for dynamic heights
- [GitHub API.md](https://github.com/glideapps/glide-data-grid/blob/main/packages/core/API.md) - Cell properties including allowWrapping
