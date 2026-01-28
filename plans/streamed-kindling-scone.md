# Fix: Audit Log Drill-Down for Batch Cell Edits

## Problem Summary
The audit log drill-down shows **nothing** for both:
1. Single manual edits
2. Batched edits (rapid successive cell changes)

The root cause is a mismatch between how batch edits are classified vs. how the drill-down UI decides which component to render.

## Root Cause Analysis

### The Data Flow
```
Cell Edit → edit:batch command → CommandExecutor
    ↓
syncExecuteToTimelineStore() → params.type = 'batch_edit'
    ↓
timelineStore.appendCommand() → stores cellChanges array
    ↓
audit-from-timeline.ts → derives AuditLogEntry
    ↓
AuditDetailModal.tsx → decides which detail view to show
```

### Bug Location 1: `src/lib/audit-from-timeline.ts` line 25

```typescript
const isManualEdit = command.params.type === 'manual_edit'  // ❌ Misses 'batch_edit'
```

For `edit:batch` commands, `params.type === 'batch_edit'`, NOT `'manual_edit'`. This causes:
- `isManualEdit = false`
- `entryType = 'A'` (transformation type) instead of `'B'` (manual edit type)

### Bug Location 2: `src/components/common/AuditDetailModal.tsx` line 43

```typescript
const isManualEdit = entry.entryType === 'B'  // ❌ Batch edits have entryType 'A'
```

Since batch edits get `entryType: 'A'`, the modal uses `AuditDetailTable` which queries the `_audit_details` DuckDB table. But batch edits store their changes in `timeline.commands[].cellChanges`, NOT in `_audit_details`.

### Why Tests Pass
E2E tests call `inspector.disableEditBatching()` in setup, which forces immediate single-edit execution (`edit:cell`). This means:
- Tests only verify single edits (`edit:cell` → `params.type = 'manual_edit'` → `entryType = 'B'` → works)
- Batch edits (`edit:batch`) are never tested

### Evidence from Code
`timelineStore.ts` already correctly handles both types at lines 333 and 397:
```typescript
if (command.commandType === 'manual_edit' || command.commandType === 'batch_edit') {
  diffMode = 'cell'
}
```

But `audit-from-timeline.ts` was missed.

## Fix Plan

### Fix 1: `src/lib/audit-from-timeline.ts`
**Lines 25-26**: Expand `isManualEdit` to include batch edits:

```typescript
// Before
const isManualEdit = command.params.type === 'manual_edit'

// After
const isManualEdit = command.params.type === 'manual_edit' ||
                     command.params.type === 'batch_edit' ||
                     command.commandType === 'manual_edit' ||
                     command.commandType === 'batch_edit'
```

This ensures both single and batch edits get `entryType: 'B'`.

### Fix 2: `src/components/common/AuditDetailModal.tsx`
**Line 43**: Also check for batch edit indicators:

```typescript
// Before
const isManualEdit = entry.entryType === 'B'

// After
const isManualEdit = entry.entryType === 'B' ||
                     entry.action?.includes('Batch Edit') ||
                     entry.action?.includes('Edit Cell')
```

This provides redundancy in case `entryType` derivation has issues.

### Fix 3: Add E2E Test for Batch Edit Drill-Down
Create new test in `e2e/tests/audit-details.spec.ts`:

```typescript
test('should show all cell changes in drill-down for rapid batch edits', async ({ page }) => {
  // DO NOT disable batching - test the real batch behavior
  const laundromat = new LaundromatPage(page)
  const inspector = createStoreInspector(page)

  // Setup: Import test data
  await laundromat.uploadFile(getFixturePath('basic-data.csv'))
  // ... import

  // Act: Make 3 rapid edits (within 500ms batch window)
  await laundromat.editCell(0, 'name', 'Edit1')
  await laundromat.editCell(1, 'name', 'Edit2')
  await laundromat.editCell(2, 'name', 'Edit3')

  // Wait for batch to flush (500ms + buffer)
  await page.waitForTimeout(700)  // Exception: intentional wait for batch

  // Verify: Single audit entry with all 3 edits
  await expect.poll(async () => {
    const entries = await inspector.getAuditEntries()
    return entries.some(e => e.action?.includes('Batch Edit (3 cells)'))
  }, { timeout: 5000 }).toBe(true)

  // Open drill-down
  await page.getByTestId('audit-entry-with-details').first().click()

  // Verify: All 3 changes shown in ManualEditDetailView
  await expect(page.getByTestId('manual-edit-detail-view')).toBeVisible()
  const rows = page.getByTestId('manual-edit-detail-row')
  await expect(rows).toHaveCount(3)
})
```

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/audit-from-timeline.ts` | Expand `isManualEdit` check (line 25) |
| `src/components/common/AuditDetailModal.tsx` | Add fallback batch edit detection (line 43) |
| `e2e/tests/audit-details.spec.ts` | Add batch edit drill-down test |

## Verification

1. **Manual test**:
   - Open app, import CSV
   - Make 3+ rapid cell edits
   - Check audit log shows "Batch Edit (N cells)"
   - Click "View details" → should show all N cells

2. **Run existing tests**:
   ```bash
   npm run test -- audit-details.spec.ts
   ```

3. **Run new batch test**:
   ```bash
   npm run test -- audit-details.spec.ts -g "rapid batch edits"
   ```

## Implementation Status: COMPLETED ✅

### Changes Made

1. **`src/lib/audit-from-timeline.ts`** - Fixed `isManualEdit` check to include batch edits:
   ```typescript
   const isManualEdit =
     command.params.type === 'manual_edit' ||
     command.params.type === 'batch_edit' ||
     command.commandType === 'manual_edit' ||
     command.commandType === 'batch_edit'
   ```

2. **`src/components/common/AuditDetailModal.tsx`** - Added fallback batch edit detection:
   ```typescript
   const isManualEdit =
     entry.entryType === 'B' ||
     entry.action?.includes('Batch Edit') ||
     entry.action === 'Edit Cell' ||
     entry.action === 'Manual Edit' ||
     parsedDetails?.type === 'edit'
   ```

3. **`e2e/tests/audit-details.spec.ts`** - Added two new tests:
   - `should show all cell changes in drill-down for rapid batch edits`
   - `batch edit entry should have correct entryType B`

### Test Results

All 12 audit detail tests pass:
```
✓ should set hasRowDetails and auditEntryId after transformation
✓ should store row-level changes in _audit_details table
✓ should open audit detail modal when clicking entry with details
✓ should display row-level changes in modal table
✓ should export row details as CSV from modal
✓ should include row details in full audit log export
✓ should capture row details for trim transformation
✓ should capture row details for uppercase transformation
✓ should show View details link for manual edit entries and open modal
✓ should export manual edit details as CSV
✓ should show all cell changes in drill-down for rapid batch edits
✓ batch edit entry should have correct entryType B
```
