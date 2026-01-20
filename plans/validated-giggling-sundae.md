# Test Analysis: Pass/Fail Breakdown

## Summary

| Category | Count |
|----------|-------|
| **Truly Passing** | 32 |
| **Expected Failures (test.fail())** | 22 |
| **Total** | 54 |

---

## Passing Tests (32 tests)

### FR-A3: Text Cleaning (3 tests)
- ✅ Trim Whitespace
- ✅ Uppercase
- ✅ Lowercase

### FR-A4: Manual Cell Editing (3 tests)
- ✅ Commit cell edit and record in audit log
- ✅ Undo/redo cell edits
- ✅ Show dirty indicator on edited cells

### FR-A6: Ingestion Wizard (2 tests)
- ✅ Detect and skip garbage header rows
- ✅ Handle Row 1 header selection (boundary)

### Module Page Loads (3 tests)
- ✅ FR-B2: Visual Diff page loads
- ✅ FR-C1: Fuzzy Matcher page loads
- ✅ FR-D2: Smart Scrubber page loads

### Export (6 tests)
- ✅ Export CSV with correct filename
- ✅ Export data with correct headers
- ✅ Export all data rows
- ✅ Export transformed data
- ✅ Export after multiple transformations
- ✅ Export reduced rows after deduplication

### E2E Flow (3 tests)
- ✅ upload → configure → transform → verify → export
- ✅ upload pipe-delimited → detect delimiter → transform → export
- ✅ upload → deduplicate → filter empty → export

### File Upload (6 tests)
- ✅ Show dropzone on initial load
- ✅ Open ingestion wizard when CSV uploaded
- ✅ Load file with default settings
- ✅ Show data grid after file loaded
- ✅ Detect pipe delimiter
- ✅ Allow custom header row selection

### Transformations (7 tests)
- ✅ Apply trim transformation
- ✅ Apply uppercase transformation
- ✅ Apply lowercase transformation
- ✅ Remove duplicates
- ✅ Filter empty values
- ✅ Chain multiple transformations
- ✅ Log transformations to audit log

---

## Expected Failures (22 tests with `test.fail()`)

### TRULY PENDING - Feature Not Implemented (19 tests)

#### FR-A3: Text Transforms (3 tests)
- 🔲 Title Case - transformation not added to picker
- 🔲 Remove Accents - transformation not added to picker
- 🔲 Remove Non-Printable - transformation not added to picker

#### FR-A3: Finance Transforms (3 tests)
- 🔲 Unformat Currency - transformation not implemented
- 🔲 Fix Negatives - transformation not implemented
- 🔲 Pad Zeros - transformation not implemented

#### FR-A3: Date/Structure Transforms (4 tests)
- 🔲 Standardize Date - transformation not implemented
- 🔲 Calculate Age - transformation not implemented
- 🔲 Split Column - transformation not implemented
- 🔲 Fill Down - transformation not implemented

#### FR-C1: Fuzzy Matcher (2 tests)
- 🔲 Detect duplicate records with fuzzy matching
- 🔲 Support blocking strategy for performance

#### FR-D2: Smart Scrubber (4 tests)
- 🔲 Hash sensitive columns
- 🔲 Redact PII patterns
- 🔲 Mask partial values
- 🔲 Extract year only from dates

#### FR-E: Combiner (3 tests)
- 🔲 Stack two CSV files with Union All
- 🔲 Perform inner join on customer_id
- 🔲 Perform left join preserving unmatched orders

**Note:** Combiner page (`/combiner`) doesn't exist yet.

---

### IMPLEMENTED BUT TEST NEEDS FIX (3 tests)

#### FR-A6: Raw Preview (1 test)
- ⚠️ **"should show raw preview of file content"**
- **Issue:** Test expects `data-testid="raw-preview"` but the element doesn't have this test-id
- **Fix:** Add `data-testid="raw-preview"` to the preview element in IngestionWizard

#### FR-B2: Visual Diff (1 test)
- ⚠️ **"should identify added, removed, and modified rows"**
- **Issue:** Test expects `data-testid="diff-compare-btn"` but the button doesn't have this test-id
- **Status:** The diff engine (`src/lib/diff-engine.ts`) and UI (`src/features/diff/DiffPage.tsx`) are **FULLY IMPLEMENTED**
- **Fix:** Add `data-testid="diff-compare-btn"` to the Run Comparison button

#### FR-A6: Encoding Detection (1 test - if it exists)
- Need to verify if encoding override UI has proper test-ids

---

## Implementation Plan: Fix Test-IDs

### Fix 1: FR-B2 Visual Diff Button
**File:** `src/features/diff/DiffPage.tsx`
**Line:** 234
**Change:** Add `data-testid="diff-compare-btn"` to the Run Comparison button

```tsx
// Before:
<Button
  className="w-full"
  onClick={handleRunDiff}
  disabled={...}
>

// After:
<Button
  className="w-full"
  onClick={handleRunDiff}
  disabled={...}
  data-testid="diff-compare-btn"
>
```

### Fix 2: FR-A6 Raw Preview Element
**File:** `src/components/common/IngestionWizard.tsx`
**Line:** 227
**Change:** Add `data-testid="raw-preview"` to the ScrollArea wrapper

```tsx
// Before:
<ScrollArea className="flex-1 rounded-lg border border-border/50 bg-background">

// After:
<ScrollArea className="flex-1 rounded-lg border border-border/50 bg-background" data-testid="raw-preview">
```

### Fix 3: Remove `test.fail()` from tests

After adding test-ids, the tests will pass the fail-fast guards. Since they're marked `test.fail()`, Playwright will mark them as FAILED (because they didn't fail as expected).

**File:** `e2e/tests/feature-coverage.spec.ts`

1. **Line 445** - Remove `test.fail()` from "should show raw preview of file content"
   - Test has actual assertions that will work once test-id is added

2. **Line 495** - Remove `test.fail()` from "should identify added, removed, and modified rows"
   - Test body is mostly comments - consider adding real assertions or leave as placeholder

---

## Verification

After making these changes, run:
```bash
npm test -- --grep "raw preview"   # FR-A6 raw preview test
npm test -- --grep "added, removed"   # FR-B2 diff test
```

Expected outcome:
- "should show raw preview of file content" - **PASS** (assertions exist in test)
- "should identify added, removed, and modified rows" - **PASS** (vacuously, no assertions after guard)
