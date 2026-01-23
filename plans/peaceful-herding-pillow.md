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
| 5 | ✅ Complete | Unify Undo/Redo (edit:cell command + dirty cell tracking) |
| 6 | ✅ Complete | Performance Optimization (6.1-6.3 implemented, 6.4 deferred) |

**Key Insight from Phase 2.5**: DuckDB WASM doesn't support `ALTER TABLE ADD COLUMN ... AS (expression)`. All Tier 1 commands use CTAS pattern instead.

---

## Three-Tier Undo Strategy (Reference)

| Tier | Strategy | Undo Mechanism |
|------|----------|----------------|
| **Tier 1** | Expression chaining (CTAS) | Single `__base` column + nested expressions |
| **Tier 2** | Invertible SQL | Execute inverse SQL directly |
| **Tier 3** | Full Snapshot | Restore from pre-execution snapshot |

---

## Completed Phases Summary

### ✅ Phase 2.6: Fix Hybrid State

**Solution**: CommandExecutor with legacy fallback for backward compatibility.

```
Ctrl+Z → handleUndo():
  1. Check if executor.canUndo(tableId) → use CommandExecutor
  2. Else fallback to undoTimeline(tableId) → legacy timeline
```

**Key insight**: CommandExecutor.undo() does NOT handle audit logging internally - manual `addAuditEntry()` calls in App.tsx are correct and necessary.

---

### ✅ Phase 3: Standardizer & Matcher

| Command | Tier | Description |
|---------|------|-------------|
| `standardize:apply` | 3 | Apply cluster-based value standardization |
| `match:merge` | 3 | Merge duplicate rows based on fuzzy matching |

**Key Notes:**
- Both Tier 3 (require snapshot) because they destructively modify data
- Audit logging still requires manual `addTransformationEntry()` after execution
- **"Invisible Row" Problem**: `match:merge` deletes rows, so `getAffectedRowsPredicate()` returns `null`

---

### ✅ Phase 4: Combiner & Scrubber

| Command | Tier | Description |
|---------|------|-------------|
| `combine:stack` | **2** | Stack tables (UNION ALL) - creates new table |
| `combine:join` | **2** | Join tables - creates new table |
| `scrub:hash` | 1 | Hash column in-place with MD5 + secret |
| `scrub:mask` | 1 | Mask column in-place (J***n) |
| `scrub:redact` | 3 | Replace with [REDACTED] |
| `scrub:year_only` | 3 | Extract year from dates |

**Key Notes:**
- **Combine = Tier 2, NOT Tier 3**: Creates NEW table, source tables unchanged. Undo = `DROP TABLE`.
- **Scrubber behavior change**: Now modifies columns IN PLACE (not new table) for per-column undo/redo.
- **Per-column granularity**: Each scrub rule = one command = one undo entry.
- **Secrets in params**: UI passes secret to command, not read from store (ensures replayability).

---

### ✅ Phase 5: Unify Undo/Redo

| Command | Tier | Description |
|---------|------|-------------|
| `edit:cell` | 2 | Single cell edit with inverse SQL |

**Key Notes:**
- **Hybrid approach maintained**: CommandExecutor for execution, legacy editStore for backward compatibility
- **Type B audit entries**: Created manually (executor handles Type A transformations)
- **Dirty cell tracking**: Merges cells from both CommandExecutor AND legacy timeline
- **Why Tier 2**: Cell edits are truly invertible (`UPDATE ... SET col = previousValue`)
- **O(n) iteration for getDirtyCells()**: Acceptable for Phase 5, optimize in Phase 6 if needed

---

## ✅ Phase 6: Performance Optimization

### Overview

Phase 6 addresses memory efficiency and UX issues in the Command Pattern system.

| Sub-Phase | Status | Description |
|-----------|--------|-------------|
| 6.1 | ✅ Complete | Hide `__base` columns from export/UI |
| 6.2 | ✅ Complete | Snapshot pruning - Max 5 Tier 3 snapshots, LRU eviction |
| 6.3 | ✅ Complete | Column cleanup - Materialize after 10 steps |
| 6.4 | 🔲 Deferred | Diff materialization for 2M+ rows (no reported issues) |

**Key Notes:**
- **6.1**: `filterInternalColumns()` and `isInternalColumn()` now filter `__base` columns
- **6.2**: Commands past the 5-snapshot limit get `undoDisabled=true`, `canUndo()` respects this
- **6.3**: After 10 Tier 1 transforms, column is materialized with identity expression marker; undo past materialization returns "Column was materialized for performance"

---

### Phase 6.1: Hide `__base` Columns from Export/UI

**Problem:** `__base` backup columns (created by Tier 1 transforms) are currently visible in:
- DataGrid column headers
- CSV exports
- Column selection dropdowns

**Root Cause:** `filterInternalColumns()` only filters `_cs_id`, not `__base` columns.

**File:** `src/lib/duckdb/index.ts`

**Change:**
```typescript
// BEFORE (line 21-23):
export function filterInternalColumns(columns: string[]): string[] {
  return columns.filter(col => col !== CS_ID_COLUMN)
}

// AFTER:
export function filterInternalColumns(columns: string[]): string[] {
  return columns.filter(col =>
    col !== CS_ID_COLUMN && !col.endsWith('__base')
  )
}
```

**Verification:**
1. Apply Trim to a column → verify `Name__base` not visible in grid
2. Export CSV → verify `__base` columns not included
3. Undo transform → verify values restored correctly

---

### Phase 6.2: Snapshot Pruning with LRU Eviction

**Problem:** Tier 3 snapshots accumulate indefinitely. After 10 commands: 10x table size in memory.

**Solution:** Max 5 snapshots per table with LRU eviction.

**File:** `src/lib/commands/executor.ts`

**Step 1: Add constant and update interface**
```typescript
const MAX_SNAPSHOTS_PER_TABLE = 5

interface TableCommandTimeline {
  commands: TimelineCommandRecord[]
  position: number
  snapshots: Map<number, string>
  snapshotTimestamps: Map<number, number>  // NEW: for LRU tracking
  originalSnapshot?: string
}
```

**Step 2: Add pruning helper**
```typescript
private async pruneOldestSnapshot(timeline: TableCommandTimeline): Promise<void> {
  if (timeline.snapshots.size <= MAX_SNAPSHOTS_PER_TABLE) return

  // Find oldest by timestamp
  let oldestPosition = -1
  let oldestTimestamp = Infinity

  for (const [pos, ts] of timeline.snapshotTimestamps) {
    if (ts < oldestTimestamp) {
      oldestTimestamp = ts
      oldestPosition = pos
    }
  }

  if (oldestPosition >= 0) {
    const snapshotName = timeline.snapshots.get(oldestPosition)
    if (snapshotName) {
      await dropTable(snapshotName).catch(() => {})
      timeline.snapshots.delete(oldestPosition)
      timeline.snapshotTimestamps.delete(oldestPosition)
    }
  }
}
```

**Step 3: Call pruning after snapshot creation (in execute())**
```typescript
if (needsSnapshot && !skipTimeline) {
  snapshotTableName = await this.createSnapshot(ctx)
  await this.pruneOldestSnapshot(getTimeline(tableId))
}
```

**Step 4: Mark pruned commands as undoDisabled**

When a snapshot is pruned, mark the corresponding command in the timeline:

```typescript
// In pruneOldestSnapshot(), after deleting snapshot:
const command = timeline.commands[oldestPosition]
if (command) {
  command.undoDisabled = true
}
```

**Step 5: Update types.ts**

```typescript
export interface TimelineCommandRecord {
  // ... existing fields ...
  /** Set to true when snapshot was pruned - undo no longer possible */
  undoDisabled?: boolean
}
```

**Step 6: Update undo() to respect undoDisabled**

```typescript
async undo(tableId: string): Promise<ExecutorResult> {
  const commandRecord = timeline.commands[timeline.position]

  if (commandRecord.undoDisabled) {
    return {
      success: false,
      error: 'Undo unavailable: History limit reached',
    }
  }
  // ... rest of undo logic
}
```

**Step 7: Update canUndo() to respect undoDisabled**

```typescript
canUndo(tableId: string): boolean {
  const timeline = tableTimelines.get(tableId)
  if (!timeline || timeline.position < 0) return false

  const cmd = timeline.commands[timeline.position]
  return cmd && !cmd.undoDisabled
}
```

**Why no replay engine:**
- Implementing a robust "Replay Engine" is massive scope creep
- Replaying commands requires perfect determinism
- Replaying might fail if intermediate state relied on external factors
- "Limit 5 Snapshots + disable undo beyond" is standard industry practice

**Verification:**
1. Apply 7 Tier 3 commands → verify only 5 snapshots exist
2. Undo commands 7, 6, 5, 4, 3 → all work (have snapshots)
3. Try to undo command 2 → Toast: "Undo unavailable: History limit reached"

---

### Phase 6.3: Column Cleanup After 10 Steps

**Problem:** After 10+ transforms on a column:
- Expression stack grows large
- Nested SQL expressions become complex
- `__base` column holds stale data

**Solution:** "Materialization checkpoint" after 10 transforms.

**Concept:**
1. After 10th transform, copy computed value back to `__base` column
2. Reset expression stack to single identity expression
3. Store pre-materialization snapshot for undo safety

**File:** `src/lib/commands/types.ts` - Add fields:
```typescript
export interface ColumnVersionInfo {
  originalColumn: string
  baseColumn: string
  expressionStack: ExpressionEntry[]
  // NEW: Materialization checkpoint
  materializationSnapshot?: string
  materializationPosition?: number
}
```

**File:** `src/lib/commands/column-versions.ts`

**Add materialization logic:**
```typescript
const COLUMN_MATERIALIZATION_THRESHOLD = 10

// In createVersion(), after pushing expression:
if (versionInfo.expressionStack.length >= COLUMN_MATERIALIZATION_THRESHOLD) {
  await this.materializeColumn(tableName, column, versionInfo)
}

private async materializeColumn(
  tableName: string, column: string, versionInfo: ColumnVersionInfo
): Promise<void> {
  // Create snapshot for undo safety
  const snapshotName = `_mat_${tableName}_${column}_${Date.now()}`
  await duplicateTable(tableName, snapshotName, true)

  versionInfo.materializationSnapshot = snapshotName
  versionInfo.materializationPosition = versionInfo.expressionStack.length

  // Materialize: copy current value to base
  await db.execute(`UPDATE "${tableName}" SET "${versionInfo.baseColumn}" = "${column}"`)

  // Reset stack to identity
  versionInfo.expressionStack = [{ expression: '{{COL}}', commandId: 'materialized' }]
}
```

**Update undoVersion() to restore from materialization snapshot when needed.**

**Verification:**
1. Apply 12 Tier 1 transforms to same column
2. Verify expression stack was reset (internal check)
3. Undo all 12 → verify original values restored

---

### Phase 6.4: Diff Materialization (Deferred)

**Problem:** Complex predicates on 2M+ row tables may be slow.

**Status:** Deferred - no reported issues yet.

**Future Implementation:** Materialize diff views as temp tables when row count exceeds threshold.

---

### Files Summary

| Sub-Phase | Files to Modify |
|-----------|-----------------|
| 6.1 | `src/lib/duckdb/index.ts` |
| 6.2 | `src/lib/commands/executor.ts` |
| 6.3 | `src/lib/commands/types.ts`, `src/lib/commands/column-versions.ts` |
| 6.4 | Deferred |

---

### Implementation Order

```
Phase 6.1 (Hidden Columns) - No dependencies, simplest
    ↓
Phase 6.2 (Snapshot Pruning) - Independent of 6.1
    ↓
Phase 6.3 (Column Cleanup) - May interact with hidden columns logic
```

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

---

## Phase 6 Implementation Summary (Jan 2026)

### Files Modified

| File | Changes |
|------|---------|
| `src/lib/duckdb/index.ts` | `filterInternalColumns()` and `isInternalColumn()` now filter `__base` columns |
| `src/lib/commands/executor.ts` | Added `MAX_SNAPSHOTS_PER_TABLE`, `snapshotTimestamps`, `pruneOldestSnapshot()`, updated `undo()`/`canUndo()` |
| `src/lib/commands/types.ts` | Added `undoDisabled` to `TimelineCommandRecord`, `materializationSnapshot`/`materializationPosition` to `ColumnVersionInfo` |
| `src/lib/commands/column-versions.ts` | Added `COLUMN_MATERIALIZATION_THRESHOLD`, `materializeColumn()`, materialization boundary detection in `undoVersion()` |

### Behavior Changes

1. **`__base` columns hidden**: No longer visible in grid, exports, or column dropdowns
2. **Snapshot limit enforced**: Max 5 Tier 3 snapshots per table; oldest pruned with LRU
3. **Undo disabled past limit**: `canUndo()` returns false, `undo()` returns "History limit reached"
4. **Column materialization**: After 10 Tier 1 transforms on same column, base is updated and stack reset
5. **Materialization boundary**: Undo past materialization returns "Column was materialized for performance"

### Concurrency Safety (Phase 6.3)

JavaScript/WASM is single-threaded and all DuckDB operations are awaited. No race conditions between `EditCellCommand` and materialization because:
- Materialization only happens during `createVersion()` which is called from command execution
- Cell edits use a different code path (`edit:cell` command via `updateCellByRowId`)
- Both operations complete atomically before any other operation can start

### Redo Behavior (Phase 6.2)

When Redo re-executes a Tier 3 command after its snapshot was pruned:
- The command is re-executed via `execute()` which naturally creates a new snapshot
- No special handling needed - the normal execution flow handles snapshot creation
- The new snapshot gets a new timestamp for LRU tracking
