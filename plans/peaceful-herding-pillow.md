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
| 4 | 🔲 Pending | Combiner & Scrubber (6 commands) |
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

## 🔲 Phase 4: Combiner & Scrubber (FEATURE COMPLETE)

### Current State Analysis

**Combiner (`src/lib/combiner-engine.ts`):**
| Feature | Status | Notes |
|---------|--------|-------|
| Stack (UNION ALL) | ✅ Working | E2E tested, validation works |
| Inner Join | ✅ Working | E2E tested |
| Left Join | ✅ Working | E2E tested |
| Full Outer Join | 🔶 Code exists | No E2E test |
| Right Join | ❌ Missing | Not implemented |
| Clean-First Guardrail | 🔶 Code exists | `autoCleanKeys()` works, no test |
| Audit Trail | ❌ Missing | Not integrated |
| Undo/Redo | ❌ Missing | Not integrated |

**Scrubber (`src/lib/obfuscation.ts`):**
| Feature | Status | Notes |
|---------|--------|-------|
| Hash (SHA-256) | ✅ Working | E2E tested, uses Web Crypto API |
| Redact | ✅ Working | E2E tested |
| Mask | ✅ Working | E2E tested, first/last char preserved |
| Year Only | ✅ Working | E2E tested |
| FR-D1: Project Secret | ⚠️ Partial | Works in session, NO persistence |
| FR-D3: Key Map Export | 🔶 Partial | Works for hash only, no import |
| Faker | ✅ Working | Hardcoded fake data |
| Scramble/Last4/ZeroOut | ✅ Working | Numeric methods |
| Jitter | ✅ Working | ±30 days fixed |
| Audit Trail | ❌ Missing | Not integrated with commands |
| Undo/Redo | ❌ Missing | Not integrated |

### Implementation Plan

**Step 1: Create Combine Commands** (wrap existing engine)
```
src/lib/commands/combine/
├── stack.ts    # Tier 3 - wraps combiner-engine.stackTables()
├── join.ts     # Tier 3 - wraps combiner-engine.joinTables()
└── index.ts
```

**Step 2: Create Scrub Commands** (wrap existing obfuscation)
```
src/lib/commands/scrub/
├── hash.ts       # Tier 1 - expression chaining with secret
├── mask.ts       # Tier 1 - expression chaining
├── redact.ts     # Tier 3 - snapshot (data destroyed)
├── year-only.ts  # Tier 3 - snapshot (precision lost)
└── index.ts
```

**Step 3: Complete Missing Features**
| Feature | Implementation |
|---------|----------------|
| Right Join | Add to `joinTables()` and UI dropdown |
| FR-D1 Secret Persistence | Save to OPFS/localStorage, recall on panel open |
| FR-D3 Key Map Import | Add import button, apply saved mappings |

**Step 4: Wire UI to Command System**
- `CombinePanel.tsx` → use `CommandExecutor` instead of direct engine calls
- `ScrubPanel.tsx` → use `CommandExecutor` instead of direct obfuscation calls

**Step 5: Add E2E Tests**
- Full Outer Join test
- Right Join test
- Clean-First guardrail test
- Secret persistence test
- Key Map export/import test

### Scrub Command Details

**⚠️ CRITICAL - Secrets Management for scrub:hash:**

Commands must be **stateless and replayable**. Do NOT read the "Project Secret" from a global store inside `hash.ts`.

**The Rule:** Pass the secret as a **parameter** to the Command constructor.
- The UI (`ScrubPanel.tsx`) is responsible for reading the secret from the store/OPFS
- The UI passes it to the command factory when creating the command
- This ensures that if you Redo the command later, the secret is embedded in the command payload

```typescript
// WRONG: Reading secret inside command
getTransformExpression(ctx: CommandContext): string {
  const secret = useScrubberStore.getState().projectSecret  // ❌ Non-deterministic
  return `MD5(CONCAT(${col}, '${secret}'))`
}

// RIGHT: Secret passed as parameter
export interface ScrubHashParams extends BaseTransformParams {
  column: string
  secret: string  // ← Passed from UI, embedded in command
}

getTransformExpression(ctx: CommandContext): string {
  return `MD5(CONCAT(${col}, '${this.params.secret}'))`  // ✅ Replayable
}
```

**Tier 1 Commands (Reversible via expression chaining):**
```typescript
// scrub:hash - SHA256 with project secret
getTransformExpression(ctx: CommandContext): string {
  const secret = ctx.project?.secret ?? ''
  // DuckDB has MD5 but not SHA256 - need to use JS-based approach
  // or store key map for reversibility
  return `MD5(CONCAT(${COLUMN_PLACEHOLDER}, '${escapeSqlString(secret)}'))`
}

// scrub:mask - First/last char with asterisks
getTransformExpression(ctx: CommandContext): string {
  return `CONCAT(LEFT(${COLUMN_PLACEHOLDER}, 1), '****', RIGHT(${COLUMN_PLACEHOLDER}, 1))`
}
```

**Tier 3 Commands (Require snapshot):**
- `scrub:redact` - Replaces with `[REDACTED]`, original destroyed
- `scrub:year_only` - Extracts year, day/month precision lost

### Key Files to Modify

```
# Combine Commands
src/lib/commands/combine/stack.ts       # NEW
src/lib/commands/combine/join.ts        # NEW
src/lib/combiner-engine.ts              # Add Right Join support
src/components/panels/CombinePanel.tsx  # Wire to CommandExecutor

# Scrub Commands
src/lib/commands/scrub/hash.ts          # NEW
src/lib/commands/scrub/mask.ts          # NEW
src/lib/commands/scrub/redact.ts        # NEW
src/lib/commands/scrub/year-only.ts     # NEW
src/lib/obfuscation.ts                  # Refactor to support commands
src/stores/scrubberStore.ts             # Add secret persistence
src/components/panels/ScrubPanel.tsx    # Wire to CommandExecutor

# Registry Updates
src/lib/commands/registry.ts            # Register new command types
src/lib/commands/index.ts               # Export new commands
```

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
