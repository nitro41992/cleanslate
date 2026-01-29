# Fix: Standardize Transform Drill-Down Not Showing Details

## Problem Summary

The **value standardization** (`standardize:apply`) audit log entry shows "View details" link but when clicked, the drill-down modal shows **nothing** or the wrong content (generic `AuditDetailTable` instead of `StandardizeDetailTable`).

The user expected to see which values were standardized to the master value, with row counts.

## Root Cause Analysis

### The Data Flow

```
StandardizeApplyCommand.getAuditInfo()
    ↓ returns { details: { type: 'standardize', column, algorithm, clusters }, ... }

syncExecuteToTimelineStore()
    ↓ passes auditInfo to appendCommand()

timelineStore.appendCommand()
    ↓ stores TimelineCommand (params.type = 'standardize')

audit-from-timeline.ts: convertCommandToAuditEntry()
    ↓ calls buildDetails(command) → returns STRING "Standardized 3 values in 'name'"

AuditLogEntry.details = STRING (not structured object!)
    ↓

AuditDetailModal.tsx: parsedDetails = JSON.parse(entry.details)
    ↓ FAILS because "Standardized 3 values..." is not valid JSON

parsedDetails?.type === 'standardize' → FALSE (null?.type)
    ↓

Modal renders <AuditDetailTable> instead of <StandardizeDetailTable>
```

### Bug Location: `src/lib/audit-from-timeline.ts` lines 63 + 79-96

The `buildDetails()` function returns a **string** instead of a JSON-serializable structured object:

```typescript
// Line 63: details is a string
details: buildDetails(command),

// Lines 95-96: Returns plain string
case 'standardize':
  return `Standardized ${params.mappings?.length || 0} values in "${params.columnName}"`
```

### Why Merge Works But Standardize Doesn't

Looking at `AuditDetailModal.tsx` line 41:
```typescript
// Merge has fallback detection on action text
const isMergeAction = parsedDetails?.type === 'merge' ||
                      entry.action === 'Apply Merges' ||
                      entry.action === 'Merge Duplicates'

// Standardize has NO fallback - relies only on parsedDetails.type
const isStandardizeAction = parsedDetails?.type === 'standardize'
```

When `JSON.parse()` fails on the string "Standardized 3 values...", merge still works due to its fallback check on `entry.action`, but standardize does not.

## Fix Options

### Option A: Add Action-Based Fallback (Quick Fix)
Add fallback detection in `AuditDetailModal.tsx` similar to merge.

**Pros:** Minimal change, low risk
**Cons:** Band-aid, doesn't fix root cause

### Option B: Store Structured Details as JSON String (Proper Fix)
Modify `buildDetails()` to return `JSON.stringify({type: 'standardize', ...})` for standardize commands.

**Pros:** Fixes root cause, modal detection works correctly
**Cons:** More invasive, need to update buildDetails signature or add special case

### Option C: Hybrid (Recommended)
1. Quick fix: Add action-based fallback in modal (immediate fix)
2. Long-term: Update `buildDetails()` to return JSON for structured types

## Recommended Fix Plan

### Fix 1: `src/components/common/AuditDetailModal.tsx` line 42

Add fallback detection for standardize similar to merge:

```typescript
// Before
const isStandardizeAction = parsedDetails?.type === 'standardize'

// After
const isStandardizeAction =
  parsedDetails?.type === 'standardize' ||
  entry.action?.includes('Standardize Values')
```

This matches the action text `"Standardize Values in {column}"` from `StandardizeApplyCommand.getAuditInfo()`.

### Fix 2: Add E2E Test to Prevent Regression

In `e2e/tests/value-standardization.spec.ts`, update the `FR-F-INT-2` test to verify the correct detail table is rendered:

```typescript
test('FR-F-INT-2: Audit drill-down should show standardization details', async () => {
  // ... existing setup code ...

  // Verify StandardizeDetailTable is rendered (not generic AuditDetailTable)
  const standardizeTable = modal.getByTestId('standardize-detail-table')
  await expect(standardizeTable).toBeVisible({ timeout: 5000 })

  // Verify it shows value mappings (from → to)
  await expect(modal.locator('text=Original Value')).toBeVisible()
  await expect(modal.locator('text=Standardized To')).toBeVisible()
  await expect(modal.locator('text=Rows Changed')).toBeVisible()
})
```

## Files to Modify

| File | Change |
|------|--------|
| `src/components/common/AuditDetailModal.tsx` | Add fallback action check for standardize (line 42) |
| `e2e/tests/value-standardization.spec.ts` | Enhance FR-F-INT-2 test to verify correct component renders |

## Verification

1. **Manual test**:
   - Open app, import CSV with duplicate-ish values (e.g., "John", "john", "JOHN")
   - Open Standardize panel, select column, analyze, apply standardization
   - Open Audit sidebar → find "Standardize Values in {column}" entry
   - Verify "View details" link appears
   - Click entry → modal should show `StandardizeDetailTable` with:
     - "Original Value" → "Standardized To" columns
     - Row counts for each mapping
     - Total rows affected

2. **Run existing tests**:
   ```bash
   npm run test -- value-standardization.spec.ts
   ```

3. **Verify the modal shows correct component**:
   - The test should check for `data-testid="standardize-detail-table"` (not `audit-detail-table`)

## Note

This is the same pattern as the batch edit fix from `streamed-kindling-scone.md` - adding fallback detection when the structured `details.type` check fails due to string-based details storage.

The long-term fix would be to modify `buildDetails()` to return JSON strings for standardize/merge types, but that's a larger refactor and this fallback approach is consistent with how merge already works.
