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

export interface ColumnVersionInfo {
  originalColumn: string
  currentVersion: number
  versionHistory: { version: number; columnName: string; commandId: string }[]
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
| `trim` | 1 | DROP versioned column, restore original visibility |
| `lowercase` | 1 | DROP versioned column |
| `uppercase` | 1 | DROP versioned column |
| `replace` | 1 | DROP versioned column |
| `title_case` | 1 | DROP versioned column |
| `remove_accents` | 1 | DROP versioned column |
| `rename_column` | 2 | `ALTER TABLE RENAME COLUMN new TO old` |
| `edit:cell` | 2 | `UPDATE ... SET col = prevValue WHERE _cs_id = ?` |
| `edit:batch` | 2 | Batch UPDATE with stored previous values |
| `remove_duplicates` | 3 | Restore from pre-snapshot |
| `cast_type` | 3 | Restore from pre-snapshot |
| `split_column` | 3 | Restore from pre-snapshot |
| `combine_columns` | 3 | Restore from pre-snapshot |
| `standardize_date` | 3 | Restore from pre-snapshot |
| `calculate_age` | 3 | Restore from pre-snapshot |
| `custom_sql` | 3 | Restore from pre-snapshot |
| `standardize:apply` | 3 | Restore from pre-snapshot |
| `match:merge` | 3 | Restore from pre-snapshot |
| `combine:stack` | 3 | Restore from pre-snapshot |
| `combine:join` | 3 | Restore from pre-snapshot |
| `scrub:hash` | 1 | DROP versioned column |
| `scrub:mask` | 1 | DROP versioned column |
| `scrub:redact` | 3 | Restore from pre-snapshot (PII destroyed) |

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
