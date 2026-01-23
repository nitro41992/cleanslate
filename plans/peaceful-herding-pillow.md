# Command Pattern Architecture Migration Plan

## Progress Summary

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Complete | Core Infrastructure (types, registry, executor, context) |
| 1.5 | ✅ Complete | Diff View Foundation |
| 2 | ✅ Complete | 22 Transform Commands (Tier 1/2/3) |
| 2.5 | ✅ Complete | UI Integration (CleanPanel.tsx wired to CommandExecutor) |
| **2.6** | 🔴 **CRITICAL** | **Fix Hybrid State: Wire App.tsx undo/redo to CommandExecutor** |
| 3 | 🔲 Pending | Standardizer & Matcher (2 commands) |
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

## 🔴 Phase 2.6: Fix Hybrid State (CRITICAL)

### The Problem

**Hybrid State Danger**: CleanPanel.tsx now uses CommandExecutor (write path), but App.tsx still uses legacy `undoTimeline/redoTimeline` functions (undo path):

```
Write Path: CleanPanel → CommandExecutor.execute() → Column Versioning (Tier 1)
Undo Path:  App.tsx → undoTimeline() → Expects snapshot-based undo ❌
```

Tier 1 commands use Column Versioning (CTAS with `__base` columns), NOT snapshots. The legacy `undoTimeline()` expects snapshots, so **undo will fail silently or produce incorrect results**.

### The Fix

**File to modify:** `src/App.tsx`

**Changes:**

1. Replace import:
```typescript
// OLD
import { undoTimeline, redoTimeline } from '@/lib/timeline-engine'

// NEW
import { getCommandExecutor } from '@/lib/commands'
```

2. Update `handleUndo` callback:
```typescript
const handleUndo = useCallback(async () => {
  if (!activeTableId || isReplaying) return

  try {
    const executor = getCommandExecutor()
    const result = await executor.undo(activeTableId)

    if (result.success) {
      // Table store is updated automatically by CommandExecutor
      if (activeTable) {
        addAuditEntry(
          activeTableId,
          activeTable.name,
          'Undo',
          'Reverted to previous state',
          'A'
        )
      }
    }
    refreshMemory()
  } catch (error) {
    console.error('[UNDO] Error:', error)
  }
}, [activeTableId, activeTable, isReplaying, addAuditEntry, refreshMemory])
```

3. Update `handleRedo` callback:
```typescript
const handleRedo = useCallback(async () => {
  if (!activeTableId || isReplaying) return

  try {
    const executor = getCommandExecutor()
    const result = await executor.redo(activeTableId)

    if (result.success) {
      // Table store is updated automatically by CommandExecutor
      if (activeTable) {
        addAuditEntry(
          activeTableId,
          activeTable.name,
          'Redo',
          'Reapplied next state',
          'A'
        )
      }
    }
    refreshMemory()
  } catch (error) {
    console.error('[REDO] Error:', error)
  }
}, [activeTableId, activeTable, isReplaying, addAuditEntry, refreshMemory])
```

4. Remove unused `updateTable` from callback dependencies (CommandExecutor handles store updates).

### Verification

After implementing Phase 2.6:

1. `npm run dev` - Start dev server
2. Load a CSV file
3. Apply **Trim Whitespace** (Tier 1 command)
4. Press **Ctrl+Z** - Column should revert instantly via Column Versioning
5. Press **Ctrl+Y** - Column should be re-transformed
6. Run `npm test` - All existing tests should pass

---

## 🔲 Phase 3: Standardizer & Matcher

**Commands to implement:**

| Command | Tier | Description |
|---------|------|-------------|
| `standardize:apply` | 3 | Apply cluster-based value standardization |
| `match:merge` | 3 | Merge duplicate rows based on fuzzy matching |

**Files to create:**
```
src/lib/commands/standardize/apply.ts
src/lib/commands/match/merge.ts
```

**UI Integration:**
- Wire `StandardizerPage.tsx` to use CommandExecutor
- Wire `MatcherPage.tsx` to use CommandExecutor

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
