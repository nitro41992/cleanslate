# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CleanSlate Pro is a browser-based, local-first data operations suite for regulated industries. It enables data cleaning, reconciliation, deduplication, and obfuscation entirely within the browser using DuckDB-WASM. Zero server uploads - all processing happens client-side.

**Requirements:** See `CleanSlate_PRD.md` for full product requirements, functional specs (FR-A through FR-E), and performance guardrails.

## Common Commands

```bash
npm run dev       # Start Vite dev server
npm run build     # TypeScript check + production build
npm run lint      # ESLint static analysis
npm run preview   # Preview production build locally
```

## Architecture

### Tech Stack
- **React 18 + TypeScript + Vite** - Frontend framework
- **DuckDB-WASM** - In-browser SQL engine (runs in Web Worker)
- **Glide Data Grid** - Canvas-based grid for 100k+ rows
- **Zustand** - State management (8 stores)
- **Radix UI + Tailwind CSS** - UI components with dark mode
- **OPFS** - Origin Private File System for local persistence

### Core Modules (Single-Page Architecture)
The app uses a single-page design with panel-based navigation (slide-in sheets from the right).

| Module | Toolbar Button | Purpose |
|--------|----------------|---------|
| Clean (Data Laundromat) | `toolbar-clean` | File ingestion, transformations, manual editing |
| Match (Fuzzy Matcher) | `toolbar-match` | Duplicate detection with blocking strategies |
| Combine | `toolbar-combine` | Stack (UNION ALL) and join tables |
| Scrub (Smart Scrubber) | `toolbar-scrub` | Data obfuscation (hash, mask, redact, faker) |
| Diff | `toolbar-diff` | Compare tables (overlay, not panel) |

**Sidebar:** Audit Log accessible via `toggle-audit-sidebar` button in header.

### Directory Structure
```
src/
├── components/          # Reusable UI (common/, grid/, layout/, ui/)
├── features/            # Feature modules (laundromat/, matcher/, combiner/, scrubber/, diff/)
├── lib/                 # Core business logic
│   ├── duckdb/          # DuckDB initialization & queries
│   ├── opfs/            # OPFS storage utilities
│   ├── transformations.ts
│   ├── diff-engine.ts
│   ├── combiner-engine.ts  # Stack/join table operations
│   ├── fuzzy-matcher.ts
│   ├── obfuscation.ts
│   └── fileUtils.ts     # CSV parsing, encoding/delimiter detection
├── hooks/               # useDuckDB, usePersistence, useToast
├── stores/              # Zustand stores (table, audit, diff, matcher, combiner, scrubber, ui, edit)
└── types/               # TypeScript interfaces
```

### Data Flow
```
File Upload → useDuckDB hook → DuckDB-WASM (Worker) → tableStore → DataGrid
                                    ↓
                            Transform/Diff/Match/Scrub
                                    ↓
                            auditStore (log changes) → Export CSV/OPFS persistence
```

### Key Patterns
- **Local-first**: All data processing happens in-browser via DuckDB SQL
- **Store-driven UI**: Zustand stores are single source of truth
- **Composable transforms**: Recipe builder chains SQL operations
- **Immutable audit trail**: Every action logged with timestamp and impact metrics
- **Web Crypto API**: SHA-256 hashing for obfuscation (no third-party crypto)

## TypeScript Configuration

- Strict mode enabled
- Path alias: `@/*` maps to `./src/*`
- Target: ES2020

## Implemented Features

### FR-A3: Text Cleaning Transformations (Partial)
**Implemented:**
- ✅ Trim Whitespace
- ✅ Uppercase
- ✅ Lowercase
- ✅ Find & Replace (case-sensitive/insensitive, exact/contains match)
- ✅ Remove Duplicates
- ✅ Filter Empty (remove rows with empty values, with audit drill-down)
- ✅ Rename Column
- ✅ Cast Type (String → Integer, Date)
- ✅ Custom SQL transformation
- ✅ Title Case
- ✅ Remove Accents (café → cafe)
- ✅ Remove Non-Printable (tabs, newlines, zero-width chars)
- ✅ Unformat Currency ($1,234.56 → 1234.56)
- ✅ Fix Negatives ((500.00) → -500.00)
- ✅ Pad Zeros (123 → 00123)
- ✅ Standardize Date (supports 10 date formats including YYYYMMDD, MM/DD/YYYY, etc.)
- ✅ Calculate Age (DOB → age in years, supports multiple date formats)
- ✅ Split Column (by delimiter)
- ✅ Fill Down (copy value from row above if null)

**All transformations have audit drill-down support** - click any audit entry to view row-level before/after values.

### FR-A4: Manual Cell Editing ✅
- Double-click any cell to edit (Text/Number/Boolean)
- Red triangle indicator on edited cells (dirty state)
- Undo/Redo with Ctrl+Z / Ctrl+Y (10-step stack)
- Type B audit log entries with previous/new values
- **Snapshot-based undo:** Uses intelligent snapshots to avoid replaying expensive operations (fast undo for filter_empty, remove_duplicates)

### FR-A5: Audit Log ✅
- Type A entries for bulk transformations (action, column, row count)
- Type B entries for manual edits (previous/new values)
- Row-level audit details stored in `_audit_details` table
- Modal viewer for row-level changes (click audit entry)
- Export row details as CSV from modal
- Export full audit log as TXT
- Immutable history with timestamps
- **Performance optimized:** Uses native `INSERT INTO SELECT` for ~10x faster audit capture on 100k+ rows
- **Filter Empty drill-down:** Shows deleted rows with `<deleted>` indicator

### FR-A6: Ingestion Wizard ✅
- Modal triggered on CSV file drop
- Raw text preview (first 50 lines)
- Header row selection (rows 1-10)
- Encoding detection (UTF-8/Latin-1) with override
- Delimiter detection (Comma/Tab/Pipe/Semicolon) with override

### FR-A7: Data Health Sidebar 🔲
- Not implemented (no tests written)

### FR-B2: Visual Diff ✅
- Compare two tables with FULL OUTER JOIN
- Detect added, removed, and modified rows
- Color-coded diff display (green/red/yellow)
- Compare with Preview mode (current table vs. original state)
- Compare Two Tables mode (select any two tables)
- **Optimized for 2M+ rows** with temp table + virtualized grid approach
- Streaming export for large datasets

### FR-B4: Blind Diff Support 🔲
- Not implemented (no tests written)

### FR-C1: Fuzzy Matcher ✅
- Panel UI with configuration options
- ✅ Chunked multi-pass fuzzy matching for scalability
- ✅ Blocking strategy (first letter, metaphone, n-gram)
- ✅ Similarity scoring with field-level breakdown
- ✅ Row selection UI with merge/keep separate actions
- ✅ Audit log drill-down for merge operations
- 🔲 Tinder-style review UI (FR-C2, partial - card UI exists)

### FR-D2: Smart Scrubber 🔲
- Panel UI loads
- 🔲 Hash columns (SHA-256) - TDD tests written
- 🔲 Redact PII patterns - TDD tests written
- 🔲 Mask partial values - TDD tests written
- 🔲 Year only from dates - TDD tests written
- 🔲 Project Secret/Salt (FR-D1, no tests)
- 🔲 Key Map Export (FR-D3, no tests)

### FR-E: Combiner ✅
- Stack tables (UNION ALL) with column alignment
- Join tables with Inner/Left join types
- Key column selection for joins
- Validation warnings for mismatched columns
- 🔲 Full Outer Join (not tested)
- 🔲 Clean-First Guardrail (FR-E3, no tests)

### FR-F: Value Standardization ✅
- Clustering algorithms (fingerprint, metaphone)
- Cluster list with bulk Select All / Deselect All controls
- Master value selection (auto-suggested from most frequent)
- Apply standardization to update values in-place
- Audit log integration

### Additional Features
- ✅ Persist as Table (create copy with new name)
- ✅ Export CSV
- ✅ Single-page panel-based UI (toolbar → slide-in sheets)
- ✅ Keyboard shortcuts (1-5 for panels, Escape to close)
- ✅ Original snapshot creation on manual edits (for diff comparison)

### Recent Fixes (Jan 2026)
**Audit Capture & Undo/Redo Improvements:**
1. **Date parsing consistency:** `standardize_date` and `calculate_age` audit capture now uses the same COALESCE pattern with 10 date formats as the actual transformation (fixes `<null>` values in audit details for dates like `20250704`)
2. **Performance optimization:** Replaced JS-based row fetching + batch inserts with native `INSERT INTO SELECT` (~10x faster for 100k+ rows)
3. **Filter Empty drill-down:** Added `filter_empty` case to `captureRowDetails()` - shows deleted rows with `<deleted>` indicator
4. **Undo replay fix:** Fixed snapshot indexing so undo doesn't replay previous expensive transformations (creates snapshot at `currentPosition` instead of `currentPosition + 1`)

## Implementation Status Summary

| Feature Area | Status | Passing Tests | TDD (Failing) | No Tests |
|--------------|--------|---------------|---------------|----------|
| FR-A3 Transformations | ✅ Complete | 13 | 0 | 0 |
| FR-A4 Manual Editing | ✅ Complete | 4 | 0 | 0 |
| FR-A5 Audit Log | ✅ Complete | 19 | 0 | 0 |
| FR-A6 Ingestion Wizard | ✅ Complete | 3 | 0 | 0 |
| FR-A7 Data Health | 🔲 Not Started | 0 | 0 | All |
| FR-B2 Visual Diff | ✅ Complete | 3 | 0 | 0 |
| FR-B4 Blind Diff | 🔲 Not Started | 0 | 0 | All |
| FR-C1 Fuzzy Matcher | ✅ Complete | 3 | 0 | 0 |
| FR-C2 Review UI | 🔶 Partial | 0 | 0 | All |
| FR-D1 Project Secret | 🔲 Not Started | 0 | 0 | All |
| FR-D2 Smart Scrubber | 🔲 Partial | 1 | 4 | 0 |
| FR-D3 Key Map Export | 🔲 Not Started | 0 | 0 | All |
| FR-E1 Stack Tables | ✅ Complete | 2 | 0 | 0 |
| FR-E2 Join Tables | ✅ Complete | 2 | 0 | 0 |
| FR-E3 Clean-First | 🔲 Not Started | 0 | 0 | All |
| FR-F Value Standardization | ✅ Complete | 0 | 0 | All |

**Totals:** ~90 passing, ~4 TDD failing (expected), multiple features with no test coverage

### Pending Features (TDD Tests Written)

These features have failing tests that document expected behavior:

**FR-D2 Smart Scrubber:**
- SHA-256 hash columns
- Redact PII patterns
- Mask partial values
- Year-only date extraction

### Missing Test Coverage

These features have no E2E tests written:

| Feature | Priority | Complexity |
|---------|----------|------------|
| FR-A7 Data Health Sidebar | Medium | Low |
| FR-B4 Blind Diff Support | Low | Medium |
| FR-C2 Tinder-style Review | Low | Medium |
| FR-D1 Project Secret/Salt | High | Low |
| FR-D3 Key Map Export | Medium | Medium |
| FR-E3 Clean-First Guardrail | Low | Low |
| FR-F Value Standardization | Medium | Low |

### Recommended Tests to Add

**Priority 1 (High Impact, Low Effort):**
1. FR-D1 Project Secret - Test salt persistence and hash consistency
2. FR-A7 Data Health - Test column stats display (nulls, uniques)
3. FR-E3 Clean-First - Test warning when combining uncleaned tables

**Priority 2 (Medium Impact):**
4. FR-D3 Key Map Export - Test CSV export of hash→original mappings
5. FR-B4 Blind Diff - Test column-name-agnostic comparison

**Priority 3 (Higher Complexity):**
6. FR-C2 Review UI - Test swipe/approve/reject workflow

## E2E Testing

```bash
npm test                           # Run all Playwright E2E tests
npm test -- --grep "FR-A4"         # Run specific feature tests
npm test -- --ui                   # Open Playwright UI mode
```

### Test Architecture: Serial Groups for DuckDB-WASM

DuckDB-WASM has a 2-10 second cold start per page context. Tests use `test.describe.serial` with shared page contexts to initialize DuckDB once per group, reducing total init overhead from minutes to seconds.

**Configuration** (`playwright.config.ts`):
- `fullyParallel: true` - Serial groups run in parallel across workers
- `workers: '50%'` (local) / `4` (CI) - Parallel execution of serial groups

### SOP: Creating New Tests

#### 1. Choose the Right Test File
| Test Type | File | When to Use |
|-----------|------|-------------|
| Feature coverage (PRD) | `feature-coverage.spec.ts` | Testing FR-* requirements |
| Transformation logic | `transformations.spec.ts` | Data transformation tests |
| File upload/ingestion | `file-upload.spec.ts` | CSV import tests |
| Full user workflows | `e2e-flow.spec.ts` | End-to-end scenarios |
| Export functionality | `export.spec.ts` | CSV export tests |

#### 2. Add Test to Existing Serial Group (Preferred)
Find a related `test.describe.serial` block and add your test:

```typescript
test.describe.serial('FR-A3: Text Cleaning Transformations', () => {
  // Shared context - DuckDB initialized once in beforeAll
  let page: Page
  let laundromat: LaundromatPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()  // Only once per group!
  })

  test.afterAll(async () => {
    await page.close()
  })

  // Helper to reset data between tests that modify state
  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS my_table')
    await laundromat.uploadFile(getFixturePath('my-fixture.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('my_table', expectedRows)
  }

  // Your new test
  test('should do something', async () => {
    await loadTestData()
    // ... test implementation
  })
})
```

#### 3. Create New Serial Group (When Needed)
Create a new group when:
- Testing a different feature area (new FR-* section)
- Tests require different page routes (e.g., `/matcher` vs `/laundromat`)
- Tests need different fixture files

```typescript
test.describe.serial('FR-X: New Feature', () => {
  let page: Page
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await page.goto('/route')
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  // Tests here share the same page context
})
```

### SOP: TDD for Unimplemented Features

#### 1. Write Failing Test First
```typescript
test('should implement new transformation', async () => {
  // Mark as expected to fail
  test.fail()

  await loadTestData()

  // Fail-fast guard: Check UI element exists (fails quickly if not)
  await expect(page.getByRole('option', { name: 'New Transform' }))
    .toBeVisible({ timeout: 1000 })

  // Full test implementation
  await picker.addTransformation('New Transform', { column: 'data' })
  await laundromat.clickRunRecipe()

  const data = await inspector.getTableData('my_table')
  expect(data[0].data).toBe('expected_value')
})
```

#### 2. Implement the Feature
Write the actual feature code in `src/`.

#### 3. Remove `test.fail()` and Verify
```typescript
test('should implement new transformation', async () => {
  // test.fail() removed - test should now pass
  await loadTestData()
  // ... rest of test
})
```

### Test Helpers

| Helper | Location | Purpose |
|--------|----------|---------|
| `StoreInspector` | `e2e/helpers/store-inspector.ts` | Access Zustand stores, run DuckDB queries |
| `LaundromatPage` | `e2e/page-objects/laundromat.page.ts` | Laundromat UI interactions |
| `IngestionWizardPage` | `e2e/page-objects/ingestion-wizard.page.ts` | CSV import wizard |
| `TransformationPickerPage` | `e2e/page-objects/transformation-picker.page.ts` | Transform selection |
| `getFixturePath()` | `e2e/helpers/file-upload.ts` | Get path to CSV fixtures |
| `SerialTestContext` | `e2e/helpers/serial-setup.ts` | Shared context interface |

### Key StoreInspector Methods
```typescript
await inspector.waitForDuckDBReady()           // Wait for DuckDB init
await inspector.waitForTableLoaded(name, rows) // Wait for table
await inspector.getTableData(name)             // Get all rows as objects
await inspector.getTables()                    // List all tables
await inspector.runQuery(sql)                  // Execute SQL
await inspector.getAuditEntries()              // Get audit log
```

### Common Patterns

**Reset table between tests:**
```typescript
await inspector.runQuery('DROP TABLE IF EXISTS table_name')
```

**Dismiss overlays before UI interaction:**
```typescript
await laundromat.dismissOverlays()  // Called automatically by clickAddTransformation()
```

**Navigate without re-waiting for DuckDB:**
```typescript
await laundromat.goto()
await page.waitForLoadState('networkidle')  // DuckDB already initialized
```

### Test Fixtures
Located in `e2e/fixtures/csv/`:
- `basic-data.csv` - Simple 5-row dataset
- `whitespace-data.csv` - Data with leading/trailing spaces
- `mixed-case.csv` - Mixed case text for case transformations
- `with-duplicates.csv` - Data with duplicate rows
- `fr_a3_*.csv` - FR-A3 transformation test fixtures
- `fr_b2_*.csv` - Visual Diff test fixtures
- `fr_e1_*.csv` - Combiner Stack test fixtures (jan/feb sales)
- `fr_e2_*.csv` - Combiner Join test fixtures (orders/customers)

## Important Notes

- Desktop-only application (MobileBlocker prevents mobile access)
- Dark mode enabled by default (`<html class="dark">`)
- DuckDB-WASM excluded from Vite optimization (see vite.config.ts)
- Service worker provides offline support in production
