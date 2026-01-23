# Fix Standardize Audit Drill-down and Diff View

## Problem Summary

The Standardize feature has three issues:
1. **Duplicate audit entries**: Creates 2 audit items instead of 1
2. **Audit drill-down not working**: "View details" link doesn't show standardization details
3. **Diff view broken**: Shows "No transformations applied yet" after standardize

## Root Cause Analysis

### Issue 1: Duplicate Audit Entries
**Location**: `src/features/standardizer/StandardizeView.tsx:149-158`

The code manually calls `addTransformationEntry()` AFTER `executor.execute()`, but the CommandExecutor already creates an audit entry via `recordAudit()` (executor.ts:682-698).

### Issue 2: Audit Drill-down Not Working
**Location**: `src/components/common/AuditDetailModal.tsx:33`

```typescript
const isStandardizeAction = entry.action === 'Standardize Values'  // EXACT MATCH
```

But `StandardizeApplyCommand.getAuditInfo()` returns:
```typescript
action: `Standardize Values in ${column}`  // INCLUDES COLUMN NAME
```

The exact match fails, so the modal uses `AuditDetailTable` (reads from `_audit_details`) instead of `StandardizeDetailTable` (reads from `_standardize_audit_details`).

### Issue 3: Diff View Shows "No transformations applied yet"
**Location**: `src/lib/commands/executor.ts:817-828` and `src/components/diff/DiffConfigPanel.tsx:62-95`

When CommandExecutor creates timeline via `syncExecuteToTimelineStore()`, it passes empty string for `originalSnapshotName`:
```typescript
timelineStoreState.createTimeline(tableId, tableName, '')  // EMPTY STRING
```

The DiffConfigPanel checks:
1. `hasOriginalSnapshot(activeTableName)` - old style `_original_${tableName}`
2. `timeline?.originalSnapshotName` - empty string, so fails

The Tier 3 snapshot (`_cmd_snapshot_*`) exists but isn't set as `originalSnapshotName`.

---

## Implementation Plan

### Fix 1: Remove Duplicate Audit Entry
**File**: `src/features/standardizer/StandardizeView.tsx`

Remove lines 149-158 that manually add audit entry since executor already handles this.

```typescript
// REMOVE THIS BLOCK (lines 148-159):
// Add audit entry (executor creates audit info, but we still need to add to store)
if (result.auditInfo) {
  addTransformationEntry({
    tableId,
    tableName,
    action: result.auditInfo.action,
    details: `Standardized ${mappings.length} value${mappings.length !== 1 ? 's' : ''} in '${columnName}' column using ${algorithm} algorithm`,
    rowsAffected: result.auditInfo.rowsAffected,
    hasRowDetails: result.auditInfo.hasRowDetails,
    auditEntryId: result.auditInfo.auditEntryId,
  })
}
```

### Fix 2: Fix Audit Drill-down Detection (Refined)
**File**: `src/components/common/AuditDetailModal.tsx`

Instead of relying on the human-readable `action` string, inspect the `details` object structure which has `type: 'standardize'`.

**Before** (line 33):
```typescript
const isStandardizeAction = entry.action === 'Standardize Values'
```

**After**:
```typescript
// Parse details JSON to check the structured type field
const parsedDetails = (() => {
  try {
    return typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details
  } catch {
    return null
  }
})()

const isMergeAction = parsedDetails?.type === 'merge' || entry.action === 'Apply Merges'
const isStandardizeAction = parsedDetails?.type === 'standardize'
const isManualEdit = entry.entryType === 'B'
```

This approach:
- Uses the structured `type` field from `StandardizeAuditDetails` interface
- Is robust against action string changes
- Falls back gracefully if parsing fails

### Fix 3: Set originalSnapshotName for Diff View
**File**: `src/lib/commands/executor.ts`

The fix should set `originalSnapshotName` ONLY on the first snapshot (first Tier 3 command). The condition `!timeline?.originalSnapshotName` ensures this only happens once.

**Location**: After snapshot creation in `execute()` method (around line 166)

```typescript
// Step 3: Pre-snapshot for Tier 3
let snapshotTableName: string | undefined
if (needsSnapshot && !skipTimeline) {
  progress('snapshotting', 20, 'Creating backup snapshot...')
  snapshotTableName = await this.createSnapshot(ctx)

  // If this is the first snapshot for this table, set it as originalSnapshotName
  // so the Diff View can compare against original state
  const timelineStore = useTimelineStore.getState()
  const existingTimeline = timelineStore.getTimeline(tableId)
  if (!existingTimeline?.originalSnapshotName) {
    timelineStore.updateTimelineOriginalSnapshot(tableId, snapshotTableName)
  }

  // Prune oldest snapshot if over limit
  await this.pruneOldestSnapshot(getTimeline(tableId))
}
```

**Note**: The condition `!existingTimeline?.originalSnapshotName` ensures:
- First command: Snapshot = Original state (correct)
- 5th command: originalSnapshotName already set, no update (correct)

**Sync Consideration**: `useTimelineStore.getState()` is synchronous Zustand access. The update happens before `execute()` continues, so DiffConfigPanel will see the updated value.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/common/AuditDetailModal.tsx` | Parse details JSON, check `type === 'standardize'` |
| `src/features/standardizer/StandardizeView.tsx` | Remove duplicate `addTransformationEntry()` call |
| `src/lib/commands/executor.ts` | Set `originalSnapshotName` on first Tier 3 snapshot |

---

## Verification Plan

### Manual Testing
1. Load a CSV file
2. Open Value Standardizer panel
3. Select a column and run analysis
4. Select values and apply standardization
5. Verify:
   - Only 1 audit entry appears (not 2)
   - "View details" link opens StandardizeDetailTable with value mappings
   - Diff view shows "Original snapshot available" (not "No transformations applied yet")

### E2E Tests
Add tests to `e2e/tests/value-standardization.spec.ts`:

```typescript
test('FR-F: should create single audit entry with working drill-down', async () => {
  // Setup: Load CSV, run standardization analysis
  // Apply standardization

  // Verify only 1 audit entry with "Standardize Values" action
  const auditEntries = await inspector.getAuditEntries()
  const standardizeEntries = auditEntries.filter(e =>
    e.action.startsWith('Standardize Values')
  )
  expect(standardizeEntries.length).toBe(1)

  // Click "View details" on the audit entry
  await page.click('[data-testid="audit-entry-with-details"]')

  // Verify StandardizeDetailTable is shown (not AuditDetailTable)
  await expect(page.getByTestId('standardize-detail-table')).toBeVisible()
})

test('FR-F: should enable diff view after standardization', async () => {
  // Setup: Load CSV, apply standardization

  // Open diff panel (Compare with Preview mode)
  await page.click('[data-testid="toolbar-diff"]')

  // Verify "Original snapshot available" message appears
  await expect(page.getByText('Original snapshot available')).toBeVisible()

  // Verify we can run diff
  await page.click('[data-testid="diff-run-btn"]')
  // ... verify diff results
})
```

---

## Risk Assessment

- **Low risk**: All changes are isolated to specific detection logic
- **No breaking changes**: Only fixing broken functionality
- **Backward compatible**: Existing audit entries will work correctly (fallback to action string check if details parsing fails)
