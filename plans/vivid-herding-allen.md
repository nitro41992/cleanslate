# E2E Test Coverage Audit

## Summary

This audit compares all commands and features in CleanSlate Pro against existing E2E test coverage to identify gaps.

---

## 1. Command Coverage Analysis

### All Registered Commands (from `src/lib/commands/registry.ts`)

| Command Type | Tier | Has E2E Test? | Test Location |
|-------------|------|---------------|---------------|
| **Tier 1 - Column Versioning** |
| `transform:trim` | 1 | ✅ | transformations.spec.ts, feature-coverage.spec.ts |
| `transform:lowercase` | 1 | ✅ | transformations.spec.ts, feature-coverage.spec.ts |
| `transform:uppercase` | 1 | ✅ | transformations.spec.ts, feature-coverage.spec.ts |
| `transform:title_case` | 1 | ✅ | feature-coverage.spec.ts |
| `transform:remove_accents` | 1 | ✅ | feature-coverage.spec.ts |
| `transform:replace` | 1 | ✅ | transformations.spec.ts |
| `transform:replace_empty` | 1 | ✅ | transformations.spec.ts |
| `transform:sentence_case` | 1 | ❌ **MISSING** | - |
| `transform:collapse_spaces` | 1 | ❌ **MISSING** | - |
| `transform:remove_non_printable` | 1 | ✅ | feature-coverage.spec.ts |
| `scrub:hash` | 1 | ✅ | feature-coverage.spec.ts (FR-D2) |
| `scrub:mask` | 1 | ✅ | feature-coverage.spec.ts (FR-D2) |
| **Tier 2 - Invertible SQL** |
| `transform:rename_column` | 2 | ✅ | transformations.spec.ts |
| `edit:cell` | 2 | ✅ | feature-coverage.spec.ts (FR-A4) |
| `edit:batch` | 2 | ✅ | audit-details.spec.ts |
| `combine:stack` | 2 | ✅ | feature-coverage.spec.ts (FR-E1) |
| `combine:join` | 2 | ✅ | feature-coverage.spec.ts (FR-E2) |
| **Tier 3 - Snapshot Required** |
| `transform:remove_duplicates` | 3 | ✅ | transformations.spec.ts |
| `transform:cast_type` | 3 | ✅ | transformations.spec.ts |
| `transform:split_column` | 3 | ✅ | feature-coverage.spec.ts |
| `transform:combine_columns` | 3 | ❌ **MISSING** | - |
| `transform:standardize_date` | 3 | ✅ | feature-coverage.spec.ts |
| `transform:calculate_age` | 3 | ✅ | feature-coverage.spec.ts |
| `transform:unformat_currency` | 3 | ✅ | feature-coverage.spec.ts |
| `transform:fix_negatives` | 3 | ✅ | feature-coverage.spec.ts |
| `transform:pad_zeros` | 3 | ✅ | feature-coverage.spec.ts, tier-3-undo-param-preservation.spec.ts |
| `transform:fill_down` | 3 | ✅ | feature-coverage.spec.ts |
| `transform:custom_sql` | 3 | ✅ | transformations.spec.ts |
| `standardize:apply` | 3 | ✅ | value-standardization.spec.ts |
| `match:merge` | 3 | ✅ | feature-coverage.spec.ts (FR-C1) |
| `scrub:redact` | 3 | ✅ | feature-coverage.spec.ts (FR-D2) |
| `scrub:year_only` | 3 | ✅ | feature-coverage.spec.ts (FR-D2) |

---

## 2. Missing Command Tests (Critical Gaps)

### 2.1 `transform:sentence_case` - ❌ NO TEST
- **Risk**: Medium
- **Location**: `src/lib/commands/transform/tier1/sentence-case.ts`
- **Required Test**:
  - Basic sentence casing transformation
  - Multi-sentence text handling
  - Edge cases (all caps input, already lowercase)

### 2.2 `transform:collapse_spaces` - ❌ NO TEST
- **Risk**: Medium
- **Location**: `src/lib/commands/transform/tier1/collapse-spaces.ts`
- **Required Test**:
  - Multiple consecutive spaces collapsed to single space
  - Tabs and mixed whitespace handling
  - Edge cases (leading/trailing spaces preserved vs trimmed)

### 2.3 `transform:combine_columns` - ❌ NO TEST
- **Risk**: HIGH (Tier 3, has custom parameters)
- **Location**: `src/lib/commands/transform/tier3/combine-columns.ts`
- **Required Tests**:
  - Basic column combination with delimiter
  - Undo/redo functionality (Tier 3 snapshot)
  - Parameter preservation through timeline replay (per CLAUDE.md 5.5)
  - Audit drill-down showing combined values

---

## 3. Feature/Module Coverage Analysis

| Feature | Status | Test Files |
|---------|--------|------------|
| **Clean (Laundromat)** | ✅ Covered | transformations.spec.ts, feature-coverage.spec.ts |
| **Match (Fuzzy Matcher)** | ✅ Covered | feature-coverage.spec.ts (FR-C1) |
| **Combine (Stack/Join)** | ✅ Covered | feature-coverage.spec.ts (FR-E1/E2), combiner-csid.spec.ts |
| **Scrub (Obfuscation)** | ✅ Covered | feature-coverage.spec.ts (FR-D2) |
| **Diff** | ✅ Covered | regression-diff.spec.ts, diff-filtering.spec.ts |
| **Audit Log** | ✅ Covered | audit-details.spec.ts, audit-undo-regression.spec.ts |
| **Value Standardization** | ✅ Covered | value-standardization.spec.ts |
| **Filter/Sort** | ✅ Covered | filter-sort.spec.ts |
| **Persistence** | ✅ Covered | persistence.spec.ts, opfs-persistence.spec.ts |
| **Ingestion Wizard** | ✅ Covered | feature-coverage.spec.ts (FR-A6), file-upload.spec.ts |
| **Manual Cell Editing** | ✅ Covered | feature-coverage.spec.ts (FR-A4) |
| **Undo/Redo Timeline** | ✅ Covered | audit-undo-regression.spec.ts, tier-3-undo-param-preservation.spec.ts |

---

## 4. Store Coverage Analysis

| Store | Purpose | E2E Coverage |
|-------|---------|--------------|
| `tableStore` | Table metadata & data | ✅ Covered (all table operations) |
| `auditStore` | Audit log entries | ✅ Covered (audit-details.spec.ts) |
| `editStore` | Cell edit tracking | ✅ Covered (FR-A4 tests) |
| `editBatchStore` | Batch edit state | ✅ Covered (audit-details.spec.ts) |
| `timelineStore` | Undo/redo history | ✅ Covered (audit-undo-regression.spec.ts) |
| `diffStore` | Diff view state | ✅ Covered (regression-diff.spec.ts) |
| `uiStore` | UI state (panels, dirty) | ⚠️ Partial (tested indirectly) |
| `combinerStore` | Combine panel state | ✅ Covered (FR-E1/E2) |
| `matcherStore` | Fuzzy matcher state | ✅ Covered (FR-C1) |
| `scrubberStore` | Scrubber panel state | ✅ Covered (FR-D2) |
| `standardizerStore` | Value standardization | ✅ Covered (value-standardization.spec.ts) |
| `previewStore` | Grid preview state | ⚠️ Partial (used in transform tests) |

---

## 5. Undo/Redo Coverage by Tier

| Tier | Mechanism | Tested? | Notes |
|------|-----------|---------|-------|
| **Tier 1** | Expression chaining | ✅ | audit-undo-regression.spec.ts tests chain undo |
| **Tier 2** | Inverse SQL | ✅ | FR-A4 tests cell edit undo |
| **Tier 3** | Snapshot restore | ✅ | tier-3-undo-param-preservation.spec.ts |

---

## 6. Parameter Preservation Tests

Per CLAUDE.md 5.5/5.6, commands with custom parameters need replay testing:

| Command | Custom Params | Has Param Test? |
|---------|---------------|-----------------|
| `split_column` | delimiter | ❌ **MISSING** |
| `combine_columns` | delimiter, newColumnName | ❌ **MISSING** |
| `match:merge` | matchColumns, survivorStrategy | ⚠️ Partial |
| `replace` | find, replace | ⚠️ Partial |
| `pad_zeros` | length | ✅ tier-3-undo-param-preservation.spec.ts |
| `cast_type` | targetType | ⚠️ Not explicitly tested |
| `mask` | maskChar | ⚠️ Not explicitly tested |
| `hash` | algorithm | ⚠️ Not explicitly tested |

---

## 7. Identified Test Gaps (Priority Order)

### HIGH PRIORITY

1. **`transform:combine_columns`** - No E2E test exists
   - File: New test in feature-coverage.spec.ts
   - Tests needed: Basic combine, undo/redo, param preservation

2. **`transform:split_column` param preservation** - Missing replay test
   - File: tier-3-undo-param-preservation.spec.ts
   - Test: Verify delimiter preserved through Tier 3 undo

### MEDIUM PRIORITY

3. **`transform:sentence_case`** - No E2E test exists
   - File: transformations.spec.ts or feature-coverage.spec.ts

4. **`transform:collapse_spaces`** - No E2E test exists
   - File: transformations.spec.ts or feature-coverage.spec.ts

5. **`match:merge` param preservation** - Verify survivorStrategy preserved
   - File: tier-3-undo-param-preservation.spec.ts

### LOW PRIORITY

6. **`cast_type` param preservation** - targetType through replay
7. **`hash`/`mask` param preservation** - algorithm/maskChar through replay

---

## 8. Test Infrastructure Gaps

| Area | Status | Notes |
|------|--------|-------|
| Flakiness monitoring | ✅ | `npm run test:analyze` |
| Memory monitoring | ✅ | `helpers/memory-monitor.ts` |
| Pattern detection | ✅ | `npm run test:lint-patterns` |
| Test fixtures | ✅ | Well-organized in `fixtures/csv/` |
| Page objects | ✅ | Complete set in `page-objects/` |
| Wait helpers | ✅ | Comprehensive in `helpers/` |

---

## 9. Recommendations

### Immediate Actions (Before Next Release)

1. **Add `combine_columns` E2E test** - This is a HIGH risk gap (Tier 3 with custom params)
2. **Add param preservation tests for `split_column`** - Listed in CLAUDE.md as HIGH risk

### Short-term (Next Sprint)

3. Add `sentence_case` and `collapse_spaces` basic tests
4. Add param preservation tests for `match:merge` survivorStrategy

### Ongoing

5. Continue using `npm run test:lint-patterns` before commits
6. Monitor flakiness with `npm run test:analyze`

---

## 10. Summary Statistics

| Metric | Value |
|--------|-------|
| Total Commands | 27 |
| Commands with E2E Tests | 24 (89%) |
| Commands Missing Tests | 3 (11%) |
| High Risk Gaps | 1 (`combine_columns`) |
| Medium Risk Gaps | 2 (`sentence_case`, `collapse_spaces`) |
| Param Preservation Gaps | 2 (`split_column`, `combine_columns`) |
