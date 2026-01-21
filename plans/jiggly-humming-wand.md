# Plan: Manual Edit Audit Log Drill-Down

## Problem
Manual cell edits (Type B audit entries) cannot be clicked to see drill-down details, unlike transformation and merge entries which show detailed views in a modal.

## Root Cause
- `addManualEditEntry()` in `auditStore.ts` does not set `hasRowDetails` or `auditEntryId`
- The click handler only allows drill-down when both fields are present
- Current test explicitly verifies manual edits do NOT have drill-down (by design)

## Solution
Enable drill-down for Type B entries using the embedded data (no DB queries needed since `previousValue`, `newValue`, `rowIndex`, `columnName` are already stored in the entry).

---

## Implementation Steps

### 1. Modify `src/stores/auditStore.ts`
**Lines 82-99** - Add drill-down flags to `addManualEditEntry()`:

```typescript
addManualEditEntry: (params) => {
  const entryId = generateId()
  const entry: AuditLogEntry = {
    id: entryId,
    // ... existing fields ...
    // ADD these two lines:
    hasRowDetails: true,
    auditEntryId: entryId,
  }
}
```

### 2. Create `src/components/common/ManualEditDetailView.tsx`
New component that displays single-cell change details without DB queries.

- Follow pattern from `AuditDetailTable.tsx`
- Show table with: Row #, Column, Previous Value, New Value
- Single row (no pagination needed)
- Test IDs: `manual-edit-detail-view`, `manual-edit-detail-table`, `manual-edit-detail-row`

### 3. Modify `src/components/common/AuditDetailModal.tsx`

**Add import:**
```typescript
import { ManualEditDetailView } from './ManualEditDetailView'
import { Edit3 } from 'lucide-react'
```

**Add detection (after line 29):**
```typescript
const isManualEdit = entry.entryType === 'B'
```

**Update title section (lines 93-105):**
- Add `Edit3` icon for manual edits
- Title: "Manual Edit Details"
- Description: "Details of the manual cell edit"

**Update detail rendering (lines 137-143):**
```typescript
{isMergeAction ? (
  <MergeDetailTable ... />
) : isManualEdit ? (
  <ManualEditDetailView entry={entry} />
) : (
  <AuditDetailTable ... />
)}
```

**Update CSV export (lines 31-85):**
Add handler for Type B that exports single row using embedded data.

### 4. Update `e2e/tests/audit-details.spec.ts`

**Modify test at lines 300-339:**
Change "should not show View details link for entries without row details" to:
- "should show View details link for manual edit entries and open modal"
- Verify `hasRowDetails: true` and `auditEntryId` are set
- Verify "View details" IS visible
- Click and verify modal opens with "Manual Edit Details" title
- Verify `manual-edit-detail-view` and `manual-edit-detail-row` test IDs visible

**Add new test:**
- "should export manual edit details as CSV"
- Verify filename pattern: `manual_edit_*_1row.csv`
- Verify CSV has header and single data row

---

## Files to Modify
1. `src/stores/auditStore.ts` - Add `hasRowDetails` + `auditEntryId`
2. `src/components/common/ManualEditDetailView.tsx` - NEW FILE
3. `src/components/common/AuditDetailModal.tsx` - Add Type B handling
4. `e2e/tests/audit-details.spec.ts` - Update tests

## Verification
1. Run existing tests: `npm test -- --grep "Audit Row Details"`
2. Manual test:
   - Load CSV, edit a cell manually
   - Open audit sidebar
   - Verify "View details" appears on Manual Edit entry
   - Click to open modal
   - Verify "Manual Edit Details" title and single row displayed
   - Click "Export CSV" and verify download
3. Run lint: `npm run lint`
4. Run full test suite: `npm test`
