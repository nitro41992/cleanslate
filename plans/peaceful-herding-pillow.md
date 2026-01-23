# Command Pattern Architecture Migration Plan

## Progress Summary

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Complete | Core Infrastructure (types, registry, executor, context) |
| 1.5 | ✅ Complete | Diff View Foundation |
| 2 | ✅ Complete | 22 Transform Commands (Tier 1/2/3) |
| 2.5 | ✅ Complete | UI Integration (CleanPanel.tsx wired to CommandExecutor) |
| 2.6 | ✅ Complete | Fix Hybrid State: Wire App.tsx undo/redo to CommandExecutor |
| 3 | ✅ Complete | Standardizer & Matcher (2 commands) |
| 4 | ✅ Complete | Combiner & Scrubber (6 commands) |
| 5 | 🔲 Pending | Unify Undo/Redo (2 commands + keyboard shortcuts) |
| 6 | 🔲 Pending | Performance Optimization |

**Key Insight from Phase 2.5**: DuckDB WASM doesn't support `ALTER TABLE ADD COLUMN ... AS (expression)`. All Tier 1 commands use CTAS pattern instead.

---

## Three-Tier Undo Strategy (Reference)

| Tier | Strategy | Undo Mechanism |
|------|----------|----------------|
| **Tier 1** | Expression chaining (CTAS) | Single `__base` column + nested expressions |
| **Tier 2** | Invertible SQL | Execute inverse SQL directly |
| **Tier 3** | Full Snapshot | Restore from pre-execution snapshot |

---

## ✅ Phase 2.6: Fix Hybrid State (COMPLETE)

### The Problem (Solved)

**Hybrid State Danger**: CleanPanel.tsx now uses CommandExecutor (write path), but App.tsx still uses legacy `undoTimeline/redoTimeline` functions (undo path):

```
Write Path: CleanPanel → CommandExecutor.execute() → Column Versioning (Tier 1)
Undo Path:  App.tsx → undoTimeline() → Expects snapshot-based undo ❌
```

### Implementation (Jan 2026)

**Hybrid Fallback Approach**: Instead of fully replacing the legacy system, the implementation uses CommandExecutor with legacy fallback:

```
Ctrl+Z → handleUndo():
  1. Check if executor.canUndo(tableId) → use CommandExecutor (for transform commands)
  2. Else fallback to undoTimeline(tableId) → use legacy timeline (for cell edits)
```

This preserves backward compatibility for:
- Cell edits (still using editStore + timelineStore until Phase 5)
- Pre-migration commands recorded in timelineStore

**Key insight**: CommandExecutor.undo() does NOT handle audit logging internally, so the manual `addAuditEntry()` calls in App.tsx are correct and necessary.

### Files Modified

- `src/App.tsx`: Updated `handleUndo`/`handleRedo` callbacks to use CommandExecutor with legacy fallback

### Verification (Passed)

- ✅ `npm run lint` - No errors
- ✅ `npm run build` - Builds successfully
- ✅ `npm test` - FR-A4 undo/redo tests pass
- ✅ Transform undo works via CommandExecutor
- ✅ Cell edit undo works via legacy timeline fallback

---

## ✅ Phase 3: Standardizer & Matcher (COMPLETE)

### Overview

| Command | Tier | Description |
|---------|------|-------------|
| `standardize:apply` | 3 | Apply cluster-based value standardization |
| `match:merge` | 3 | Merge duplicate rows based on fuzzy matching |

Both are Tier 3 commands (require snapshot for undo) because they destructively modify data:
- Standardize: overwrites original values with standardized values
- Merge: deletes rows from the table

### Implementation (Jan 2026)

**Created Commands:**
- `StandardizeApplyCommand` - Wraps `applyStandardization()` from standardizer-engine
- `MatchMergeCommand` - Wraps `mergeDuplicates()` from fuzzy-matcher

**UI Integration:**
- `StandardizeView.tsx` - Now uses `createCommand('standardize:apply', ...)` + `executor.execute()`
- `MatchView.tsx` - Now uses `createCommand('match:merge', ...)` + `executor.execute()`

**Key Implementation Notes:**
- Commands are registered in `src/lib/commands/index.ts`
- Audit logging still requires manual `addTransformationEntry()` call after execution (to add description text)
- Executor handles: snapshot creation, execution, timeline recording

### Files Changed

| Action | File |
|--------|------|
| CREATE | `src/lib/commands/standardize/apply.ts` |
| CREATE | `src/lib/commands/standardize/index.ts` |
| CREATE | `src/lib/commands/match/merge.ts` |
| CREATE | `src/lib/commands/match/index.ts` |
| MODIFY | `src/lib/commands/index.ts` (register commands) |
| MODIFY | `src/features/standardizer/StandardizeView.tsx` (use executor) |
| MODIFY | `src/features/matcher/MatchView.tsx` (use executor) |

### Verification (Passed)

- ✅ `npm run lint` - No errors
- ✅ `npm run build` - Builds successfully
- ✅ `npm test -- --grep "standardize|matcher"` - All 6 tests pass
- ✅ Undo/Redo tests pass

---

### Reference: Original Plan

**Key Insight**: Command types `'standardize:apply'` and `'match:merge'` already exist in `types.ts` and `TIER_3_COMMANDS`. We just need to implement the command classes.

---

### Step 1: Create StandardizeApplyCommand

**File:** `src/lib/commands/standardize/apply.ts`

```typescript
export interface StandardizeApplyParams {
  tableId: string
  column: string
  algorithm: 'fingerprint' | 'metaphone' | 'token_phonetic'
  mappings: StandardizationMapping[]  // from standardizer-engine.ts
}
```

**Implementation:**
- Wraps existing `applyStandardization()` from `@/lib/standardizer-engine`
- `validate()`: Check column exists, mappings non-empty
- `execute()`: Call `applyStandardization(tableName, column, mappings, auditEntryId)`
- `getAuditInfo()`: Return `StandardizeAuditDetails` (already defined in types.ts)
- `getAffectedRowsPredicate()`: Build WHERE clause from affected row IDs

**⚠️ CRITICAL - Audit Fidelity:**
Don't just log "Standardized Column X" — this destroys the record of how data changed.

In `getAuditInfo()`, serialize the **full mappings array** into the `details` JSON:
```typescript
getAuditInfo(ctx: CommandContext, result: ExecutionResult): AuditInfo {
  return {
    action: `Standardize Values in ${this.params.column}`,
    details: {
      column: this.params.column,
      algorithm: this.params.algorithm,
      mappings: this.params.mappings,  // ← CRITICAL: Full cluster→value mappings
      clusterCount: new Set(this.params.mappings.map(m => m.toValue)).size,
      valuesStandardized: this.params.mappings.length,
    },
    rowsAffected: result.affected,
    affectedColumns: [this.params.column],
    hasRowDetails: true,
    auditEntryId: this.auditEntryId,
    isCapped: false,
  }
}
```
This allows the Audit Detail View to reconstruct the cluster visualization later.

**File:** `src/lib/commands/standardize/index.ts` - Export the command

---

### Step 2: Create MatchMergeCommand

**File:** `src/lib/commands/match/merge.ts`

```typescript
export interface MatchMergeParams {
  tableId: string
  matchColumn: string
  pairs: MatchPair[]  // from fuzzy-matcher.ts (only merged pairs processed)
}
```

**Implementation:**
- Wraps existing `mergeDuplicates()` from `@/lib/fuzzy-matcher`
- `validate()`: Check table exists, has merged pairs
- `execute()`: Call `mergeDuplicates(tableName, pairs, matchColumn, auditEntryId)`
- `getAuditInfo()`: Return `MergeAuditDetails` (already defined in types.ts)
- `getAffectedRowsPredicate()`: Return `null` (deleted rows can't be highlighted)

**⚠️ CRITICAL - The "Invisible Row" Problem:**
Unlike trim or standardize, merge **deletes rows**. This creates unique challenges:

1. **Highlighting Limitation:** `getAffectedRowsPredicate()` returns `null` because you cannot highlight rows that no longer exist in the grid.

2. **Diff View Requirement:** For the Diff View (Phase 1.5) to show "Red" deleted rows, it cannot just query the current table. The Executor must track the **snapshot table name** in metadata.

3. **Diff View SQL Pattern:**
```sql
-- Show deleted rows (exist in snapshot but not in current)
SELECT s.*
FROM _cmd_snapshot_XXX s
LEFT JOIN current_table c ON s._cs_id = c._cs_id
WHERE c._cs_id IS NULL
```

**Implementation Hint:** Ensure `MatchMergeCommand` stores the snapshot table name in its `TimelineCommandRecord` (the executor already does this for Tier 3 commands via `snapshotTable` field).

**File:** `src/lib/commands/match/index.ts` - Export the command

---

### Step 3: Register Commands

**File:** `src/lib/commands/index.ts`

```typescript
// Add imports
import { StandardizeApplyCommand } from './standardize'
import { MatchMergeCommand } from './match'

// Add registrations (after existing registerCommand calls)
registerCommand('standardize:apply', StandardizeApplyCommand)
registerCommand('match:merge', MatchMergeCommand)
```

---

### Step 4: Wire StandardizeView.tsx to CommandExecutor

**File:** `src/features/standardizer/StandardizeView.tsx`

**Changes to `handleApply()`:**
```typescript
// BEFORE: Direct engine calls + manual timeline/audit
await initializeTimeline(tableId, tableName)
const result = await applyChanges()
addTransformationEntry(...)
await recordCommand(...)

// AFTER: CommandExecutor handles everything
import { createCommand, getCommandExecutor } from '@/lib/commands'

const command = createCommand('standardize:apply', {
  tableId,
  column: columnName,
  algorithm,
  mappings: getSelectedMappings(),
})

const executor = getCommandExecutor()
const result = await executor.execute(command)

if (result.success) {
  updateTable(tableId, {})  // Trigger UI refresh
  toast.success(`Standardized ${result.executionResult?.affected || 0} values`)
}
```

**Remove:**
- Calls to `initializeTimeline()`, `recordCommand()` (executor handles timeline)
- Calls to `addTransformationEntry()` (executor handles audit via `getAuditInfo()`)

---

### Step 5: Wire MatchView.tsx to CommandExecutor

**File:** `src/features/matcher/MatchView.tsx`

**Changes to `handleApplyMerges()`:**
```typescript
// BEFORE: Direct merge call + manual audit
const deletedCount = await mergeDuplicates(tableName, pairs, matchColumn, auditEntryId)
addTransformationEntry(...)

// AFTER: CommandExecutor handles everything
import { createCommand, getCommandExecutor } from '@/lib/commands'

const command = createCommand('match:merge', {
  tableId,
  matchColumn,
  pairs: pairs.filter(p => p.status === 'merged'),
})

const executor = getCommandExecutor()
const result = await executor.execute(command)

if (result.success) {
  const deletedCount = result.executionResult?.affected || 0
  updateTable(tableId, { rowCount: (selectedTable?.rowCount || 0) - deletedCount })
  toast.success(`Merged ${deletedCount} duplicate rows`)
}
```

---

### Files Summary

| Action | File |
|--------|------|
| CREATE | `src/lib/commands/standardize/apply.ts` |
| CREATE | `src/lib/commands/standardize/index.ts` |
| CREATE | `src/lib/commands/match/merge.ts` |
| CREATE | `src/lib/commands/match/index.ts` |
| MODIFY | `src/lib/commands/index.ts` (register commands) |
| MODIFY | `src/features/standardizer/StandardizeView.tsx` (use executor) |
| MODIFY | `src/features/matcher/MatchView.tsx` (use executor) |

---

### Verification

1. **Build & Lint:**
   ```bash
   npm run lint && npm run build
   ```

2. **Manual Test - Standardize:**
   - Load CSV with inconsistent values (e.g., "USA", "U.S.A.", "United States")
   - Open Standardize view, cluster by fingerprint
   - Select values to standardize, apply
   - Verify audit log entry with drill-down
   - Press Ctrl+Z → values should revert (Tier 3 snapshot restore)

3. **Manual Test - Merge:**
   - Load CSV with duplicates
   - Open Match view, find duplicates
   - Mark pairs as merged, apply
   - Verify rows deleted, audit log entry
   - Press Ctrl+Z → deleted rows should reappear (Tier 3 snapshot restore)

4. **Run E2E tests:**
   ```bash
   npm test -- --grep "standardize|matcher"
   ```

---

## ✅ Phase 4: Combiner & Scrubber Commands (COMPLETE)

### Implementation (Jan 2026)

Implemented 6 commands wrapping existing functionality. Feature additions (Right Join, Secret Persistence, Key Map Import) are deferred.

**Key Behavior Change - Scrubber:**
- Previous: Created a new `{tableName}_scrubbed` table
- Now: Modifies columns IN PLACE on source table (enables per-column undo/redo)

**Files Created:**
- `src/lib/commands/combine/stack.ts` - CombineStackCommand (Tier 2)
- `src/lib/commands/combine/join.ts` - CombineJoinCommand (Tier 2)
- `src/lib/commands/combine/index.ts`
- `src/lib/commands/scrub/hash.ts` - ScrubHashCommand (Tier 1)
- `src/lib/commands/scrub/mask.ts` - ScrubMaskCommand (Tier 1)
- `src/lib/commands/scrub/redact.ts` - ScrubRedactCommand (Tier 3)
- `src/lib/commands/scrub/year-only.ts` - ScrubYearOnlyCommand (Tier 3)
- `src/lib/commands/scrub/index.ts`

**Files Modified:**
- `src/lib/commands/index.ts` - Register 6 new commands
- `src/lib/commands/registry.ts` - Move combine:* from TIER_3 to TIER_2
- `src/components/panels/CombinePanel.tsx` - Use CommandExecutor
- `src/components/panels/ScrubPanel.tsx` - Use CommandExecutor with per-column commands
- `e2e/tests/feature-coverage.spec.ts` - Update tests for new behavior

### Verification (Passed)

- ✅ `npm run lint` - No errors
- ✅ `npm run build` - Builds successfully
- ✅ FR-D2 Scrubber tests pass (hash, mask, redact, year_only)
- ✅ FR-E1 Stack test passes
- ✅ FR-E2 Join test passes (flaky timing issue when run in parallel)

---

### Reference: Original Plan

### Commands Implemented (6 total)

| Command | Tier | Description |
|---------|------|-------------|
| `combine:stack` | **2** | Stack tables (UNION ALL) - creates new table |
| `combine:join` | **2** | Join tables - creates new table |
| `scrub:hash` | 1 | Hash column in-place with MD5 + secret |
| `scrub:mask` | 1 | Mask column in-place (J***n) |
| `scrub:redact` | 3 | Replace with [REDACTED] |
| `scrub:year_only` | 3 | Extract year from dates |

**⚠️ CRITICAL - Combine Commands are Tier 2, NOT Tier 3:**
- Tier 3 snapshots the active table before modification
- Combine creates a NEW table - the source tables are NOT modified
- Snapshotting 1GB Table A before stacking is wasteful
- **Undo Logic:** `DROP TABLE "resultTable"` - simple inverse SQL, no snapshot needed

---

### Part A: Combine Commands (Tier 2)

**Key Insight:** Combine commands CREATE NEW TABLES, not modify existing ones:
- Source tables A and B are UNCHANGED
- Result table C is newly created
- **Undo = `DROP TABLE "C"`** - simple inverse SQL, no snapshot needed
- This is why Combine is Tier 2, not Tier 3

#### Step A1: Create CombineStackCommand

**File:** `src/lib/commands/combine/stack.ts`

```typescript
export interface CombineStackParams {
  tableId: string        // Source table A (for context building)
  sourceTableA: string   // Table A name
  sourceTableB: string   // Table B name
  resultTableName: string
}
```

**Implementation:**
- Extend `Tier2TransformCommand`
- `execute()`: Call `stackTables(sourceTableA, sourceTableB, resultTableName)`
- `getInverseSql()`: Return `DROP TABLE IF EXISTS "${resultTableName}"`
- `getAuditInfo()`: Return `CombineAuditDetails` with operation='stack'
- `getAffectedRowsPredicate()`: Return `null` (new table created)

**Undo Behavior:**
```typescript
getInverseSql(ctx: CommandContext): string {
  return `DROP TABLE IF EXISTS "${this.params.resultTableName}"`
}

getInvertibility(): InvertibilityInfo {
  return {
    tier: 2,
    undoStrategy: 'Drop created table',
    inverseSql: `DROP TABLE IF EXISTS "${this.params.resultTableName}"`,
  }
}
```

**⚠️ Audit Logging Note:** The executor runs in context of source table A, but audit entry should go to result table C. Manual `addTransformationEntry()` in CombinePanel.tsx is required (see Step A3).

#### Step A2: Create CombineJoinCommand

**File:** `src/lib/commands/combine/join.ts`

```typescript
export interface CombineJoinParams {
  tableId: string        // Left table (for context building)
  leftTableName: string
  rightTableName: string
  keyColumn: string
  joinType: 'inner' | 'left' | 'full_outer'
  resultTableName: string
}
```

**Implementation:**
- Extend `Tier2TransformCommand` (same pattern as Stack)
- `execute()`: Call `joinTables(left, right, keyColumn, joinType, resultName)`
- `getInverseSql()`: Return `DROP TABLE IF EXISTS "${resultTableName}"`
- Undo drops the result table - source tables unchanged

#### Step A3: Wire CombinePanel.tsx

**Current flow (handleStack):**
```typescript
const result = await stackTables(tableA.name, tableB.name, resultTableName)
const columns = await getTableColumns(resultTableName)
const newId = generateId()
addTable({ id: newId, name: resultTableName, ... })
setActiveTableId(newId)
```

**New flow:**
```typescript
const command = createCommand('combine:stack', {
  tableId: tableA.id,
  sourceTableA: tableA.name,
  sourceTableB: tableB.name,
  resultTableName,
})
const result = await executor.execute(command)

if (result.success) {
  // Add audit entry
  addTransformationEntry({
    tableId: newTableId,  // From result
    tableName: resultTableName,
    action: 'Stack Tables',
    details: `Stacked "${tableA.name}" + "${tableB.name}"`,
    rowsAffected: result.executionResult?.rowCount || 0,
    hasRowDetails: false,
    auditEntryId: result.auditInfo?.auditEntryId,
  })
  // Add table to store & set active
}
```

---

### Part B: Scrub Commands

**Key Insight:** Current scrubber creates a NEW table (`{name}_scrubbed`). For command pattern, we want **in-place column transformations** that can be undone.

**Behavior Change:** Scrub commands will modify columns IN PLACE on the source table, not create new tables. This enables:
- Per-column undo/redo
- Tier 1 expression chaining for hash/mask
- Tier 3 snapshots for destructive operations

#### Step B1: Create ScrubHashCommand (Tier 1)

**File:** `src/lib/commands/scrub/hash.ts`

```typescript
export interface ScrubHashParams extends BaseTransformParams {
  column: string
  secret: string  // CRITICAL: Passed from UI, not read from store
}
```

**Implementation:**
- Extend `Tier1TransformCommand`
- `getTransformExpression()`: Return `MD5(CONCAT({{COL}}, '${escapedSecret}'))`
- Uses expression chaining - hash can be "undone" by restoring from `__base` column

**⚠️ CRITICAL - Secrets in Params:**
```typescript
// The UI reads secret from store and passes it:
const command = createCommand('scrub:hash', {
  tableId,
  column: 'ssn',
  secret: scrubberStore.getState().secret,  // Embedded in command
})
```

#### Step B2: Create ScrubMaskCommand (Tier 1)

**File:** `src/lib/commands/scrub/mask.ts`

```typescript
export interface ScrubMaskParams extends BaseTransformParams {
  column: string
  preserveFirst: number  // Default 1
  preserveLast: number   // Default 1
}
```

**Implementation:**
- `getTransformExpression()`:
```sql
CONCAT(
  LEFT({{COL}}, 1),
  REPEAT('*', GREATEST(0, LENGTH({{COL}}) - 2)),
  RIGHT({{COL}}, 1)
)
```

#### Step B3: Create ScrubRedactCommand (Tier 3)

**File:** `src/lib/commands/scrub/redact.ts`

```typescript
export interface ScrubRedactParams extends BaseTransformParams {
  column: string
  replacement: string  // Default '[REDACTED]'
}
```

**Implementation:**
- Extend `Tier3TransformCommand` (requires snapshot)
- Simple UPDATE: `SET column = '[REDACTED]' WHERE column IS NOT NULL`
- Original data destroyed - only snapshot restore can undo

#### Step B4: Create ScrubYearOnlyCommand (Tier 3)

**File:** `src/lib/commands/scrub/year-only.ts`

```typescript
export interface ScrubYearOnlyParams extends BaseTransformParams {
  column: string
}
```

**Implementation:**
- Extend `Tier3TransformCommand`
- Expression: `DATE_TRUNC('year', TRY_CAST({{COL}} AS DATE))`
- Precision lost - requires snapshot for undo

#### Step B5: Wire ScrubPanel.tsx

**Current approach:** Batch all rules, create new table
**New approach:** Execute one command per column, modify in place

```typescript
// For each rule in rules array:
for (const rule of rules) {
  const commandType = getCommandTypeForMethod(rule.method)
  const command = createCommand(commandType, {
    tableId,
    column: rule.column,
    secret: scrubberStore.getState().secret,  // For hash
  })
  await executor.execute(command)
}
// All columns modified in place, all undoable
```

**Design Decision - Per-Column Granularity:**
- Each scrub rule creates one command → one undo entry
- If user applies 5 rules, they get 5 undo entries (Ctrl+Z 5 times to fully revert)
- This is acceptable for Phase 4 - keeps scope manageable, simplifies error handling
- CompositeCommand/batching can be added in future if needed

---

### Files Summary

| Action | File |
|--------|------|
| CREATE | `src/lib/commands/combine/stack.ts` |
| CREATE | `src/lib/commands/combine/join.ts` |
| CREATE | `src/lib/commands/combine/index.ts` |
| CREATE | `src/lib/commands/scrub/hash.ts` |
| CREATE | `src/lib/commands/scrub/mask.ts` |
| CREATE | `src/lib/commands/scrub/redact.ts` |
| CREATE | `src/lib/commands/scrub/year-only.ts` |
| CREATE | `src/lib/commands/scrub/index.ts` |
| MODIFY | `src/lib/commands/index.ts` (register 6 commands) |
| MODIFY | `src/lib/commands/registry.ts` (move combine:* from TIER_3 to TIER_2) |
| MODIFY | `src/components/panels/CombinePanel.tsx` (use executor) |
| MODIFY | `src/components/panels/ScrubPanel.tsx` (use executor, per-column) |

---

### Verification

1. **Build & Lint:**
   ```bash
   npm run lint && npm run build
   ```

2. **Run existing E2E tests:**
   ```bash
   npm test -- --grep "combiner|scrubber"
   ```

3. **Manual Test - Combine Stack:**
   - Load two CSVs
   - Open Combine panel, select Stack
   - Apply → new table created
   - Verify audit log entry
   - Ctrl+Z → result table should be removed

4. **Manual Test - Scrub Hash:**
   - Load CSV with PII column
   - Open Scrub panel, set secret
   - Apply hash to one column
   - Verify column is hashed
   - Ctrl+Z → original values restored (via __base column)

---

## 🔲 Phase 5: Unify Undo/Redo

**Commands to implement:**

| Command | Tier | Description |
|---------|------|-------------|
| `edit:cell` | 2 | Single cell edit with inverse SQL |
| `edit:batch` | 2 | Multiple cell edits |

**Key changes:**
- `DataGrid.tsx` Ctrl+Z/Y → `CommandExecutor.undo()/redo()`
- All operations share single undo stack
- Deprecate `editStore.ts`

**Files:**
```
src/lib/commands/edit/cell.ts     # NEW - Tier 2 with inverse SQL
src/lib/commands/edit/batch.ts    # NEW - Tier 2 with inverse SQL
src/components/grid/DataGrid.tsx  # Wire keyboard shortcuts
src/stores/editStore.ts           # DEPRECATE
```

---

## 🔲 Phase 6: Performance Optimization

| Optimization | Implementation |
|--------------|----------------|
| Snapshot pruning | Max 5 Tier 3 snapshots per table, LRU eviction |
| Column cleanup | Prune `__base` columns after 10 steps |
| Diff materialization | For complex predicates on 2M+ rows |
| Hidden columns | Filter `__base` columns from export/UI |

---

## Verification Plan

After each phase, verify:

1. **Run E2E tests**: `npm test`
2. **Manual smoke test**:
   - Load CSV → Apply transformations → Verify audit log
   - Ctrl+Z/Y → Verify undo/redo works
   - Export CSV → Verify `__base` columns hidden
3. **Performance check**: Load 100k row CSV, apply transforms, verify < 2s

---

## Design Notes (Reference)

### CTAS Pattern (DuckDB WASM Limitation)

DuckDB WASM doesn't support `ALTER TABLE ADD COLUMN ... AS (expression)`.
All Tier 1 commands use Create Table As Select pattern:

```sql
-- Transform: CREATE temp with transformed column, DROP original, RENAME temp
-- Undo: Recreate with previous expression or restore from __base column
```

### Key Architecture Decisions

1. **Expression chaining**: Single `__base` column, nested SQL expressions
2. **Tier classification**: Based on reversibility, not complexity
3. **Audit logging**: Handled by CommandExecutor, not individual commands
4. **Timeline**: Per-table command history with snapshot references
