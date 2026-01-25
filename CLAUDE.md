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

## Rules to Follow
### General
- **Always push the plan with your commits**
- **Dont create .md files in the root folder unless ecplicitly asked to.**
- **If you are creating E2E Tests, make sure they are passing tests. If not, work with me to figure out if the issue is the implementation or the intent of the test itself.**

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
│   ├── commands/        # Command Pattern (executor, registry, transform/, edit/, etc.)
│   ├── duckdb/          # DuckDB initialization & queries
│   ├── opfs/            # OPFS storage utilities
│   ├── transformations.ts  # Legacy (being migrated to commands/)
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
File Upload → DuckDB-WASM → tableStore → DataGrid
                  ↓
            CommandExecutor
            (validate → execute → audit → timeline)
                  ↓
            auditStore → Export CSV/OPFS persistence
```

### Key Patterns
- **Local-first**: All data processing happens in-browser via DuckDB SQL
- **Store-driven UI**: Zustand stores are single source of truth
- **Command pattern**: Unified `CommandExecutor` for all data operations with automatic undo/audit
- **Immutable audit trail**: Every action logged with timestamp and impact metrics
- **Web Crypto API**: SHA-256 hashing for obfuscation (no third-party crypto)

### Command Pattern Architecture

CleanSlate Pro uses a unified Command Pattern for all data operations:

**Core Concepts:**
- **Declarative commands** via typed `Command<TParams>` interface
- **Automatic audit logging** with row-level drill-down
- **Three-tier undo strategy** (Tier 1: instant, Tier 2: inverse SQL, Tier 3: snapshot)
- **Diff views** for highlighting affected rows in the grid

**Command Directory Structure:**
```
src/lib/commands/
├── index.ts              # Public API + command registration
├── executor.ts           # CommandExecutor singleton (8-step lifecycle)
├── registry.ts           # Factory pattern, tier classification
├── types.ts              # Core types (Command, CommandContext, etc.)
├── context.ts            # Context builder, column version state
├── column-versions.ts    # Tier 1 expression chaining manager
├── diff-views.ts         # Diff view creation (v_diff_step_X)
├── transform/            # 22 transform commands (tier1/, tier2/, tier3/)
├── edit/                 # EditCellCommand (Tier 2)
├── match/                # MatchMergeCommand (Tier 3)
├── combine/              # Stack/Join commands (Tier 2)
├── standardize/          # StandardizeApplyCommand (Tier 3)
├── scrub/                # Hash/Mask/Redact/YearOnly (Tier 1-3)
└── utils/                # SQL helpers, date parsing
```

**Three-Tier Undo Strategy:**
| Tier | Mechanism | Speed | Commands |
|------|-----------|-------|----------|
| **1** | Expression chaining | Instant | trim, lowercase, uppercase, replace, hash, mask (12 total) |
| **2** | Inverse SQL | Fast | rename_column, edit:cell, combine:stack/join (5 total) |
| **3** | Snapshot restore | Slower | remove_duplicates, cast_type, split_column, standardize:apply, match:merge (15 total) |

**Usage Pattern:**
```typescript
import { createCommand, getCommandExecutor } from '@/lib/commands'

const command = createCommand('transform:trim', { tableId, column: 'email' })
const result = await getCommandExecutor().execute(command)

// Undo/Redo
if (executor.canUndo(tableId)) await executor.undo(tableId)
if (executor.canRedo(tableId)) await executor.redo(tableId)
```

**Key Files:**
- `executor.ts` - Central orchestrator (validate → snapshot → execute → diff → audit → timeline)
- `column-versions.ts` - Tier 1 expression chaining with `__base` backup columns
- `registry.ts` - Maps command types to tier classification

**Performance Optimizations (Phase 6):**
- Snapshot pruning: Max 5 Tier 3 snapshots per table (LRU eviction)
- Column materialization: After 10 Tier 1 transforms, materialize expression stack
- `__base` columns filtered from UI/export via `filterInternalColumns()`

## Engineering Directive: Architecture Standards

> "We are building a professional-grade data engine. Complexity belongs in the Command layer, not the React components. Our goal is that in 3 months, transformations.ts will be empty and deleted. Every line of code you write should move us closer to that goal."

### 1. The Golden Rule: "If it Mutates, It's a Command"

**Principle:** We have moved away from ad-hoc data manipulation in UI handlers or service files.

**Guideline:** Any action that changes the state of the data (Clean, Scrub, Combine, Match) must be encapsulated in a Command class implementing the Command interface.

**Why:** This guarantees we get Undo/Redo, Audit Logging, and Reproducibility "for free" via the CommandExecutor.

**Violation:** Calling `duckDB.conn.query(...)` directly from a React component or a Zustand store action.

### 2. The "Strangler Fig" Strategy for Legacy Code

**Context:** `src/lib/transformations.ts` is our "God Object." It is technical debt.

**Principle:** Do not feed the beast. Starve it.

**Rule A (New Features):** Absolutely NO new code goes into `transformations.ts`. New logic goes into `src/lib/commands/` or specific utility libraries (e.g., `src/lib/audit-utils.ts`).

**Rule B (The Boy Scout Rule):** If you are fixing a bug in `transformations.ts`:
1. Extract the specific function you are fixing into a separate file.
2. Refactor it to be pure (independent of the massive class).
3. Import that new function back into `transformations.ts` (as a temporary bridge) or better yet, update the Command to use the new file directly.

### 3. The Dependency Hierarchy

Strictly enforce the direction of dependencies to prevent circular references and spaghetti code.

| Level | Layer | Description |
|-------|-------|-------------|
| **1 (Core)** | `src/lib/duckdb` | The Database Engine - Knows nothing about UI or Commands |
| **2 (Business Logic)** | `src/lib/commands` | Depends on Level 1. Contains the "How" |
| **3 (Orchestration)** | `src/lib/commands/executor.ts` & `registry.ts` | Connects Commands to the Application |
| **4 (UI State)** | `src/stores` | Manages UI state, delegates data heavy-lifting to Level 3 |
| **5 (Components)** | `src/components` | Visuals only. Triggers actions in Level 4 |

**Critical Check:** A file in Level 2 should NEVER import from Level 4 or 5.

### 4. State Management Hygiene

**Principle:** Distinguish between Data State and UI State.

**Data State (DuckDB):**
- Where it lives: Inside DuckDB WASM
- Access: Async queries via Commands
- **Anti-Pattern:** Loading 100k rows into a Zustand store array

**UI State (Zustand):**
- Where it lives: `src/stores/*`
- What it holds: `isLoading`, `currentView`, `selectedColumn`, `previewRows` (small subset)

### 5. The Command Anatomy Checklist

When reviewing a new Command, ensure it follows this structure:

- [ ] **Metadata:** Does it have a unique `id` and descriptive metadata?
- [ ] **Schema Validation:** Are the params strongly typed and validated?
- [ ] **Audit Strategy:** Does it explicitly return `rowsAffected` and `auditEntryId`?
- [ ] **Tier 1 (SQL-only):** Use `column__base` versioning
- [ ] **Tier 2/3 (Complex):** Ensure snapshotting logic is decoupled from the execute method
- [ ] **Inversion of Control:** The Command receives dependencies via `execute(ctx)`, not global singletons

### 6. Testing Strategy: "Regression-First"

Since we are refactoring, we are prone to breaking existing functionality.

**Requirement:** Every new feature or bug fix must include an E2E Test (Playwright) in `e2e/tests/`.

**Focus:** Test the outcome (Data changed, Audit log appeared), not the implementation details.

**Legacy Tests:** If `transformations.ts` has unit tests, they must be migrated to the new Command structure when logic is extracted.

### Code Review Checklist

- [ ] No new logic in `transformations.ts`?
- [ ] Is it a Command? (If it writes data)
- [ ] Are dependencies correct? (No UI imports in backend logic)
- [ ] Are UI stores free of massive data arrays?
- [ ] Is there a regression test?

## Engineering Standard: High-Fidelity Testing

**Effective Date:** Immediate

We are moving away from "Smoke Tests" (checking if things crash) to "Integrity Tests" (checking if logic is correct). Moving forward, Playwright tests must abide by these three rules.

### Rule 1: Assert Identity, Not Just Cardinality

Do not rely on counts (`rowCount`, `clusters.length`) as your primary success metric. A count can be correct even if the data is wrong.

**Bad (Lazy):** "There are now 3 rows."

**Good (High-Fidelity):** "The remaining rows are IDs 1, 3, and 5."

### Rule 2: Assert Exact States, Avoid `not.toEqual`

Negative assertions (`not.toBe`, `not.toEqual`) are loopholes. They pass on accidents (e.g., data becoming `null` or `undefined`).

**Bad (Lazy):** `expect(valueAfterUndo).not.toBe(valueBeforeUndo)`

**Good (High-Fidelity):** `expect(valueAfterUndo).toBe('Original Value')`

### Rule 3: Visual Validation Requires CSS/DOM Checks

If a feature is visual (like Highlighting or Diffing), checking that a button exists is insufficient. You must assert the visual state change in the DOM.

**Bad (Lazy):** Clicking "Highlight" shows the "Clear" button.

**Good (High-Fidelity):** Clicking "Highlight" adds the `.bg-yellow-500` class to the specific cells in the Grid DOM.

### Implementation Checklist for PRs

Before submitting a PR, ask:

1. If I replaced the transformation logic with `return []` (empty array), would this test fail?
2. If I replaced the UI highlight logic with `console.log("highlighting")`, would this test fail?

**If the answer is NO, the test is lazy. Fix it.**

## TypeScript Configuration

- Strict mode enabled
- Path alias: `@/*` maps to `./src/*`
- Target: ES2020


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
