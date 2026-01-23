# Command Pattern Architecture Migration Plan

## Problem Statement

CleanSlate Pro has architectural fragmentation where **Audit Logging, Undo/Redo, Highlighting, and Diffing** are implemented separately across 5 feature engines. This plan migrates to a **Command Pattern Architecture** that centralizes cross-cutting concerns while maintaining performance for 2M+ row datasets.

---

## Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Command Pattern over Memento** | No full-state snapshots for every action; commands are lightweight |
| **Zero-Copy SQL** | All logic in SQL, no JS row iteration |
| **Column Versioning** | For Tier 1 ops, ADD COLUMN v2 instead of UPDATE; undo = DROP v2 |
| **SQL-Based Highlighting** | WHERE clause predicates for dynamic row/cell highlighting |
| **CQRS-lite** | Separate command execution from read projections (diff views) |

---

## Three-Tier Undo Strategy

| Tier | Strategy | Operations | Undo Mechanism |
|------|----------|------------|----------------|
| **Tier 1** | Expression chaining | `trim`, `lowercase`, `uppercase`, `replace`, `title_case`, `remove_accents`, `scrub:hash`, `scrub:mask` | Single `__base` column + nested expressions. Undo = pop expression, rebuild. **Instant.** |
| **Tier 2** | Invertible SQL | `rename_column`, `edit:cell`, `edit:batch` | Execute inverse SQL directly. No snapshot needed. |
| **Tier 3** | Full Snapshot | `remove_duplicates`, `cast_type`, `split_column`, `combine_columns`, `standardize_date`, `calculate_age`, `custom_sql`, `match:merge`, `combine:*`, `scrub:redact` | Create snapshot before execution. Undo = restore from snapshot. |

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

## File Structure

```
src/lib/commands/
├── types.ts              # All interfaces
├── registry.ts           # CommandRegistry.create(type, params)
├── executor.ts           # CommandExecutor class (3-tier undo logic)
├── context.ts            # buildCommandContext(tableId)
├── column-versions.ts    # ColumnVersionManager for Tier 1 undo
├── diff-views.ts         # DiffViewManager for v_diff_step_X views
├── utils/
│   ├── sql.ts            # escapeSqlString(), quoteColumn(), quoteTable()
│   └── date.ts           # DATE_FORMATS[], buildDateParseExpression()
├── transform/
│   ├── base.ts           # BaseTransformCommand (abstract)
│   ├── tier1/            # 10 commands (trim, lowercase, etc.)
│   ├── tier2/            # rename-column.ts
│   └── tier3/            # 11 commands (remove-duplicates, split-column, etc.)
├── standardize/          # TODO: apply.ts
├── match/                # TODO: merge.ts
├── combine/              # TODO: stack.ts, join.ts
├── scrub/                # TODO: hash.ts, mask.ts, redact.ts
└── edit/                 # TODO: cell.ts, batch.ts
```

---

## Performance Guardrails (2M Rows)

| Constraint | Implementation |
|------------|----------------|
| **Zero JS row loops** | All commands use SQL only |
| **Tier 1 Undo** | Metadata-only, instant regardless of row count |
| **Tier 3 Snapshots** | Limited to 5 per timeline, pruned LRU |
| **Lazy Highlighting** | SQL predicate injected into virtualized queries |
| **Diff Views** | DuckDB views, not materialized tables |

---

## Implementation Status

### ✅ Phase 1: Core Infrastructure - COMPLETE
### ✅ Phase 1.5: Diff View Foundation - COMPLETE
### ✅ Phase 2: Transform Commands - COMPLETE (22/22)

| Tier | Commands |
|------|----------|
| Tier 1 | trim, lowercase, uppercase, title_case, remove_accents, sentence_case, collapse_spaces, remove_non_printable, replace, replace_empty |
| Tier 2 | rename_column |
| Tier 3 | remove_duplicates, cast_type, custom_sql, split_column, combine_columns, standardize_date, calculate_age, unformat_currency, fix_negatives, pad_zeros, fill_down |

---

## ✅ Phase 2.5: UI Integration - COMPLETE

**Status**: Implemented on 2026-01-22

**Changes Made**:
1. Updated `CleanPanel.tsx` imports to use command system
2. Replaced `executeTransformation()` logic with `CommandExecutor.execute()`
3. Fixed column versioning to use CTAS pattern (DuckDB WASM doesn't support computed columns after table creation)
4. Removed manual audit logging (handled by executor)
5. Removed manual timeline recording (handled by executor)

**DuckDB WASM Limitation Found**: `ALTER TABLE ADD COLUMN ... AS (expression)` is not supported. Fixed by using Create Table As Select (CTAS) pattern instead.

**Previous Problem**: The command system was fully built but **completely disconnected from the UI**. The application used the legacy `applyTransformation()` function.

### Implementation Steps

**Step 1: Update CleanPanel.tsx imports**
```typescript
import {
  createCommand,
  getCommandExecutor,
  getCommandTypeFromTransform
} from '@/lib/commands'
```

**Step 2: Replace executeTransformation() logic** (lines ~103-176)

```typescript
// 1. Get command type
const commandType = getCommandTypeFromTransform(selectedTransform.id)
if (!commandType) {
  throw new Error(`Unknown transformation type: ${selectedTransform.id}`)
}

// 2. Build command with params
const command = createCommand(commandType, {
  tableId: activeTable.id,
  column: selectedTransform.requiresColumn ? selectedColumn : undefined,
  ...params,
})

// 3. Execute through CommandExecutor
const executor = getCommandExecutor()
const result = await executor.execute(command, {
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.progress}%`)
  }
})

// 4. Handle result
if (!result.success) {
  throw new Error(result.error || 'Transformation failed')
}

// 5. Update table store (executor handles audit + timeline)
if (result.executionResult) {
  updateTable(activeTable.id, {
    rowCount: result.executionResult.rowCount,
    columns: result.executionResult.columns,
  })
}
```

**Step 3: Remove manual audit/timeline code** (handled by CommandExecutor)

**Step 4: Handle validation errors**
```typescript
if (!result.success && result.validationResult) {
  const errors = result.validationResult.errors.map(e => e.message).join(', ')
  toast.error('Validation Failed', { description: errors })
  return
}
```

### Verification
1. Load a CSV file
2. Apply `Trim Whitespace` → verify audit log entry
3. Apply `Lowercase` on same column → verify expression chaining works

---

## 🔲 Phase 3: Standardizer & Matcher

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
src/lib/commands/standardize/apply.ts
src/lib/commands/match/merge.ts
```

**StandardizeAuditDetails structure:**
```typescript
interface StandardizeAuditDetails {
  type: 'standardize'
  column: string
  algorithm: 'fingerprint' | 'metaphone'
  clusterCount: number
  clusters: Record<string, { master: string; members: string[] }>
}
```

---

## 🔲 Phase 4: Combiner & Scrubber

**Commands to implement:**

| Command | Tier | Description |
|---------|------|-------------|
| `combine:stack` | 3 | UNION ALL tables with column alignment |
| `combine:join` | 3 | JOIN tables (inner/left/right/full) |
| `scrub:hash` | 1 | SHA-256 with project secret |
| `scrub:mask` | 1 | Partial value masking (e.g., `***-**-1234`) |
| `scrub:redact` | 3 | Full PII redaction (snapshot required - data destroyed) |
| `scrub:year_only` | 3 | Date → year only |

**Files to create:**
```
src/lib/commands/combine/stack.ts
src/lib/commands/combine/join.ts
src/lib/commands/scrub/hash.ts
src/lib/commands/scrub/mask.ts
src/lib/commands/scrub/redact.ts
src/lib/commands/scrub/year-only.ts
```

**Scrub hash expression (Tier 1):**
```typescript
// Uses project secret for consistent hashing
getTransformExpression(ctx: CommandContext): string {
  const secret = ctx.project?.secret ?? ''
  return `SHA256(CONCAT(${COLUMN_PLACEHOLDER}, '${escapeSqlString(secret)}'))`
}
```

---

## 🔲 Phase 5: Unify Undo/Redo

**Commands to implement:**

| Command | Tier | Description |
|---------|------|-------------|
| `edit:cell` | 2 | Single cell edit with inverse SQL |
| `edit:batch` | 2 | Multiple cell edits |

**Key changes:**
- DataGrid.tsx calls `CommandExecutor.undo()` for all operations
- Undo automatically uses correct tier strategy
- Deprecate `editStore.ts`

**Files to modify:**
```
src/components/grid/DataGrid.tsx  - Wire Ctrl+Z/Y to CommandExecutor
src/stores/editStore.ts           - Deprecate
src/lib/commands/edit/cell.ts     - NEW
src/lib/commands/edit/batch.ts    - NEW
```

**Edit command structure:**
```typescript
interface EditCellParams {
  tableId: string
  rowId: string      // _cs_id value
  column: string
  newValue: unknown
  previousValue: unknown  // For inverse SQL
}

// Tier 2 - inverseSql is just the reverse UPDATE
getInvertibility(): InvertibilityInfo {
  return {
    tier: 2,
    inverseSql: `UPDATE "${table}" SET "${col}" = ${escape(prevValue)} WHERE "_cs_id" = '${rowId}'`,
    undoStrategy: 'Execute inverse UPDATE'
  }
}
```

---

## 🔲 Phase 6: Performance Optimization

- **Snapshot pruning**: Max 5 Tier 3 snapshots per table, LRU eviction
- **Column version cleanup**: Prune `__base` columns after 10 steps
- **Diff view materialization**: For complex predicates on 2M+ rows
- **Intermediate diff views**: Generate Expression[N-1] from `expressionStack.slice(0, -1)`

**Snapshot pruning policy:**
```typescript
interface TimelineCommandRecord {
  // ... existing fields
  undoDisabled?: boolean  // True if snapshot was pruned
  undoDisabledReason?: string
}

// When 6th Tier 3 operation executes:
// 1. Delete oldest snapshot
// 2. Mark corresponding command as undoDisabled: true
// 3. UI shows "Undo unavailable - snapshot pruned"
```

---

## Design Notes (Reference)

### Expression Chaining (Tier 1) - CTAS Pattern

Instead of multiple backup columns, chain expressions on a single base column.

**Note**: DuckDB WASM doesn't support `ADD COLUMN ... AS (expression)` after table creation.
We use Create Table As Select (CTAS) pattern instead:

```sql
-- Step 1: trim (first transform - create base column)
CREATE TABLE temp AS SELECT
  col1, col2,
  "Email" AS "Email__base",  -- backup original
  TRIM("Email") AS "Email"   -- transformed with original name
FROM "data";
DROP TABLE "data";
ALTER TABLE temp RENAME TO "data";

-- Step 2: lowercase (chained transform - rebuild with nested expression)
CREATE TABLE temp AS SELECT
  col1, col2,
  "Email__base",             -- keep base column
  LOWER(TRIM("Email__base")) AS "Email"  -- nested expression
FROM "data";
DROP TABLE "data";
ALTER TABLE temp RENAME TO "data";

-- Undo lowercase (revert to previous expression)
CREATE TABLE temp AS SELECT
  col1, col2,
  "Email__base",
  TRIM("Email__base") AS "Email"
FROM "data";
DROP TABLE "data";
ALTER TABLE temp RENAME TO "data";

-- Undo trim (full restore - drop base, restore original)
CREATE TABLE temp AS SELECT
  col1, col2,
  "Email__base" AS "Email"   -- restore from base
FROM "data";
DROP TABLE "data";
ALTER TABLE temp RENAME TO "data";
```

**ColumnVersionInfo structure:**
```typescript
interface ColumnVersionInfo {
  originalColumn: string
  baseColumn: string           // Single backup: Email__base
  expressionStack: {
    expression: string         // e.g., "TRIM({{COL}})"
    commandId: string
  }[]
}
```

### Export Handling for Backup Columns

Use metadata flag to hide `__base` columns from export/UI:
```typescript
interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  isHidden?: boolean  // True for backup columns
}
```

### Error Recovery for Expression Rebuild

With CTAS pattern, atomic swap is simpler - if CTAS fails, original table is untouched:
```typescript
async createVersion(tableName, column, expression, commandId) {
  const tempTable = `${tableName}_cv_temp_${Date.now()}`
  try {
    // Build and execute CTAS (original table untouched)
    await db.execute(`CREATE TABLE ${tempTable} AS SELECT ... FROM ${tableName}`)
    // Only now do we swap (atomic)
    await db.execute(`DROP TABLE ${tableName}`)
    await db.execute(`ALTER TABLE ${tempTable} RENAME TO ${tableName}`)
  } catch (error) {
    // Cleanup temp table if it exists (original table untouched)
    await db.execute(`DROP TABLE IF EXISTS ${tempTable}`)
    throw error
  }
}
```

### Tier 3 Diff Views

For deletion operations, LEFT JOIN snapshot to show removed rows:
```sql
CREATE VIEW v_diff_step_2 AS
SELECT
  COALESCE(c."_cs_id", s."_cs_id") as _row_id,
  CASE WHEN c."_cs_id" IS NULL THEN 'removed' ELSE 'unchanged' END as _change_type,
  NULL as _affected_column,
  COALESCE(c.*, s.*)
FROM "_snapshot_before_step_2" s
LEFT JOIN "my_table" c ON s."_cs_id" = c."_cs_id"
```
