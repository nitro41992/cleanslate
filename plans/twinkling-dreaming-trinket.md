# Fix Merge Audit Drill-Down and Add E2E Tests

## Problem

The Merge Details modal shows blank kept/deleted row data (screenshot shows empty KEPT/DELETED sections).

## Root Cause

In `src/lib/fuzzy-matcher.ts`, the `escapeForSql()` function double-escapes backslashes:

```typescript
// Current (broken):
const escapeForSql = (str: string) => str.replace(/\\/g, '\\\\').replace(/'/g, "''")
```

When JSON contains escape sequences (like `\"` for embedded quotes), this corrupts the JSON:
- Input: `{"name":"John \"Bob\" Smith"}`
- After escapeForSql: `{"name":"John \\\"Bob\\\" Smith"}` (invalid JSON)

When retrieved, `JSON.parse()` fails silently, returning `{}`, causing `Object.keys({})` to be empty, so nothing renders.

---

## Implementation Plan

### Part 1: Fix the Escaping Bug

**File:** `src/lib/fuzzy-matcher.ts`

**Fix 1:** Simplify `escapeForSql` - only escape single quotes for SQL (lines ~894):
```typescript
// Fixed - only escape single quotes for SQL insertion
const escapeForSql = (str: string) => str.replace(/'/g, "''")
```

**Fix 2:** Add defensive parsing with recovery in `getMergeAuditDetails()` (lines ~991-1005):
```typescript
try {
  keptRowData = JSON.parse(row.kept_row_data)
} catch (parseError) {
  console.error('Failed to parse kept_row_data:', row.kept_row_data, parseError)
  // Attempt recovery: unescape SQL quotes
  try {
    const recovered = row.kept_row_data.replace(/''/g, "'")
    keptRowData = JSON.parse(recovered)
  } catch {
    keptRowData = { _parseError: true, _rawData: row.kept_row_data }
  }
}
```

### Part 2: Add Null Safety in Display

**File:** `src/components/common/MergeDetailTable.tsx`

Add null check and error display when data is empty (around line 109):
```typescript
const columns = Object.keys(detail.keptRowData || {})

if (columns.length === 0) {
  return (
    <div className="border border-amber-500/30 rounded-lg p-4 text-amber-400 text-sm">
      <p>Unable to display row data - parsing failed</p>
    </div>
  )
}
```

---

## Part 3: E2E Tests to Add

**File:** `e2e/tests/feature-coverage.spec.ts` (in FR-C1 section)

### Test 1: Merge audit drill-down displays row data
- Find duplicates, merge a pair, apply merges
- Open audit sidebar, click Apply Merges entry
- Verify modal shows KEPT/DELETED sections with actual column data
- Assert `first_name:` label is visible (proves data rendered)

### Test 2: Special characters in merge audit
- Create fixture with apostrophes, quotes, backslashes
- Merge pair with `O'Brien` / `O'Brian`
- Verify data displays correctly in drill-down modal

### Test 3: Row selection swap functionality
- Find duplicates, expand a pair
- Click swap button (swap which row to keep)
- Verify KEEPING/DELETING labels swap

### Test 4: Chunked matching progress display
- Find duplicates on larger dataset
- Verify progress bar appears during processing
- Verify progress disappears after completion

### Test 5: Export merge details as CSV
- Merge a pair, open audit drill-down
- Click Export CSV button
- Verify filename pattern and CSV contains JSON data

### Test 6: _merge_audit_details table structure
- Merge a pair
- Query `_merge_audit_details` table directly
- Verify `kept_row_data` and `deleted_row_data` are valid JSON

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/fuzzy-matcher.ts` | Fix `escapeForSql()`, add recovery in `getMergeAuditDetails()` |
| `src/components/common/MergeDetailTable.tsx` | Add null safety and error display |
| `e2e/tests/feature-coverage.spec.ts` | Add 6 new tests in FR-C1 section |
| `e2e/fixtures/csv/fr_c1_special_chars.csv` | New fixture with special characters |

---

## Test Fixture to Create

**File:** `e2e/fixtures/csv/fr_c1_special_chars.csv`
```csv
id,name,email,notes
1,Bob O'Brien,bob@test.com,Irish name
2,Bobby O'Brian,bobby@test.com,Similar Irish name
3,John "Jack" Smith,john@test.com,Name with quotes
4,Jon "Jackie" Smyth,jon@test.com,Similar with quotes
```

---

## Verification

1. Run `npm run lint` - no errors
2. Run `npm test` - all tests pass
3. Manual test:
   - Upload CSV with special characters
   - Find duplicates, merge pairs, apply
   - Open audit drill-down
   - Verify kept/deleted data displays correctly
   - Export CSV and verify content
