# Playwright Tests for Row-Level Audit Details and REGEXP_REPLACE Fix

## Features to Test

Based on commit `3ac78b4` and current uncommitted changes:

1. **Case-insensitive Find & Replace (REGEXP_REPLACE fix)** - Tests already exist, should now pass
2. **Row-level audit details capture** - `hasRowDetails` and `auditEntryId` on audit entries
3. **Audit detail modal** - Opening, viewing row details, scrolling
4. **Audit detail CSV export** - Export from modal
5. **Audit log export with row details** - Full export includes row-level changes

---

## Implementation Plan

### 1. Update StoreInspector Interface

**File:** `e2e/helpers/store-inspector.ts`

Add missing fields to `AuditEntry` interface:

```typescript
export interface AuditEntry {
  // ... existing fields ...
  hasRowDetails?: boolean      // NEW
  auditEntryId?: string        // NEW
  rowsAffected?: number        // NEW
}
```

### 2. Add Test IDs to Audit Components

**File:** `src/components/common/AuditLogPanel.tsx`
- Add `data-testid="audit-log-panel"`
- Add `data-testid="audit-export-btn"` to export button
- Add `data-testid="audit-entry-{id}"` or `data-testid="audit-entry-with-details"` to clickable entries

**File:** `src/components/common/AuditDetailModal.tsx`
- Add `data-testid="audit-detail-modal"`
- Add `data-testid="audit-detail-export-csv-btn"` to CSV export button

**File:** `src/components/common/AuditDetailTable.tsx`
- Add `data-testid="audit-detail-table"`
- Add `data-testid="audit-detail-row"` to table rows

### 3. Add Download Helper for TXT Export

**File:** `e2e/helpers/download-helpers.ts`

Add new function:
```typescript
export async function downloadAndVerifyTXT(
  page: Page,
  buttonSelector: string
): Promise<{ filename: string; content: string }>
```

### 4. Add New Test File

**File:** `e2e/tests/audit-details.spec.ts`

New serial test group covering:

```typescript
test.describe.serial('Audit Row Details', () => {
  // beforeAll: setup page, DuckDB, page objects

  test('should set hasRowDetails and auditEntryId after transformation', async () => {
    // Load data, run transformation
    // Verify audit entry has hasRowDetails: true and auditEntryId set
  })

  test('should store row-level changes in _audit_details table', async () => {
    // Run transformation on small dataset (< 10k rows)
    // Query _audit_details table directly via runQuery()
    // Verify previous_value and new_value are captured
  })

  test('should open audit detail modal when clicking entry with details', async () => {
    // Run transformation, switch to audit tab
    // Click entry with "View details →" link
    // Verify modal opens with correct title
  })

  test('should display row-level changes in modal table', async () => {
    // Open modal (from previous test or fresh)
    // Verify table shows Row #, Column, Previous Value, New Value
    // Verify data matches expected transformations
  })

  test('should scroll audit detail table', async () => {
    // Open modal with enough rows to scroll
    // Verify ScrollArea is scrollable (h-[400px] fix)
  })

  test('should export row details as CSV from modal', async () => {
    // Open modal, click Export CSV button
    // Verify download contains header + data rows
    // Verify filename pattern: audit_details_{id}_{rows}rows.csv
  })

  test('should include row details in full audit log export', async () => {
    // Run transformation with row details
    // Click main export button in audit panel
    // Verify TXT export contains "Row Details (N changes):"
    // Verify each row change is listed
  })

  test('should NOT capture row details for large datasets (>10k threshold)', async () => {
    // This would require a large fixture or mocking
    // Optional: test that hasRowDetails is false for large transforms
  })
})
```

### 5. Verify Existing Find & Replace Tests Pass

**File:** `e2e/tests/transformations.spec.ts`

The existing tests at lines 475-536 should now pass with the REGEXP_REPLACE fix:
- `should apply case-insensitive find and replace` (line 475)
- `should apply exact match find and replace` (line 496)
- `should apply case-insensitive exact match find and replace` (line 517)

Run these tests to confirm the fix works.

---

## Files to Modify/Create

| File | Action | Purpose |
|------|--------|---------|
| `e2e/helpers/store-inspector.ts` | Modify | Add hasRowDetails, auditEntryId, rowsAffected to AuditEntry |
| `e2e/helpers/download-helpers.ts` | Modify | Add downloadAndVerifyTXT helper |
| `src/components/common/AuditLogPanel.tsx` | Modify | Add test-ids |
| `src/components/common/AuditDetailModal.tsx` | Modify | Add test-ids |
| `src/components/common/AuditDetailTable.tsx` | Modify | Add test-ids |
| `e2e/tests/audit-details.spec.ts` | Create | New test file for audit row details |

---

## Test Fixtures

Use existing fixtures:
- `e2e/fixtures/csv/case-sensitive-data.csv` - For Find & Replace tests (4 rows)
- `e2e/fixtures/csv/basic-data.csv` - Simple dataset for audit detail tests

No new fixtures needed - existing small datasets will trigger row detail capture (< 10k threshold).

---

## Verification Steps

1. Run existing Find & Replace tests:
   ```bash
   npm test -- --grep "case-insensitive find and replace"
   ```

2. Run new audit details tests:
   ```bash
   npm test -- --grep "Audit Row Details"
   ```

3. Run full test suite:
   ```bash
   npm test
   ```

---

## Test Data Flow

```
1. Upload CSV (e.g., case-sensitive-data.csv, 4 rows)
2. Add Find & Replace transformation (case-insensitive)
3. Run Recipe
   └── transformations.ts:
       ├── countAffectedRows() → preCountAffected
       ├── captureRowDetails() → inserts to _audit_details table
       │   └── hasRowDetails = true, auditEntryId generated
       └── applyTransformation() → UPDATE with REGEXP_REPLACE
4. auditStore records entry with hasRowDetails + auditEntryId
5. UI shows "View details →" link on audit entry
6. Click → AuditDetailModal opens
7. AuditDetailTable fetches from _audit_details via getAuditRowDetails()
8. Export CSV → downloads row-level changes
9. Export audit log → includes row details in TXT
```
