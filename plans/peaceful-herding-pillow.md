# Command Pattern Architecture Migration Plan

## Problem Statement

CleanSlate Pro has architectural fragmentation where **Audit Logging, Undo/Redo, Highlighting, and Diffing** are implemented separately across 5 feature engines:
- Clean (`transformations.ts`)
- Standardize (`standardizer-engine.ts`)
- Match (`fuzzy-matcher.ts`)
- Combine (`combiner-engine.ts`)
- Scrub (`obfuscation.ts`)

Fixing one engine often breaks another. This plan migrates to a **Command Pattern Architecture** that centralizes cross-cutting concerns while maintaining performance for 2M+ row datasets.

---

## Research-Based Design Principles (2025 Best Practices)

| Principle | Rationale | Source |
|-----------|-----------|--------|
| **Command Pattern over Memento** | No full-state snapshots for every action; commands are lightweight | [esveo.com](https://www.esveo.com/en/blog/undo-redo-and-the-command-pattern/), [JitBlox](https://www.jitblox.com/blog/designing-a-lightweight-undo-history-with-typescript) |
| **Zero-Copy SQL** | All logic in SQL, no JS row iteration | [Medium - DuckDB WASM](https://medium.com/@davidrp1996/lightning-fast-analytics-duckdb-wasm-for-large-datasets-in-the-browser-43cb43cee164) |
| **Column Versioning** | For destructive column ops, ADD COLUMN v2 instead of UPDATE; undo = DROP v2 | Database versioning best practices |
| **SQL-Based Highlighting** | WHERE clause predicates for dynamic row/cell highlighting without fetching to JS | CQRS read projections |
| **CQRS-lite** | Separate command execution from read projections (diff views) | [Microsoft Azure Architecture](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) |

---

## Critical Design Decisions

### 1. Undo Strategy for Large Datasets (2M Rows)

**Problem**: Audit log has 50k row cap (`ROW_DETAIL_THRESHOLD`). Cannot rely on audit for functional undo on 2M rows.

**Solution**: Three-tier undo strategy based on operation type:

| Tier | Strategy | Operations | Undo Mechanism |
|------|----------|------------|----------------|
| **Tier 1: Metadata-Only** | Column versioning | `trim`, `lowercase`, `uppercase`, `replace`, `title_case`, `remove_accents` | `ALTER TABLE ADD COLUMN col_v2`, hide `col_v1` in metadata. Undo = DROP `col_v2`, restore `col_v1` visibility. **Zero-copy, instant.** |
| **Tier 2: Invertible SQL** | SQL inverse | `rename_column`, `edit:cell`, `edit:batch` | Execute inverse SQL directly. No snapshot needed. |
| **Tier 3: Full Snapshot** | Pre-execution snapshot | `remove_duplicates`, `cast_type`, `split_column`, `combine_columns`, `standardize_date`, `calculate_age`, `custom_sql`, `match:merge`, `combine:*` | Create full table snapshot before execution. Undo = restore from snapshot. |

**Future Optimization (Tier 3 - Delta Snapshot)**: For deletion operations like `remove_duplicates` on 2M rows, full snapshots are memory-heavy. Consider "Delta Snapshot" approach:
```sql
-- Store ONLY the deleted rows in a sidecar table
CREATE TABLE _undo_delta_1 AS SELECT * FROM data WHERE [duplicate_condition];

-- Undo: Re-insert the deleted rows
INSERT INTO data SELECT * FROM _undo_delta_1;
DROP TABLE _undo_delta_1;
```
**Note**: Start with Full Snapshot for simplicity. Implement Delta Snapshot later if memory limits become an issue.

**Column Versioning Implementation** (Zero UI Changes):
```sql
-- Execute (trim on column "Email")

-- 1. Rename original out of the way (Backup)
ALTER TABLE "data" RENAME COLUMN "Email" TO "Email__backup_v1";

-- 2. Create new column with the *original* name containing transformed data
ALTER TABLE "data" ADD COLUMN "Email" AS TRIM("Email__backup_v1");

-- Result: App still queries "Email" - no UI changes needed!


-- Undo

-- 1. Drop the "new" version
ALTER TABLE "data" DROP COLUMN "Email";

-- 2. Restore the backup to the original name
ALTER TABLE "data" RENAME COLUMN "Email__backup_v1" TO "Email";
```

**Key Advantage**: The column name stays the same throughout. No metadata aliasing needed. UI components continue querying the original column name without modification.

**Audit Log Purpose**: Human reference and compliance only. NOT used for data restoration.

### 2. Row/Cell Highlighting Strategy

**Problem**: `affectedColumns[]` + `rowsAffected` enables column highlighting but not row/cell highlighting for virtualized grids.

**Solution**: Add `getAffectedRowsPredicate()` to Command interface. Returns SQL WHERE clause that identifies affected rows. UI injects this into virtualized grid queries for dynamic tinting without fetching IDs to JS.

**Example**:
```typescript
// FindReplaceCommand.getAffectedRowsPredicate()
// Returns: "\"email\" LIKE '%@old-domain.com%'"

// VirtualizedGrid query injection:
SELECT *, CASE WHEN "email" LIKE '%@old-domain.com%' THEN 1 ELSE 0 END as _highlight
FROM "my_table"
LIMIT 100 OFFSET 5000
```

**Performance Optimization**: For operations like `trim` on 2M rows where nearly all rows are affected:
- Allow `rowPredicate: 'TRUE'` to indicate "all rows affected"
- UI can fall back to column-header highlighting (tint the column) instead of per-row checks
- Better UX and performance when `affected > 50%` of total rows

### 3. Diff-First Development (Phase 1.5)

**Problem**: If Diff system is Phase 6, all 25+ commands may lack proper metadata for diff views.

**Solution**: Define diff VIEW strategy in Phase 1.5. Every command must produce SQL compatible with `v_diff_step_X` view creation. Commands are not complete until they pass diff visualization tests.

---

## Architecture Overview

```
User Action (UI)
      │
      ▼
┌─────────────────┐
│ Command Factory │  Creates typed Command from UI params
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                     CommandExecutor                          │
│  1. validate()           → ValidationResult (with fixAction) │
│  2. checkUndoStrategy()  → Tier 1/2/3 decision              │
│  3. pre-snapshot         → if Tier 3                        │
│  4. execute()            → ExecutionResult                   │
│  5. createDiffView()     → v_diff_step_X for highlighting   │
│  6. recordTimeline()     → TimelineCommand with predicate   │
│  7. updateStores()       → tableStore, auditStore, diffStore│
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  DuckDB Layer   │  SQL via mutex (src/lib/duckdb/)
└─────────────────┘
```

---

## TypeScript Interfaces (Revised)

### Core Command Interface

```typescript
// src/lib/commands/types.ts

export type CommandType =
  // Transform (Tier 1 - Column Versioning)
  | 'transform:trim' | 'transform:lowercase' | 'transform:uppercase'
  | 'transform:title_case' | 'transform:remove_accents' | 'transform:replace'
  | 'transform:replace_empty' | 'transform:sentence_case' | 'transform:collapse_spaces'
  | 'transform:remove_non_printable'
  // Transform (Tier 2 - Invertible SQL)
  | 'transform:rename_column'
  // Transform (Tier 3 - Snapshot Required)
  | 'transform:remove_duplicates' | 'transform:cast_type' | 'transform:split_column'
  | 'transform:combine_columns' | 'transform:standardize_date' | 'transform:calculate_age'
  | 'transform:unformat_currency' | 'transform:fix_negatives' | 'transform:pad_zeros'
  | 'transform:fill_down' | 'transform:custom_sql'
  // Standardize (Tier 3)
  | 'standardize:apply'
  // Match (Tier 3)
  | 'match:merge'
  // Combine (Tier 3)
  | 'combine:stack' | 'combine:join'
  // Scrub (Tier 1 for hash/mask, Tier 3 for redact)
  | 'scrub:hash' | 'scrub:redact' | 'scrub:mask' | 'scrub:year_only'
  // Edit (Tier 2)
  | 'edit:cell' | 'edit:batch'

export interface CommandContext {
  db: {
    query: <T>(sql: string) => Promise<T[]>
    execute: (sql: string) => Promise<void>
    getTableColumns: (tableName: string) => Promise<ColumnInfo[]>
  }
  table: { id: string; name: string; columns: ColumnInfo[]; rowCount: number }
  project?: { secret: string }  // For hash operations (FR-D1)
  /** Column version metadata for undo (Tier 1) */
  columnVersions: Map<string, ColumnVersionInfo>
}

// Updated for expression chaining - see "Critical Issues" section for details
export interface ColumnVersionInfo {
  originalColumn: string
  baseColumn: string           // Single backup column (e.g., "Email__base")
  expressionStack: {
    expression: string         // e.g., "TRIM(col)" where col is placeholder
    commandId: string
  }[]
}

// ===== VALIDATION (with auto-fix capability) =====

export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface ValidationError {
  code: string
  message: string
  field?: string
  /** Optional: Command that can fix this error automatically */
  fixAction?: {
    label: string        // "Cast to string first"
    commandType: CommandType
    params: unknown      // Params to create fix command
  }
}

export interface ValidationWarning {
  code: string
  message: string
  requiresConfirmation: boolean
  confirmationData?: Record<string, unknown>
}

// ===== EXECUTION (with schema change tracking) =====

export interface ExecutionResult {
  success: boolean
  rowCount: number
  columns: ColumnInfo[]
  affected: number
  error?: string
  /** Columns added by this command (e.g., split_column) */
  newColumnNames: string[]
  /** Columns removed by this command (e.g., combine_columns, match:merge) */
  droppedColumnNames: string[]
  /** For Tier 1 commands: the versioned column created */
  versionedColumn?: { original: string; versioned: string; version: number }
}

// ===== AUDIT (structured details) =====

export interface AuditInfo {
  action: string
  /** Structured details (JSON-serializable) for rich drill-down */
  details: AuditDetails
  affectedColumns: string[]
  rowsAffected: number
  hasRowDetails: boolean
  auditEntryId: string
  isCapped: boolean
}

/** Structured audit details - type varies by command */
export type AuditDetails =
  | TransformAuditDetails
  | StandardizeAuditDetails
  | MergeAuditDetails
  | CombineAuditDetails
  | EditAuditDetails

export interface TransformAuditDetails {
  type: 'transform'
  transformationType: string
  column?: string
  params?: Record<string, unknown>
  sampleChanges?: { before: string; after: string }[]
}

export interface StandardizeAuditDetails {
  type: 'standardize'
  column: string
  algorithm: 'fingerprint' | 'metaphone'
  clusterCount: number
  /** Cluster mappings: clusterId → { masterValue, memberValues[] } */
  clusters: Record<string, { master: string; members: string[] }>
}

export interface MergeAuditDetails {
  type: 'merge'
  matchColumns: string[]
  pairsMerged: number
  rowsDeleted: number
  survivorStrategy: 'first' | 'most_complete'
}

export interface CombineAuditDetails {
  type: 'combine'
  operation: 'stack' | 'join'
  sourceTableA: string
  sourceTableB: string
  joinKey?: string
  joinType?: 'inner' | 'left' | 'right' | 'full'
}

export interface EditAuditDetails {
  type: 'edit'
  cellCount: number
  changes: { rowId: string; column: string; before: unknown; after: unknown }[]
}

// ===== INVERTIBILITY (3-tier strategy) =====

export type UndoTier = 1 | 2 | 3

export interface InvertibilityInfo {
  /** Undo tier: 1=column versioning, 2=inverse SQL, 3=snapshot */
  tier: UndoTier
  /** For Tier 2: SQL to undo */
  inverseSql?: string
  /** For Tier 1: column versioning metadata */
  columnVersion?: { original: string; versioned: string }
  /** Human-readable explanation */
  undoStrategy: string
}

// ===== HIGHLIGHTING (SQL predicate for virtualized grid) =====

export interface HighlightInfo {
  /** SQL WHERE clause identifying affected rows (for grid injection) */
  rowPredicate: string | null
  /** Columns to highlight headers */
  columns: string[]
  /** Highlight mode for UI */
  mode: 'row' | 'cell' | 'column' | 'full'
}

// ===== COMMAND INTERFACE =====

export interface Command<TParams = unknown> {
  readonly id: string
  readonly type: CommandType
  readonly label: string
  readonly params: TParams

  /** Validate params and preconditions. May suggest auto-fix actions. */
  validate(ctx: CommandContext): Promise<ValidationResult>

  /** Execute the command. Returns schema changes for immediate UI update. */
  execute(ctx: CommandContext): Promise<ExecutionResult>

  /** Get structured audit info for logging and drill-down. */
  getAuditInfo(ctx: CommandContext, result: ExecutionResult): AuditInfo

  /** Determine undo strategy (Tier 1/2/3). */
  getInvertibility(): InvertibilityInfo

  /**
   * Get SQL WHERE clause for affected rows (row/cell highlighting).
   * Returns null if highlighting not applicable (e.g., remove_duplicates).
   */
  getAffectedRowsPredicate(ctx: CommandContext): Promise<string | null>

  /**
   * Generate SQL for diff view creation.
   * Used by CommandExecutor to create v_diff_step_X view.
   */
  getDiffViewSql?(ctx: CommandContext, stepIndex: number): string
}
```

### CommandExecutor Interface

```typescript
// src/lib/commands/executor.ts

export interface ExecutorProgress {
  phase: 'validating' | 'snapshotting' | 'executing' | 'diffing' | 'complete'
  progress: number  // 0-100
  message: string
}

export interface ExecuteOptions {
  skipValidation?: boolean
  skipDiffView?: boolean
  skipTimeline?: boolean
  onProgress?: (progress: ExecutorProgress) => void
}

export interface ExecutorResult {
  success: boolean
  executionResult?: ExecutionResult
  validationResult?: ValidationResult
  timelineCommand?: TimelineCommand
  highlightInfo?: HighlightInfo
  diffViewName?: string  // v_diff_step_X
  error?: string
}

export interface ICommandExecutor {
  /** Execute with full lifecycle including diff view creation */
  execute(command: Command, options?: ExecuteOptions): Promise<ExecutorResult>

  /** Undo using appropriate tier strategy */
  undo(tableId: string): Promise<ExecutorResult>

  /** Redo command */
  redo(tableId: string): Promise<ExecutorResult>

  canUndo(tableId: string): boolean
  canRedo(tableId: string): boolean

  /** Get highlight predicate for current step (for grid injection) */
  getHighlightPredicate(tableId: string, stepIndex: number): string | null
}
```

---

## File Structure

```
src/lib/commands/
├── types.ts              # All interfaces (revised above)
├── registry.ts           # CommandRegistry.create(type, params)
├── executor.ts           # CommandExecutor class (3-tier undo logic)
├── context.ts            # buildCommandContext(tableId)
├── column-versions.ts    # ColumnVersionManager for Tier 1 undo
├── diff-views.ts         # DiffViewManager for v_diff_step_X views
├── utils/
│   ├── sql.ts            # escapeSqlString(), quoteColumn(), quoteTable()
│   ├── date.ts           # DATE_FORMATS[], buildDateParseExpression()
│   └── audit.ts          # Structured audit capture
├── transform/
│   ├── base.ts           # BaseTransformCommand (abstract, Tier 1 default)
│   ├── tier1/            # Column versioning commands
│   │   ├── trim.ts
│   │   ├── lowercase.ts
│   │   ├── uppercase.ts
│   │   ├── replace.ts
│   │   └── ...
│   ├── tier2/            # Invertible SQL commands
│   │   └── rename-column.ts
│   └── tier3/            # Snapshot-required commands
│       ├── remove-duplicates.ts
│       ├── split-column.ts
│       ├── custom-sql.ts
│       └── ...
├── standardize/
│   └── apply.ts          # Tier 3
├── match/
│   └── merge.ts          # Tier 3
├── combine/
│   ├── stack.ts          # Tier 3
│   └── join.ts           # Tier 3
├── scrub/
│   ├── hash.ts           # Tier 1 (column versioning)
│   ├── redact.ts         # Tier 3
│   └── mask.ts           # Tier 1
└── edit/
    ├── cell.ts           # Tier 2
    └── batch.ts          # Tier 2
```

---

## Phased Migration Plan (Revised)

### Phase 1: Core Infrastructure
**Goal**: Build command system foundation without breaking existing code.

**New Files**:
- `src/lib/commands/types.ts` - All interfaces (revised)
- `src/lib/commands/registry.ts` - Factory pattern
- `src/lib/commands/executor.ts` - Central orchestrator with 3-tier undo
- `src/lib/commands/context.ts` - Context builder
- `src/lib/commands/column-versions.ts` - Tier 1 undo management
- `src/lib/commands/utils/sql.ts` - SQL helpers
- `src/lib/commands/utils/date.ts` - Date parsing

### Phase 1.5: Diff View Foundation (CRITICAL - Before Phase 2)
**Goal**: Define diff VIEW strategy so all commands produce correct metadata. **This is the most important phase** - if you don't define the View contract here, you will rewrite every command later.

**New Files**:
- `src/lib/commands/diff-views.ts` - DiffViewManager

**Standardized View Schema** (every diff view must include):
```sql
CREATE OR REPLACE VIEW v_diff_step_{tableId}_{stepIndex} AS
SELECT
  "_cs_id" as _row_id,                                           -- Stable row identifier
  CASE WHEN {rowPredicate} THEN 'modified' ELSE 'unchanged' END as _change_type,
  '{columnName}' as _affected_column,                            -- Column that changed
  *                                                              -- All data columns
FROM "my_table"
```

| Column | Type | Purpose |
|--------|------|---------|
| `_row_id` | VARCHAR | Stable row identifier (from `_cs_id`) |
| `_change_type` | VARCHAR | 'added' \| 'removed' \| 'modified' \| 'unchanged' |
| `_affected_column` | VARCHAR | Which column was modified (for cell highlighting) |

**Key Implementation**:
```typescript
// DiffViewManager.createStepView()
// Creates: v_diff_step_{tableId}_{stepIndex}

CREATE OR REPLACE VIEW v_diff_step_1 AS
SELECT
  "_cs_id" as _row_id,
  CASE WHEN {rowPredicate} THEN 'modified' ELSE 'unchanged' END as _change_type,
  'Email' as _affected_column,
  *
FROM "my_table"
```

**Validation Gate**: No command is merged until it:
1. Implements `getAffectedRowsPredicate()`
2. Passes diff view visualization test
3. Returns proper `_affected_column` for cell-level highlighting

**Important Technical Nuance - Tier 3 Diffs**:
- **Tier 1 (Modifications)**: Simple `CASE WHEN` view works - rows still exist in current table.
- **Tier 3 (Deletions)**: A view on the current table cannot show deleted rows (they're gone!). To show "red" rows for deletions, Tier 3 diff views must `LEFT JOIN` the Snapshot/Delta table to the current table.

```sql
-- Tier 3 Diff View for remove_duplicates (shows deleted rows)
CREATE VIEW v_diff_step_2 AS
SELECT
  COALESCE(c."_cs_id", s."_cs_id") as _row_id,
  CASE
    WHEN c."_cs_id" IS NULL THEN 'removed'
    ELSE 'unchanged'
  END as _change_type,
  NULL as _affected_column,
  COALESCE(c.*, s.*)  -- Show deleted row data from snapshot
FROM "_snapshot_before_step_2" s
LEFT JOIN "my_table" c ON s."_cs_id" = c."_cs_id"
```

**Performance Note**: For 2M rows, LEFT JOINing snapshot against live table can stutter without indexing. Ensure `_cs_id` is indexed immediately after snapshot creation:
```sql
CREATE INDEX idx_snapshot_cs_id ON "_snapshot_before_step_2"("_cs_id");
```

**Recommendation**: Get Tier 1 (Modifications) working first. Tier 3 diffs require access to the "Before" state and can be implemented after the core pattern is proven.

### Phase 2: Migrate Clean Transformations (Tier 1 First)
**Goal**: Migrate column versioning commands first (instant undo proof-of-concept).

**Migration Order**:
1. **Tier 1** (Column Versioning): `trim`, `lowercase`, `uppercase`, `replace`, `title_case`, `remove_accents`
2. **Tier 2** (Invertible SQL): `rename_column`
3. **Tier 3** (Snapshot): `remove_duplicates`, `cast_type`, `split_column`, `combine_columns`, `standardize_date`, `calculate_age`, `custom_sql`

**Files to Modify**:
- `src/lib/transformations.ts` - Keep as facade, delegate to commands
- `src/stores/tableStore.ts` - Add column version metadata

### Phase 3: Migrate Standardizer & Matcher
**Goal**: Unify under command system with structured audit details.

**Key**: StandardizeAuditDetails must include cluster mappings for drill-down.

### Phase 4: Migrate Combiner & Scrubber
**Goal**: Complete feature engine migration.

### Phase 5: Unify Undo/Redo
**Goal**: Deprecate `editStore`, use only `CommandExecutor`.

**Key Changes**:
- DataGrid.tsx calls `CommandExecutor.undo()` for all operations
- Undo automatically uses correct tier strategy

### Phase 6: Performance Optimization
**Goal**: Tune for 2M row datasets.

- Snapshot pruning (max 5 per timeline)
- Column version cleanup (prune old versions)
- Diff view materialization for heavy queries

---

## Undo Strategy by Command

| Command | Tier | Undo Mechanism |
|---------|------|----------------|
| `trim` | 1 | Pop expression from stack, rebuild computed column |
| `lowercase` | 1 | Pop expression from stack, rebuild computed column |
| `uppercase` | 1 | Pop expression from stack, rebuild computed column |
| `replace` | 1 | Pop expression from stack, rebuild computed column |
| `replace_empty` | 1 | Pop expression from stack, rebuild computed column |
| `title_case` | 1 | Pop expression from stack, rebuild computed column |
| `remove_accents` | 1 | Pop expression from stack, rebuild computed column |
| `sentence_case` | 1 | Pop expression from stack, rebuild computed column |
| `collapse_spaces` | 1 | Pop expression from stack, rebuild computed column |
| `remove_non_printable` | 1 | Pop expression from stack, rebuild computed column |
| `rename_column` | 2 | `ALTER TABLE RENAME COLUMN new TO old` |
| `edit:cell` | 2 | `UPDATE ... SET col = prevValue WHERE _cs_id = ?` |
| `edit:batch` | 2 | Batch UPDATE with stored previous values |
| `remove_duplicates` | 3 | Restore from pre-snapshot |
| `cast_type` | 3 | Restore from pre-snapshot |
| `split_column` | 3 | Restore from pre-snapshot |
| `combine_columns` | 3 | Restore from pre-snapshot |
| `standardize_date` | 3 | Restore from pre-snapshot |
| `calculate_age` | 3 | Restore from pre-snapshot |
| `unformat_currency` | 3 | Restore from pre-snapshot |
| `fix_negatives` | 3 | Restore from pre-snapshot |
| `pad_zeros` | 3 | Restore from pre-snapshot |
| `fill_down` | 3 | Restore from pre-snapshot |
| `custom_sql` | 3 | Restore from pre-snapshot |
| `standardize:apply` | 3 | Restore from pre-snapshot |
| `match:merge` | 3 | Restore from pre-snapshot |
| `combine:stack` | 3 | Restore from pre-snapshot |
| `combine:join` | 3 | Restore from pre-snapshot |
| `scrub:hash` | 1 | Pop expression from stack, rebuild computed column |
| `scrub:mask` | 1 | Pop expression from stack, rebuild computed column |
| `scrub:redact` | 3 | Restore from pre-snapshot (PII destroyed) |
| `scrub:year_only` | 3 | Restore from pre-snapshot |

---

## Performance Guardrails (2M Rows)

| Constraint | Implementation |
|------------|----------------|
| **Zero JS row loops** | All commands use SQL only |
| **Tier 1 Undo** | Metadata-only, instant regardless of row count |
| **Tier 3 Snapshots** | Limited to 5 per timeline, pruned LRU |
| **Lazy Highlighting** | SQL predicate injected into virtualized queries |
| **Diff Views** | DuckDB views, not materialized tables |
| **Audit Details** | Structured JSON, sample for UI, full on-demand |

---

## Verification Plan

### Unit Tests
```bash
npm test -- --grep "Command"

# Test files:
# e2e/commands/tier1-undo.spec.ts     # Column versioning undo
# e2e/commands/tier3-undo.spec.ts     # Snapshot undo
# e2e/commands/highlighting.spec.ts   # Row predicate injection
# e2e/commands/diff-views.spec.ts     # v_diff_step_X creation
```

### Integration Tests
1. **Tier 1 Undo at scale**: Trim 2M rows, undo instantly (< 100ms)
2. **Highlighting accuracy**: Replace on 50 rows, verify exact row highlighting
3. **Diff view performance**: Scroll through 100k diff view, verify < 50ms per page
4. **Structured audit**: Run standardize, verify cluster mappings in audit details

### Manual Testing
1. Load 500k row CSV
2. Apply: trim → lowercase → remove_duplicates
3. Verify highlighting shows affected rows dynamically
4. Ctrl+Z three times, verify instant undo for trim/lowercase
5. Check audit log has structured details with drill-down

---

## Critical Files Summary

| File | Action | Priority |
|------|--------|----------|
| `src/lib/commands/types.ts` | Create (revised interfaces) | P1 |
| `src/lib/commands/executor.ts` | Create (3-tier undo) | P1 |
| `src/lib/commands/column-versions.ts` | Create (Tier 1 manager) | P1 |
| `src/lib/commands/diff-views.ts` | Create (v_diff_step_X) | P1.5 |
| `src/lib/commands/utils/sql.ts` | Create (extract) | P1 |
| `src/lib/commands/transform/tier1/*.ts` | Create (6 commands) | P2 |
| `src/lib/transformations.ts` | Refactor to facade | P2 |
| `src/stores/tableStore.ts` | Add column version metadata | P2 |
| `src/stores/editStore.ts` | Deprecate | P5 |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Column versioning bloats table | Prune old versions after 10 steps |
| Diff views slow on complex predicates | Add predicate complexity limit, fall back to column highlighting |
| Breaking existing transforms | Keep `applyTransformation()` facade during migration |
| Structured audit breaks existing UI | Add backward-compat `toString()` for AuditDetails |

---

---

## Critical Issues to Address

### Issue 1: Column Versioning - Chained Transformations

**Problem**: Current implementation creates computed columns:
```sql
ALTER TABLE "data" ADD COLUMN "Email" AS TRIM("Email__backup_v1");
```

If user applies `trim → lowercase` on same column, second operation tries to rename a computed column. DuckDB computed columns have limitations with chaining.

**Solution - Expression Chaining**:
Instead of creating multiple backup columns, chain expressions on a single base column:

```sql
-- Step 1: trim
ALTER TABLE "data" RENAME COLUMN "Email" TO "Email__base";
ALTER TABLE "data" ADD COLUMN "Email" AS (TRIM("Email__base"));

-- Step 2: lowercase (update expression, don't rename computed column)
-- DROP the computed column and recreate with nested expression
ALTER TABLE "data" DROP COLUMN "Email";
ALTER TABLE "data" ADD COLUMN "Email" AS (LOWER(TRIM("Email__base")));

-- Undo lowercase (restore to just trim)
ALTER TABLE "data" DROP COLUMN "Email";
ALTER TABLE "data" ADD COLUMN "Email" AS (TRIM("Email__base"));

-- Undo trim (restore original)
ALTER TABLE "data" DROP COLUMN "Email";
ALTER TABLE "data" RENAME COLUMN "Email__base" TO "Email";
```

**Implementation Changes**:
1. Track `baseColumn` (single backup) and `expressionStack` (array of transform expressions)
2. On new transform: push expression, rebuild computed column with nested expressions
3. On undo: pop expression, rebuild computed column
4. On full undo: drop computed column, rename base back to original

**ColumnVersionInfo Update**:
```typescript
interface ColumnVersionInfo {
  originalColumn: string
  baseColumn: string           // Single backup: Email__base
  expressionStack: {
    expression: string         // e.g., "TRIM(col)"
    commandId: string
  }[]
}
```

### Issue 2: Export Handling for Backup Columns

**Problem**: When exporting to CSV, backup columns (`*__base`) should be excluded.

**Solution**: Use metadata flag instead of hardcoded string matching:

1. **Extend ColumnInfo** with visibility flag:
```typescript
interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  isHidden?: boolean  // True for backup columns
}
```

2. **Set flag when creating backup column**:
```typescript
// In column-versions.ts createVersion()
// After creating backup column, update column metadata
ctx.db.execute(`COMMENT ON COLUMN "${tableName}"."${baseColumn}" IS 'hidden:true'`)
```

3. **Filter at source** (in `getTableColumns`):
```typescript
// In useDuckDB or context
const visibleColumns = columns.filter(col => !col.isHidden)
```

**Benefits**:
- Hidden from Data Grid column picker
- Hidden from Charts
- Hidden from CSV export
- Single source of truth

### Issue 3: Tier 3 Snapshot Pruning Policy

**Problem**: "Limited to 5 per timeline, pruned LRU" but what happens to undo availability?

**Solution - Explicit Policy**:
- Keep max 5 Tier 3 snapshots per table
- When 6th Tier 3 operation executes:
  1. Delete oldest snapshot
  2. Mark corresponding timeline command as `undoDisabled: true`
  3. `canUndo()` checks this flag and skips disabled commands
  4. UI shows "Undo unavailable - snapshot pruned" for affected commands

**TimelineCommandRecord Update**:
```typescript
interface TimelineCommandRecord {
  // ... existing fields
  undoDisabled?: boolean  // True if snapshot was pruned
  undoDisabledReason?: string
}
```

### Issue 4: Missing Commands in Types

**Status**: ✅ FIXED - `transform:remove_non_printable` was missing from the plan document's example but is present in actual `src/lib/commands/types.ts`. Plan document updated to include it.

All 28 command types verified in `types.ts` lines 15-55.

### Issue 5: Undo Strategy Table - Missing Commands

**Status**: ✅ FIXED - Added missing Tier 1 commands to the Undo Strategy table (lines 563-577):
- `sentence_case`, `collapse_spaces`, `remove_non_printable`, `replace_empty`

### Issue 6: Phase 1.5 Completion Status

**Clarification**: Phase 1.5 infrastructure is complete (diff-views.ts implemented). The "validation gate" for commands is a per-command requirement, not a phase blocker. Update status to:

> Phase 1.5: Diff View Foundation - INFRASTRUCTURE COMPLETE
> (Individual commands validated as they're implemented)

### Issue 7: Diff Views for Intermediate Steps

**Problem**: With chained transforms (trim → lowercase → replace), diff view currently shows:
- Base column: Original value
- Computed column: Final value after all transforms

**Solution (Phase 6 Enhancement)**: With expression chaining architecture, intermediate diffs ARE possible without storage cost!

Since `expressionStack` is available, we can generate diff views comparing Expression[N] vs Expression[N-1]:
```sql
-- Diff view for step 2 (lowercase) showing what changed from step 1 (trim)
SELECT *,
  CASE WHEN LOWER(TRIM("Email__base")) != TRIM("Email__base") THEN 'modified' ELSE 'unchanged' END as _change_type
FROM "my_table"
```

**Current Scope**: For now, diff views show original → current.
**Phase 6**: Enable intermediate diff views by generating Expression[N-1] from `expressionStack.slice(0, -1)`.

### Issue 8: Error Recovery for Expression Rebuild

**Problem**: If `DROP COLUMN` succeeds but `ADD COLUMN` fails during expression rebuild, column is broken.

**Solution**: Add rollback protection in `column-versions.ts`:

```typescript
async rebuildComputedColumn(tableName: string, column: string, newExprStack: ExpressionEntry[]): Promise<void> {
  const info = this.versions.get(column)
  if (!info) throw new Error(`No version info for ${column}`)

  // Capture current state for rollback
  const currentExpr = this.buildNestedExpression(info.expressionStack, info.baseColumn)

  try {
    // Drop and recreate with new expression
    await this.db.execute(`ALTER TABLE "${tableName}" DROP COLUMN "${column}"`)
    const newExpr = this.buildNestedExpression(newExprStack, info.baseColumn)
    await this.db.execute(`ALTER TABLE "${tableName}" ADD COLUMN "${column}" AS (${newExpr})`)
    info.expressionStack = newExprStack
  } catch (error) {
    // Rollback: restore previous computed column
    try {
      await this.db.execute(`ALTER TABLE "${tableName}" ADD COLUMN "${column}" AS (${currentExpr})`)
    } catch (rollbackError) {
      // Critical: both failed - column is broken
      throw new Error(`Column rebuild failed and rollback failed: ${error}. Rollback error: ${rollbackError}`)
    }
    throw error  // Re-throw original error
  }
}
```

**Edge Case - Full Undo Rollback**: If undoing the first transform (restoring base → original):
```typescript
async restoreOriginalColumn(tableName: string, column: string): Promise<void> {
  const info = this.versions.get(column)
  if (!info) throw new Error(`No version info for ${column}`)

  try {
    await this.db.execute(`ALTER TABLE "${tableName}" DROP COLUMN "${column}"`)
    await this.db.execute(`ALTER TABLE "${tableName}" RENAME COLUMN "${info.baseColumn}" TO "${column}"`)
    this.versions.delete(column)
  } catch (error) {
    // If DROP succeeded but RENAME failed, column is lost - critical error
    throw new Error(`Failed to restore original column: ${error}`)
  }
}
```

---

## Implementation Status

### ✅ Phase 1: Core Infrastructure - COMPLETE
All core files implemented:
- `types.ts`, `registry.ts`, `executor.ts`, `context.ts`
- `column-versions.ts`, `diff-views.ts`
- `utils/sql.ts`, `utils/date.ts`

### ✅ Phase 1.5: Diff View Foundation - INFRASTRUCTURE COMPLETE
- `createTier1DiffView()` and `createTier3DiffView()` implemented
- Wired into CommandExecutor
- Individual commands validated as they're implemented

### ✅ Phase 2: Transform Commands - COMPLETE (22/22)

**All transform commands implemented with expression chaining (Tier 1) and snapshot support (Tier 3):**
| Tier | Commands |
|------|----------|
| Tier 1 | trim, lowercase, uppercase, title_case, remove_accents, sentence_case, collapse_spaces, remove_non_printable, replace, replace_empty |
| Tier 2 | rename_column |
| Tier 3 | remove_duplicates, cast_type, custom_sql, split_column, combine_columns, standardize_date, calculate_age, unformat_currency, fix_negatives, pad_zeros, fill_down |

**Key improvements:**
- Expression chaining implemented for Tier 1 commands (single `__base` column, nested expressions)
- All Tier 1 commands use `{{COL}}` placeholder for composable transforms
- All 7 missing Tier 3 commands implemented

### 🚨 Phase 2.5: UI Integration - CRITICAL BLOCKER (NOT STARTED)

**Problem**: The command system is fully built but **completely disconnected from the UI**. The application still uses the legacy `applyTransformation()` function. All new commands are inert until this phase is complete.

**Required Changes:**

| Priority | File | Change |
|----------|------|--------|
| P0 | `CleanPanel.tsx` | Replace `applyTransformation()` → `getCommandExecutor().execute(command)` |
| P0 | `registry.ts` | Export `getCommandTypeFromTransform()` for UI |
| P1 | `App.tsx` | Route `Ctrl+Z`/`Ctrl+Y` → `CommandExecutor.undo()/redo()` |
| P1 | `executor.ts` | Ensure `updateTableStore()` is called/accessible |
| P2 | `timeline-engine.ts` | Resolve duplicate snapshots (`_timeline_original_*` vs `_cmd_snapshot_*`) |

**Current vs Required Flow:**
```
CURRENT (Legacy - still active):
  CleanPanel → applyTransformation() → DuckDB → Manual store updates

REQUIRED (Command Pattern - not wired):
  CleanPanel → CommandExecutor.execute(command) → Full lifecycle
               ↓
               Validation → Snapshot → Execute → Audit → Diff → Undo Stack
```

### 🔲 Phase 3: Standardizer & Matcher - NOT STARTED
Commands needed:
- `standardize:apply` - Cluster-based value standardization
- `match:merge` - Duplicate row merging

### 🔲 Phase 4: Combiner & Scrubber - NOT STARTED
Commands needed:
- `combine:stack` - UNION ALL tables
- `combine:join` - JOIN tables
- `scrub:hash` (Tier 1) - SHA-256 with secret
- `scrub:mask` (Tier 1) - Partial value masking
- `scrub:redact` (Tier 3) - Full PII redaction
- `scrub:year_only` (Tier 3) - Date → year only

### 🔲 Phase 5: Unify Undo/Redo - NOT STARTED
Commands needed:
- `edit:cell` (Tier 2) - Single cell edit
- `edit:batch` (Tier 2) - Multiple cell edits
- Refactor DataGrid.tsx to use CommandExecutor
- Deprecate editStore.ts

### 🔲 Phase 6: Performance Optimization - NOT STARTED

---

## Next Implementation Priority

### ✅ Priority 0: Fix Column Versioning Chaining - COMPLETE

Expression chaining implemented:
- `ColumnVersionInfo` updated with `baseColumn` and `expressionStack`
- Single `__base` column instead of multiple backup columns
- Nested expressions for chained transforms (e.g., `LOWER(TRIM("Email__base"))`)
- All Tier 1 commands updated to use `{{COL}}` placeholder

### ✅ Priority 1: Phase 2 Completion (7 Tier 3 Commands) - COMPLETE

All 7 Tier 3 commands implemented:
- combine_columns, standardize_date, calculate_age

### 🚨 Priority 2: UI Integration (Phase 2.5) - NEXT ACTION REQUIRED

**This is the critical blocker.** Without this, the entire command system is inert.

**Minimum viable integration:**
1. Update `CleanPanel.tsx` to call `CommandExecutor.execute()` instead of `applyTransformation()`
2. Export `getCommandTypeFromTransform()` from registry
3. Handle `ExecutorResult` to update UI (toast, table refresh)

**Files to modify:**
```
src/components/panels/CleanPanel.tsx    # Main integration point
src/lib/commands/registry.ts            # Export utility function
src/lib/commands/index.ts               # Re-export utility
```

**After this phase:** All 22 transform commands will work through the new system with:
- Automatic validation
- Tier 1/2/3 undo strategies
- Structured audit logging
- Diff view creation
- unformat_currency, fix_negatives, pad_zeros, fill_down

**Previous ColumnVersionInfo Changes (for reference):**
```typescript
export interface ColumnVersionInfo {
  originalColumn: string
  baseColumn: string           // Single backup: Email__base
  expressionStack: {
    expression: string         // e.g., "TRIM(col)"
    commandId: string
  }[]
}
```

**createVersion() Logic:**
```typescript
async createVersion(tableName, column, expression, commandId) {
  const info = versions.get(column)

  if (!info) {
    // First transform: create base column
    const baseCol = `${column}__base`
    await db.execute(`ALTER TABLE RENAME COLUMN "${column}" TO "${baseCol}"`)
    // Create computed column with single expression
    await db.execute(`ALTER TABLE ADD COLUMN "${column}" AS (${expression.replace(col, baseCol)})`)
    versions.set(column, { originalColumn: column, baseColumn: baseCol, expressionStack: [{expression, commandId}] })
  } else {
    // Chained transform: rebuild with nested expressions
    info.expressionStack.push({ expression, commandId })
    await db.execute(`ALTER TABLE DROP COLUMN "${column}"`)
    const nestedExpr = buildNestedExpression(info.expressionStack, info.baseColumn)
    await db.execute(`ALTER TABLE ADD COLUMN "${column}" AS (${nestedExpr})`)
  }
}
```

**buildNestedExpression() Helper:**
```typescript
function buildNestedExpression(stack, baseColumn) {
  // stack: [{expr: 'TRIM(col)'}, {expr: 'LOWER(col)'}]
  // Result: LOWER(TRIM("Email__base"))
  let result = `"${baseColumn}"`
  for (const { expression } of stack) {
    // Replace 'col' placeholder with current result
    result = expression.replace(/\bcol\b/g, result)
  }
  return result
}
```

**Transform Expression Format:**
Each transform's `getTransformExpression()` should return expression with `{{COL}}` placeholder (distinct token to avoid regex collision with SQL keywords like `protocol`, `collection`):
- Trim: `TRIM({{COL}})`
- Lowercase: `LOWER({{COL}})`
- Replace: `REPLACE({{COL}}, 'find', 'replace')`

**Expression Building:**
```typescript
function buildNestedExpression(stack, baseColumn) {
  let result = `"${baseColumn}"`
  for (const { expression } of stack) {
    result = expression.replaceAll('{{COL}}', result)  // Explicit, safe replacement
  }
  return result
}
```

### Next Steps: Phase 3 - Standardizer & Matcher

**Commands to implement:**

| Command | Tier | Description |
|---------|------|-------------|
| `standardize:apply` | 3 | Apply cluster-based value standardization |
| `match:merge` | 3 | Merge duplicate rows based on fuzzy matching |

**Key considerations:**
- Both require Tier 3 snapshots (destructive operations)
- `standardize:apply` needs to capture cluster mappings in `StandardizeAuditDetails`
- `match:merge` needs to track survivor strategy and deleted row IDs

**Files to create:**
```
src/lib/commands/standardize/
└── apply.ts

src/lib/commands/match/
└── merge.ts
```
