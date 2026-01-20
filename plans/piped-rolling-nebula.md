# Plan: Fix E2E Test Timeout Issues

## Summary
Fix timeout issues in `feature-coverage.spec.ts` caused by malformed CSV fixtures with unquoted special characters.

---

## Root Cause

The `fr_a3_text_dirty.csv` fixture has **unquoted embedded newlines and tabs** that violate CSV RFC 4180:

```csv
# BROKEN - unquoted special characters:
5,Alice
Brown,alice@test.com,Has newline in name   ← breaks parsing
4,Bob	Wilson,bob@test.com,Has	tab	characters  ← tabs in field
```

**Result:** DuckDB parses 6-7 rows instead of 8 → `waitForTableLoaded(..., 8)` times out after 30s.

---

## Fix

Update `e2e/fixtures/csv/fr_a3_text_dirty.csv` with proper CSV quoting:

```csv
id,name,email,notes
1,  John Smith  ,JOHN@EXAMPLE.COM,Clean record
2,JANE DOE,jane@test.org,  Extra spaces
3,café résumé,accent@test.com,"Has accents: naïve"
4,"Bob	Wilson",bob@test.com,"Has	tab	characters"
5,"Alice
Brown",alice@test.com,Has newline in name
6,  MIKE  JONES  ,mike@test.com,Multiple   internal   spaces
7,São Paulo,city@test.com,Brazilian city name
8,Über driver,uber@test.com,German umlaut
```

**Key changes:**
- Row 4: Quote `"Bob\tWilson"` and `"Has\ttab\tcharacters"`
- Row 5: Quote `"Alice\nBrown"` (field with embedded newline)
- Row 3: Quote `"Has accents: naïve"` for safety

---

## Files to Modify

1. `e2e/fixtures/csv/fr_a3_text_dirty.csv` - Fix quoting

---

## Verification

```bash
npm run test -- e2e/tests/feature-coverage.spec.ts --grep "trim|uppercase|lowercase"
```

Expected: 3 tests pass (trim, uppercase, lowercase) instead of timing out.

---

## Original Fixture Files Created

### 1. FR-A3 Text Cleaning
**File:** `e2e/fixtures/csv/fr_a3_text_dirty.csv`
- Tests: Trim, Casing, Accents, Non-Printable removal

### 2. FR-A3 Finance & Numbers
**File:** `e2e/fixtures/csv/fr_a3_finance.csv`
- Tests: Currency parsing, Negative formatting, Zero padding

### 3. FR-A6 Ingestion Wizard
**File:** `e2e/fixtures/csv/fr_a6_legacy_garbage.csv`
- Tests: Header row selection with garbage rows

### 4. FR-B2 Visual Diff (2 files)
**Files:** `e2e/fixtures/csv/fr_b2_base.csv`, `e2e/fixtures/csv/fr_b2_new.csv`
- Tests: Row added/removed/modified detection

### 5. FR-C1 Fuzzy Matcher
**File:** `e2e/fixtures/csv/fr_c1_dedupe.csv`
- Tests: Blocking strategy, Match scores

### 6. FR-D2 Obfuscation
**File:** `e2e/fixtures/csv/fr_d2_pii.csv`
- Tests: Redaction patterns, Hashing consistency

### 7. FR-E2 Combiner - Joins (2 files)
**Files:** `e2e/fixtures/csv/fr_e2_orders.csv`, `e2e/fixtures/csv/fr_e2_customers.csv`
- Tests: Left Join, Inner Join

### 8. FR-A3 Dates & Structure
**File:** `e2e/fixtures/csv/fr_a3_dates_split.csv`
- Tests: Date standardization, Age calculation, Column splitting

### 9. FR-A3 Fill Down
**File:** `e2e/fixtures/csv/fr_a3_fill_down.csv`
- Tests: Excel-style fill down

### 10. FR-E1 Combiner - Stacking (2 files)
**Files:** `e2e/fixtures/csv/fr_e1_jan_sales.csv`, `e2e/fixtures/csv/fr_e1_feb_sales.csv`
- Tests: Union All stacking

---

## Implementation Status Analysis

Based on code review, here's what's **IMPLEMENTED** vs **PENDING**:

### ✅ IMPLEMENTED (Tests Should Pass)
| Feature | File/Module |
|---------|-------------|
| Trim Whitespace | `transformations.ts:trim` |
| Lowercase | `transformations.ts:lowercase` |
| Uppercase | `transformations.ts:uppercase` |
| FR-A4 Cell Editing | `editStore.ts` |
| FR-A6 Ingestion Wizard | `IngestionWizard.tsx` |
| FR-B2 Visual Diff | `diff-engine.ts` |
| FR-D2 Obfuscation (hash, redact, mask, year_only) | `obfuscation.ts` |

### ❌ PENDING (Tests Will Fail)
| Feature | PRD Reference |
|---------|---------------|
| Title Case | FR-A3 |
| Remove Accents | FR-A3 |
| Remove Non-Printable (tabs, newlines) | FR-A3 |
| Unformat Currency | FR-A3 |
| Fix Negatives `(500)` → `-500` | FR-A3 |
| Pad Zeros | FR-A3 |
| Fill Down | FR-A3 |
| Date Standardization | FR-A3 |
| Age Calculation | FR-A3 |
| Split Column | FR-A3 |
| FR-C1 Fuzzy Matcher Blocking | FR-C1 |
| FR-E1 Stack Files (Union) | FR-E1 |
| FR-E2 Merge Files (Joins) | FR-E2 |

---

## Execution Steps

1. Create 12 CSV fixture files in `e2e/fixtures/csv/`
2. Create corresponding test spec file `e2e/tests/feature-coverage.spec.ts`
3. Run `npm run test` to execute Playwright tests
4. Report results: PASS/FAIL per fixture

---

## Verification
- Run: `npm run test -- --reporter=list`
- Check test output for pass/fail status on each fixture
