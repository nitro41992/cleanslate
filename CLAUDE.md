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
- **Zustand** - State management (7 stores)
- **Radix UI + Tailwind CSS** - UI components with dark mode
- **OPFS** - Origin Private File System for local persistence

### Core Modules (4 tabs)
| Module | Route | Purpose |
|--------|-------|---------|
| Data Laundromat | `/laundromat` | File ingestion, transformations, manual editing, audit log |
| Visual Diff | `/diff` | Compare tables with FULL OUTER JOIN reconciliation |
| Fuzzy Matcher | `/matcher` | Duplicate detection with blocking strategies |
| Smart Scrubber | `/scrubber` | Data obfuscation (hash, mask, redact, faker) |

### Directory Structure
```
src/
├── components/          # Reusable UI (common/, grid/, layout/, ui/)
├── features/            # Feature modules (laundromat/, diff/, matcher/, scrubber/)
├── lib/                 # Core business logic
│   ├── duckdb/          # DuckDB initialization & queries
│   ├── opfs/            # OPFS storage utilities
│   ├── transformations.ts
│   ├── diff-engine.ts
│   ├── fuzzy-matcher.ts
│   ├── obfuscation.ts
│   └── fileUtils.ts     # CSV parsing, encoding/delimiter detection
├── hooks/               # useDuckDB, usePersistence, useToast
├── stores/              # Zustand stores (table, audit, diff, matcher, scrubber, ui, edit)
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
- ✅ Trim Whitespace
- ✅ Uppercase
- ✅ Lowercase
- 🔲 Title Case (pending)
- 🔲 Remove Accents (pending)
- 🔲 Remove Non-Printable (pending)
- 🔲 Finance transforms: Unformat Currency, Fix Negatives, Pad Zeros (pending)
- 🔲 Date transforms: Standardize Format, Calculate Age (pending)
- 🔲 Split Column, Fill Down (pending)

### FR-A4: Manual Cell Editing ✅
- Double-click any cell to edit (Text/Number/Boolean)
- Red triangle indicator on edited cells (dirty state)
- Undo/Redo with Ctrl+Z / Ctrl+Y (10-step stack)
- Type B audit log entries with previous/new values

### FR-A5: Audit Log ✅
- Type A entries for bulk transformations (action, column, row count)
- Type B entries for manual edits (previous/new values)
- Immutable history with timestamps

### FR-A6: Ingestion Wizard ✅
- Modal triggered on CSV file drop
- Raw text preview (first 50 lines)
- Header row selection (rows 1-10)
- Encoding detection (UTF-8/Latin-1) with override
- Delimiter detection (Comma/Tab/Pipe/Semicolon) with override

### Module Pages (UI Shell)
- ✅ Visual Diff (`/diff`) - page loads, diff engine pending
- ✅ Fuzzy Matcher (`/matcher`) - page loads, matching logic pending
- ✅ Smart Scrubber (`/scrubber`) - page loads, obfuscation pending
- 🔲 Combiner (`/combiner`) - not yet implemented

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

## Important Notes

- Desktop-only application (MobileBlocker prevents mobile access)
- Dark mode enabled by default (`<html class="dark">`)
- DuckDB-WASM excluded from Vite optimization (see vite.config.ts)
- Service worker provides offline support in production
