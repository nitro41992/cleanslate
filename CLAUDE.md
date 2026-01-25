# CLAUDE.md

## 1. Project Overview

CleanSlate Pro is a browser-based, local-first data operations suite for regulated industries. All processing happens client-side via DuckDB-WASM. See `CleanSlate_PRD.md` for full requirements (FR-A through FR-E).

## 2. Rules (Strict)

- **MUST** push the plan file with your commits
- **MUST NOT** create `.md` files in root folder unless explicitly asked
- **MUST NOT** use tools like `sed` — use Edit tool or TypeScript LSP
- **MUST** ensure E2E tests pass; if failing, work with me to determine if issue is implementation or test intent
- **MUST NOT** add new logic to `transformations.ts` [DEPRECATED] — use `src/lib/commands/` instead

## 3. Common Commands

```bash
# Development
npm run dev           # Start Vite dev server
npm run build         # TypeScript check + production build
npm run lint          # ESLint static analysis
npm run preview       # Preview production build locally

# Testing
npm run test          # Run all Playwright E2E tests
npm run test:ui       # Run tests with Playwright UI
npm run test:headed   # Run tests in headed browser mode
```

## 4. Architecture

### Tech Stack
- **React 18 + TypeScript + Vite** — Frontend framework
- **DuckDB-WASM** — In-browser SQL engine (Web Worker)
- **Glide Data Grid** — Canvas-based grid for 100k+ rows
- **Zustand** — State management (8 stores)
- **Radix UI + Tailwind CSS** — UI components with dark mode
- **OPFS** — Origin Private File System for local persistence

### Core Modules

| Module | Route | Store | Purpose |
|--------|-------|-------|---------|
| Clean (Laundromat) | `/` | `tableStore` | File ingestion, transformations, editing |
| Match (Fuzzy Matcher) | `/` (panel) | `matcherStore` | Duplicate detection with blocking |
| Combine | `/` (panel) | `combinerStore` | Stack (UNION ALL) and join tables |
| Scrub (Smart Scrubber) | `/` (panel) | `scrubberStore` | Obfuscation (hash, mask, redact, faker) |
| Diff | `/` (overlay) | `diffStore` | Compare tables side-by-side |
| Audit Log | sidebar | `auditStore` | Timeline of all operations |

### Directory Structure
```
src/
├── components/       # Reusable UI (common/, grid/, layout/, ui/)
├── features/         # Feature modules (laundromat/, matcher/, combiner/, scrubber/, diff/)
├── lib/
│   ├── commands/     # Command Pattern implementation
│   ├── duckdb/       # DuckDB initialization & queries
│   ├── opfs/         # OPFS storage utilities
│   └── transformations.ts  # [DEPRECATED] — being migrated to commands/
├── hooks/            # useDuckDB, usePersistence, useToast
├── stores/           # Zustand stores
└── types/            # TypeScript interfaces
```

### Data Flow
```
File Upload → DuckDB-WASM → tableStore → DataGrid
                  ↓
            CommandExecutor (validate → execute → audit → timeline)
                  ↓
            auditStore → Export CSV / OPFS persistence
```

### Command Pattern

All data mutations go through the Command Pattern for automatic undo/redo and audit logging.

**Three-Tier Undo Strategy:**
| Tier | Mechanism | Speed | Examples |
|------|-----------|-------|----------|
| 1 | Expression chaining | Instant | trim, lowercase, uppercase, replace, hash, mask |
| 2 | Inverse SQL | Fast | rename_column, edit:cell, combine:stack/join |
| 3 | Snapshot restore | Slower | remove_duplicates, cast_type, split_column, match:merge |

**Usage:**
```typescript
import { createCommand, getCommandExecutor } from '@/lib/commands'

const command = createCommand('transform:trim', { tableId, column: 'email' })
await getCommandExecutor().execute(command)

// Undo/Redo
if (executor.canUndo(tableId)) await executor.undo(tableId)
```

## 5. Engineering Directives

### 5.1 Golden Rule: "If it Mutates, It's a Command"

Any action that changes data state MUST be a Command implementing the `Command` interface. This guarantees Undo/Redo, Audit Logging, and Reproducibility via `CommandExecutor`.

**Violation:** Calling `duckDB.conn.query(...)` directly from a React component or Zustand store.

### 5.2 Strangler Fig Strategy [DEPRECATED: transformations.ts]

`src/lib/transformations.ts` is technical debt being eliminated.

- **New features:** MUST go into `src/lib/commands/` or utility libraries
- **Bug fixes:** Extract function → refactor to pure → import back or use in Command directly

### 5.3 Dependency Hierarchy

| Level | Layer | Description |
|-------|-------|-------------|
| 1 | `src/lib/duckdb` | Database engine — knows nothing about UI |
| 2 | `src/lib/commands` | Business logic — depends only on Level 1 |
| 3 | `src/stores` | UI state — delegates to Level 2 |
| 4 | `src/components` | Visuals — triggers actions in Level 3 |

**Critical:** Level 2 MUST NEVER import from Level 3 or 4.

### 5.4 State Management Hygiene

- **Data State:** Lives in DuckDB, accessed via Commands
- **UI State:** Lives in Zustand stores (`isLoading`, `selectedColumn`, `previewRows`)
- **Anti-Pattern:** Loading 100k rows into a Zustand store array

### Code Review Checklist

- [ ] No new logic in `transformations.ts`?
- [ ] Data mutation = Command?
- [ ] Dependencies flow downward only?
- [ ] Regression test included?

## 6. E2E Testing Guidelines

See @e2e/CLAUDE.md for detailed patterns, helpers, and fixtures.

**Core Rules:**
- **"Clean Slate" Rule:** Every test creates its own state — never rely on previous tests
- **"No Sleep" Rule:** FORBIDDEN: `await page.waitForTimeout(N)` — use `waitForDuckDBReady()`, `waitForTableLoaded()`, or `expect(locator).toBeVisible()` instead
- **Assert Identity:** `expect(rows.map(r => r.id)).toEqual([1, 3, 5])` not `expect(rows.length).toBe(3)`
- **Serial Groups:** Use `test.describe.serial` to share page context (DuckDB has 2-10s cold start)

## 7. Gotchas & Context

- **DuckDB Async:** All DuckDB operations are async. Always `await` and use `waitForDuckDBReady()` in tests
- **Mobile Blocker:** Desktop-only app — `MobileBlocker` component prevents mobile access
- **Vite Config:** DuckDB-WASM excluded from optimization (see `vite.config.ts`)
- **Route Navigation:** All modules are on `/` with panel-based navigation (no separate routes)
- **Dark Mode:** Enabled by default (`<html class="dark">`)
- **TypeScript:** Strict mode, path alias `@/*` → `./src/*`, target ES2020
