# CLAUDE.md

## 1. Project Overview

CleanSlate Pro is a browser-based, local-first data operations suite for regulated industries. All processing happens client-side via DuckDB-WASM. See `CleanSlate_PRD.md` for full requirements (FR-A through FR-E).

## 2. Rules (Strict)

- **MUST** push the plan file with your commits
- **MUST NOT** create `.md` files in root folder unless explicitly asked
- **MUST NOT** use tools like `sed`, `cat` or `awk` — use Edit, Read, Update or Find tools or TypeScript LSP
- **MUST** ensure E2E tests pass; if failing, work with me to determine if issue is implementation or test intent
- **MUST NOT** add new logic to `transformations.ts` [DEPRECATED] — use `src/lib/commands/` instead
- **MUST** use shadcn components when applicable before falling back to custom components

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
- **Zustand** — State management (12 stores)
- **Radix UI + Tailwind CSS** — UI components with dark mode
- **OPFS** — Origin Private File System for local persistence

### Core Modules

| Module | Route | Store | Purpose |
|--------|-------|-------|---------|
| Clean (Laundromat) | `/` | `tableStore` | File ingestion, transformations, editing |
| Match (Fuzzy Matcher) | `/` (panel) | `matcherStore` | Duplicate detection with blocking |
| Combine | `/` (panel) | `combinerStore` | Stack (UNION ALL) and join tables |
| Scrub (Smart Scrubber) | `/` (panel) | `scrubberStore` | Obfuscation (hash, mask, redact, faker) |
| Standardize | `/` (panel) | `standardizerStore` | Format standardization (dates, phones, addresses) |
| Diff | `/` (overlay) | `diffStore` | Compare tables side-by-side |
| Audit Log | sidebar | `auditStore` | Timeline of all operations |

### Directory Structure
```
src/
├── components/       # Reusable UI (common/, grid/, layout/, ui/, panels/, clean/, diff/, scrub/)
├── features/         # Feature modules (combiner/, matcher/, scrubber/, standardizer/, diff/)
├── lib/
│   ├── commands/     # Command Pattern (transform/, edit/, data/, schema/, combine/, match/, scrub/, standardize/)
│   ├── duckdb/       # DuckDB initialization & queries
│   ├── opfs/         # OPFS storage utilities
│   ├── persistence/  # State persistence
│   ├── validation/   # Semantic validation rules
│   ├── memory-manager.ts  # Browser memory monitoring
│   ├── idle-detector.ts   # User idle detection
│   └── transformations.ts  # [DEPRECATED] — being migrated to commands/
├── hooks/            # useDuckDB, usePersistence, useSemanticValidation, useUnifiedUndo
├── stores/           # Zustand stores (12 total)
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
| 2 | Inverse SQL | Fast | rename_column, edit:cell, combine:stack/join, data:insert_row, data:delete_row, schema:add_column, schema:delete_column |
| 3 | Snapshot restore | Slower | remove_duplicates, cast_type, split_column, match:merge |

**Usage:**
```typescript
import { createCommand, getCommandExecutor } from '@/lib/commands'

const command = createCommand('transform:trim', { tableId, column: 'email' })
await getCommandExecutor().execute(command)

// Undo/Redo
if (executor.canUndo(tableId)) await executor.undo(tableId)
```

### Persistence Architecture

Data persists across browser refreshes via a **dual-layer** OPFS storage system:

| Layer | Storage | Format | Purpose |
|-------|---------|--------|---------|
| Data | `cleanslate/snapshots/` | Parquet | Table rows (chunked for >250k rows) |
| App State | `cleanslate/app-state.json` | JSON | Metadata, timelines, UI prefs |

**Key Files:**
| File | Purpose |
|------|---------|
| `src/lib/persistence/state-persistence.ts` | App-level JSON state (save/restore) |
| `src/lib/opfs/snapshot-storage.ts` | Parquet I/O with chunking & cleanup |
| `src/hooks/usePersistence.ts` | Lifecycle hook (hydration, auto-save) |

**Restoration Flow (Page Load):**
```
initDuckDB() → cleanupCorruptSnapshots() → restoreAppState()
     ↓
usePersistence: listParquetSnapshots() → importTableFromParquet() → addTable()
     ↓
setIsReady(true) → render grid
```

**Save Mechanisms:**
- **Adaptive debounce:** 2s default, 3s for >100k rows, 5s for >500k, 10s for >1M
- **Save queue coalescing:** Prevents concurrent exports for same table
- **Chunked exports:** Tables >250k rows split into ~50MB Parquet chunks
- **Corrupt file cleanup:** Deletes <200 byte broken files on startup

**Dirty State Tracking (`useUIStore`):**
- `dirtyTables: Set<string>` — Tables with unsaved changes
- `persistenceStatus: 'idle' | 'dirty' | 'saving' | 'error'`
- UI shows amber pulse → spinner → green checkmark

**OPFS Layout:**
```
cleanslate/
├── app-state.json
└── snapshots/
    ├── table_name.parquet (or _part_N.parquet for chunked)
    └── snapshot_timeline_*.parquet (undo snapshots)
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

### 5.5 Dual-Timeline Parameter Contract

Commands flow through two timeline systems that MUST stay synchronized:

```
CommandExecutor.execute()
        ↓
syncExecuteToTimelineStore()  ← Params MUST be properly nested here
        ↓
timelineStore.appendCommand()
        ↓
timeline-engine.applyTransformCommand()  ← Reads params.params for replay
```

**The Problem:** Commands have params like `{ tableId, column, length, delimiter }`. When syncing to `timelineStore`, custom params (`length`, `delimiter`) must be nested in `params.params` for replay to work correctly.

**The Solution:** Use `extractCustomParams()` from `src/lib/commands/utils/param-extraction.ts`:

```typescript
import { extractCustomParams } from './utils/param-extraction'

// In syncExecuteToTimelineStore:
const customParams = extractCustomParams(command.params)

timelineParams = {
  type: 'transform',
  transformationType: '...',
  column,
  params: customParams,  // CRITICAL: Nested for replay
}
```

**Vulnerable Commands:** Commands with custom parameters that can lose values on replay:

| Risk | Commands | Custom Params |
|------|----------|---------------|
| High | `split_column`, `combine_columns`, `match:merge` | delimiter, newColumnName, pairs |
| Medium | `replace`, `pad_zeros`, `cast_type`, `mask`, `hash` | find/replace, length, targetType |
| Lower | `replace_empty`, `custom_sql`, `calculate_age`, `fill_down` | replacement, sql, referenceDate |

### 5.6 New Command Checklist

When adding a new command with custom parameters:

1. **Define params interface** in command file with explicit types
2. **Use `extractCustomParams()`** in executor if command has non-base params
3. **Verify replay** works by running:
   - Apply transform with non-default params
   - Apply unrelated Tier 3 transform
   - Undo the Tier 3 transform
   - Verify original transform still uses correct params
4. **Add E2E test** in `tier-3-undo-param-preservation.spec.ts`
5. **Update `COMMANDS_WITH_CUSTOM_PARAMS`** in `param-extraction.ts`

### 5.7 Code Review Checklist

- [ ] No new logic in `transformations.ts`?
- [ ] Data mutation = Command?
- [ ] Dependencies flow downward only?
- [ ] Regression test included?
- [ ] **Custom params preserved?** (If command has non-base params, verify they're in `COMMANDS_WITH_CUSTOM_PARAMS` and tested)

### 5.8 Memory Management

Browser memory is finite. Use `src/lib/memory-manager.ts` patterns:

**Memory Health Levels:**
| Level | Threshold | Action |
|-------|-----------|--------|
| HEALTHY | <1GB | Normal operation |
| SOFT | 1GB | Log warning, prepare for cleanup |
| WARNING | 1.5GB | Trigger cache cleanup callbacks |
| CRITICAL | 2.5GB | Aggressive cleanup, warn user |
| DANGER | 3.5GB | Emergency cleanup, block new operations |

**Cleanup Pattern:**
```typescript
import { registerCleanupCallback } from '@/lib/memory-manager'

// Register cache cleanup during memory pressure
registerCleanupCallback(() => {
  myCache.clear()
  return Promise.resolve()
})
```

**Memory Leak Detection:** Sustained growth >50MB/min over 5+ minutes indicates a leak.

### 5.9 Batch Processing Pattern

For large datasets, use OFFSET-based batching with deterministic ordering:

```typescript
// ✅ Good: Deterministic batching with staging table
const BATCH_SIZE = 10000
let offset = 0

// Create staging table for atomic operation
await conn.query(`CREATE TABLE staging_${tableId} AS SELECT * FROM ${tableName} WHERE false`)

while (offset < totalRows) {
  await conn.query(`
    INSERT INTO staging_${tableId}
    SELECT * FROM ${tableName}
    ORDER BY _cs_row_id  -- Deterministic order
    LIMIT ${BATCH_SIZE} OFFSET ${offset}
  `)
  offset += BATCH_SIZE

  // WAL checkpoint every 5 batches
  if (offset % (BATCH_SIZE * 5) === 0) {
    await conn.query('CHECKPOINT')
  }

  // Yield to UI
  await scheduler.yield()
}

// Atomic swap
await conn.query(`DROP TABLE ${tableName}`)
await conn.query(`ALTER TABLE staging_${tableId} RENAME TO ${tableName}`)
```

**Key Rules:**
- Always use `ORDER BY` with OFFSET for determinism
- WAL checkpoint every 5 batches to prevent unbounded log growth
- Use `scheduler.yield()` between batches for UI responsiveness
- Staging table pattern ensures atomic operations

### 5.10 Semantic Validation

Transform operations validate inputs before execution using `src/lib/validation/`:

**Validator Pattern:**
```typescript
// Type-specific validators
const validator = getValidator('email')
const result = await validator.validate(value)
// { isValid: boolean, confidence: number, suggestion?: string }
```

**ROW_DETAIL_THRESHOLD:** For tables >10k rows, audit entries capture only summary statistics, not per-row details.

**Pre-Transform Validation:** Commands with `preview: true` run validation without mutation:
```typescript
const command = createCommand('transform:email_normalize', {
  tableId,
  column: 'email',
  preview: true  // Validate only, don't mutate
})
```

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
- **Row Identity:** `_cs_origin_id` column tracks stable row identity for diff operations across transforms
- **Panel Architecture:** Main feature UIs are in `components/panels/`, not `features/` — the `features/` directory contains business logic
