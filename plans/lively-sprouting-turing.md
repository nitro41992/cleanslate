# Fix Broken Audit Log Features + Regression Tests

## Problem Summary

After the Command Pattern migration, three key features are broken:
1. **Highlight feature** - Clicking "Highlight" in audit sidebar does nothing
2. **Drill-down feature** - Can't view row-level before/after changes
3. **Undo/Redo** - Ctrl+Z/Ctrl+Y doesn't work

## Root Cause Analysis

**The core issue: Dual timeline systems are not synchronized.**

### Timeline Architecture Problem

There are TWO parallel timeline systems:
1. **CommandExecutor timeline** (`src/lib/commands/executor.ts`, line 58)
   - `tableTimelines = new Map<string, TableCommandTimeline>()`
   - Used by new transform commands via `executor.execute()`

2. **Legacy timelineStore** (`src/stores/timelineStore.ts`)
   - `timelines: Map<string, TableTimeline>`
   - Used by AuditSidebar for highlight/drill-down lookups

### Why Each Feature is Broken

1. **Highlight**: AuditSidebar searches in timelineStore (empty) - no command found = no highlight button
2. **Drill-down**: `hasRowDetails: false` by default, `captureRowDetails()` not called
3. **Undo/Redo**: Works in CommandExecutor but UI doesn't update (no dataVersion increment, no timelineStore sync)

---

## Implementation Plan

### Phase 1: Fix Timeline Synchronization (Execute + Undo + Redo)

**Goal**: Keep CommandExecutor and timelineStore in sync for ALL operations.

#### 1.1 Sync Execute to timelineStore

**File**: `src/lib/commands/executor.ts`

In `recordTimelineCommand()`, after line 611, sync to legacy store:

```typescript
// After: timeline.commands.push(record)

// Sync with legacy timelineStore for UI integration
const timelineStoreState = useTimelineStore.getState()
let legacyTimeline = timelineStoreState.getTimeline(tableId)
if (!legacyTimeline) {
  timelineStoreState.createTimeline(tableId, ctx.table.name, '')
}

const legacyCommandType = this.mapToLegacyCommandType(command.type)
timelineStoreState.appendCommand(tableId, legacyCommandType, command.label, {
  type: legacyCommandType,
  transformationType: command.type.replace('transform:', ''),
  column: (command.params as { column?: string }).column,
}, {
  auditEntryId: record.id, // Use command ID as link
  affectedColumns: highlightInfo?.columns || [],
  rowsAffected: executionResult?.rowsAffected,
})
```

#### 1.2 Sync Undo to timelineStore (CRITICAL)

**File**: `src/lib/commands/executor.ts`

In `undo()` method, after decrementing position (line 314), sync to legacy store:

```typescript
// After: timeline.position--

// Sync with legacy timelineStore
const timelineStoreState = useTimelineStore.getState()
const legacyTimeline = timelineStoreState.getTimeline(tableId)
if (legacyTimeline && legacyTimeline.currentPosition >= 0) {
  timelineStoreState.setPosition(tableId, legacyTimeline.currentPosition - 1)
}
```

#### 1.3 Sync Redo to timelineStore (CRITICAL)

**File**: `src/lib/commands/executor.ts`

In `redo()` method, after advancing position (line 375), sync to legacy store:

```typescript
// After: timeline.position = nextPosition

// Sync with legacy timelineStore
const timelineStoreState = useTimelineStore.getState()
const legacyTimeline = timelineStoreState.getTimeline(tableId)
if (legacyTimeline && legacyTimeline.currentPosition < legacyTimeline.commands.length - 1) {
  timelineStoreState.setPosition(tableId, legacyTimeline.currentPosition + 1)
}
```

#### 1.4 Add helper method

**File**: `src/lib/commands/executor.ts`

```typescript
private mapToLegacyCommandType(commandType: string): TimelineCommandType {
  if (commandType.startsWith('transform:')) return 'transform'
  if (commandType === 'edit:cell') return 'manual_edit'
  if (commandType === 'combine:stack') return 'stack'
  if (commandType === 'combine:join') return 'join'
  if (commandType === 'match:merge') return 'merge'
  if (commandType === 'standardize:apply') return 'standardize'
  return 'transform'
}
```

### Phase 2: Fix dataVersion for Grid Refresh (CRITICAL)

**Goal**: DataGrid must re-render after undo/redo.

**File**: `src/lib/commands/executor.ts`

In `updateTableStore()` method (line 639-648), increment dataVersion:

```typescript
private updateTableStore(
  tableId: string,
  result: { rowCount?: number; columns?: { name: string; type: string; nullable: boolean }[] }
): void {
  const tableStore = useTableStore.getState()
  const currentTable = tableStore.tables.find(t => t.id === tableId)

  tableStore.updateTable(tableId, {
    rowCount: result.rowCount ?? currentTable?.rowCount,
    columns: result.columns ?? currentTable?.columns,
    dataVersion: (currentTable?.dataVersion ?? 0) + 1, // CRITICAL: Trigger re-render
  })
}
```

### Phase 3: Fix Audit Row Details Capture (Tier 1 Compatible)

**Goal**: Transform commands capture row-level audit details for drill-down.

#### CRITICAL TIMING ISSUE

For Tier 1 commands, the data is transformed via column versioning:
- After transform: `column` = transformed value, `column__base` = original value
- The existing `captureRowDetails()` uses `column != TRIM(column)` which is FALSE after transform

**Solution**: For Tier 1, use `column__base` for "before" values.

#### 3.1 Add Tier 1-aware audit capture function

**File**: `src/lib/commands/executor.ts`

```typescript
import { getBaseColumnName } from './column-versions'

/**
 * Capture row details for Tier 1 commands using versioned columns.
 * After a Tier 1 transform:
 *   - column = transformed value (new)
 *   - column__base = original value (before)
 */
private async captureTier1RowDetails(
  ctx: CommandContext,
  column: string,
  auditEntryId: string
): Promise<void> {
  const baseColumn = getBaseColumnName(column)
  const quotedCol = `"${column}"`
  const quotedBase = `"${baseColumn}"`
  const escapedColumn = column.replace(/'/g, "''")

  // Check if base column exists (it should for Tier 1)
  const colsResult = await ctx.db.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = '${ctx.table.name}' AND column_name = '${baseColumn}'
  `)

  if (colsResult.length === 0) {
    console.warn(`[EXECUTOR] Base column ${baseColumn} not found, skipping audit capture`)
    return
  }

  // Insert row details: previous = base column, new = transformed column
  // Only include rows where values actually differ
  const sql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${quotedBase} AS VARCHAR),
      CAST(${quotedCol} AS VARCHAR),
      CURRENT_TIMESTAMP
    FROM "${ctx.table.name}"
    WHERE ${quotedBase} IS DISTINCT FROM ${quotedCol}
    LIMIT 50000
  `

  await ctx.db.execute(sql)
}
```

#### 3.2 Call appropriate capture method based on tier

**File**: `src/lib/commands/executor.ts`

After audit recording (around line 186):

```typescript
// Capture row-level details for drill-down
if (!skipAudit && auditInfo.hasRowDetails && auditInfo.auditEntryId) {
  try {
    const column = (command.params as { column?: string }).column
    if (column) {
      if (tier === 1) {
        // Tier 1: Use versioned column__base for before values
        await this.captureTier1RowDetails(updatedCtx, column, auditInfo.auditEntryId)
      } else {
        // Tier 2/3: Use legacy captureRowDetails (has snapshot or inverse SQL)
        const transformType = command.type.replace('transform:', '')
        await captureRowDetails(
          ctx.table.name,
          { type: transformType, column, params: command.params },
          auditInfo.auditEntryId,
          auditInfo.rowsAffected
        )
      }
    }
  } catch (err) {
    console.warn('[EXECUTOR] Failed to capture row details:', err)
    // Non-critical - don't fail the command
  }
}
```

#### 3.3 Set hasRowDetails: true in transform commands

**File**: `src/lib/commands/transform/base.ts`

In `getAuditInfo()` method:

```typescript
getAuditInfo(ctx: CommandContext, result: ExecutionResult) {
  const transformType = this.type.replace('transform:', '')

  // Transforms that support row-level drill-down
  const drillDownSupported = new Set([
    'trim', 'lowercase', 'uppercase', 'title_case', 'replace',
    'remove_accents', 'remove_non_printable', 'collapse_spaces',
    'sentence_case', 'unformat_currency', 'fix_negatives', 'pad_zeros',
    'standardize_date', 'calculate_age', 'fill_down', 'cast_type',
    'replace_empty', 'remove_duplicates', 'filter_empty',
  ])

  return {
    action: this.label,
    details: { column: this.params.column, ...this.params },
    rowsAffected: result.rowsAffected ?? 0,
    affectedColumns: this.params.column ? [this.params.column] : [],
    hasRowDetails: drillDownSupported.has(transformType),
    auditEntryId: this.id, // Use command ID
    isCapped: false,
  }
}
```

### Phase 4: Ensure edit:cell Uses Type B Audit

**Status**: Already correct - no changes needed.

The existing code at `src/components/grid/DataGrid.tsx:399-406` calls `addManualEditEntry()` which creates Type B entries.

### Phase 5: Add Regression Tests

**File**: `e2e/tests/audit-undo-regression.spec.ts` (NEW FILE)

```typescript
import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe.serial('FR-REGRESSION: Audit + Undo Features', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 5)
  }

  test('FR-REGRESSION-1: Highlight button appears after transform', async () => {
    await loadTestData()

    // Apply Trim transform
    await laundromat.clickAddTransformation()
    await page.getByRole('option', { name: 'Trim Whitespace' }).click()
    await laundromat.selectColumn('Name')
    await laundromat.clickRunRecipe()
    await page.waitForTimeout(500)

    // Open audit sidebar
    await page.click('[data-testid="toggle-audit-sidebar"]')
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Verify highlight button exists on the Trim entry
    const highlightBtn = page.locator('button:has-text("Highlight")')
    await expect(highlightBtn.first()).toBeVisible({ timeout: 5000 })
  })

  test('FR-REGRESSION-2: Clicking highlight shows grid highlighting', async () => {
    // Click highlight button
    await page.locator('button:has-text("Highlight")').first().click()
    await page.waitForTimeout(300)

    // Button should now say "Clear"
    await expect(page.locator('button:has-text("Clear")').first()).toBeVisible()
  })

  test('FR-REGRESSION-3: Audit drill-down shows row details', async () => {
    // Click on audit entry with "View details" indicator
    const auditEntry = page.locator('[data-testid="audit-entry-with-details"]').first()

    // If no entry has details, the test should fail
    await expect(auditEntry).toBeVisible({ timeout: 5000 })
    await auditEntry.click()

    // Verify modal opens
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Verify it has a table with before/after columns
    await expect(modal.locator('th:has-text("Previous"), th:has-text("Before")')).toBeVisible()
    await expect(modal.locator('th:has-text("New"), th:has-text("After")')).toBeVisible()

    // Close modal
    await page.keyboard.press('Escape')
  })

  test('FR-REGRESSION-4: Undo reverts transform and updates grid', async () => {
    // Get data before undo
    const beforeUndo = await inspector.getTableData('whitespace_data')
    const beforeValue = beforeUndo[0]?.Name

    // Press Ctrl+Z
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    // Get data after undo
    const afterUndo = await inspector.getTableData('whitespace_data')
    const afterValue = afterUndo[0]?.Name

    // Values should differ (whitespace restored)
    expect(afterValue).not.toEqual(beforeValue)
  })

  test('FR-REGRESSION-5: Redo reapplies transform', async () => {
    // Get data before redo
    const beforeRedo = await inspector.getTableData('whitespace_data')
    const beforeValue = beforeRedo[0]?.Name

    // Press Ctrl+Y
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)

    // Get data after redo
    const afterRedo = await inspector.getTableData('whitespace_data')
    const afterValue = afterRedo[0]?.Name

    // Values should differ (trim reapplied)
    expect(afterValue).not.toEqual(beforeValue)
  })

  test('FR-REGRESSION-6: Audit sidebar reflects undo state', async () => {
    // After the previous redo, we're at position 1
    // Undo should mark the entry as "Undone"
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    // Check for "Undone" badge or visual indicator
    const undoneBadge = page.locator('text=Undone')
    await expect(undoneBadge).toBeVisible({ timeout: 5000 })
  })
})
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/commands/executor.ts` | 1) Sync execute/undo/redo to timelineStore, 2) Increment dataVersion, 3) Add `captureTier1RowDetails()` for versioned columns, 4) Add `mapToLegacyCommandType()` helper |
| `src/lib/commands/transform/base.ts` | Set `hasRowDetails: true` for supported transforms |
| `e2e/tests/audit-undo-regression.spec.ts` | New file with 6 regression tests |

---

## Verification Steps

### 1. Manual Testing Checklist

- [ ] Load `whitespace-data.csv`
- [ ] Apply "Trim Whitespace" to Name column
- [ ] Open Audit Sidebar → "Highlight" button visible
- [ ] Click Highlight → grid cells have yellow background
- [ ] Click "Clear" → highlighting removed
- [ ] Click audit entry → modal opens with row details table
- [ ] Verify "Previous" column shows whitespace, "New" column shows trimmed
- [ ] Press Ctrl+Z → data reverts, "Undone" badge appears
- [ ] Press Ctrl+Y → data restored, badge disappears

### 2. Run Regression Tests

```bash
npm test -- --grep "FR-REGRESSION"
```

### 3. Run Full Test Suite

```bash
npm test
```

---

## Key Insights

1. **Tier 1 preserves "before" state in `column__base`** - Use this for audit capture after transform
2. **`IS DISTINCT FROM` handles NULLs** - Unlike `!=`, this works correctly with NULL values
3. **dataVersion increment is critical** - Without it, DataGrid won't re-render after undo/redo
4. **Undo/Redo MUST sync both systems** - Otherwise UI shows stale state
