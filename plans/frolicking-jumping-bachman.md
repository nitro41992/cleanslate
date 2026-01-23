# Command Pattern Implementation Review

## Summary

Reviewed implementation against `plans/peaceful-herding-pillow.md`. The implementation has a solid foundation (~3,500 LOC) with correct structure, but there are **critical implementation gaps** that need addressing before the code is functional.

---

## ✅ Aligned With Plan

### File Structure (100% Match)
```
src/lib/commands/
├── types.ts              ✅
├── registry.ts           ✅
├── executor.ts           ✅
├── context.ts            ✅
├── column-versions.ts    ✅
├── diff-views.ts         ✅
├── utils/sql.ts          ✅
├── utils/date.ts         ✅
├── transform/base.ts     ✅
├── transform/tier1/*     ✅ (10 commands)
├── transform/tier2/*     ✅ (rename-column)
└── transform/tier3/*     ✅ (4 commands)
```

### Interface Compliance
All required Command interface methods implemented:
- `validate()` ✅
- `execute()` ✅
- `getAuditInfo()` ✅
- `getInvertibility()` ✅
- `getAffectedRowsPredicate()` ✅
- `getDiffViewSql()` (optional) ✅

### Type System
All planned types present with correct structure:
- `CommandType` (28 types defined)
- `CommandContext` with db, table, columnVersions
- `ValidationResult` with `fixAction` for auto-fix
- `ExecutionResult` with schema change tracking
- `AuditDetails` union type (transform/standardize/merge/combine/edit)
- `InvertibilityInfo` with 3-tier metadata
- `HighlightInfo` with SQL predicate support

### Executor Flow (7/8 steps wired)
1. ✅ Validation
2. ✅ Tier determination
3. ✅ Pre-snapshot for Tier 3
4. ✅ Execution
5. ✅ Audit logging
6. ⚠️ Diff view (stubbed)
7. ✅ Timeline recording
8. ✅ Store updates

---

## 🔴 Critical Issues

### 1. Tier 1 Commands NOT Using Column Versioning

**Location:** `src/lib/commands/transform/base.ts:189-195`

**Problem:** The `Tier1TransformCommand.execute()` uses `UPDATE` instead of the column versioning strategy defined in the plan.

```typescript
// Current implementation (WRONG)
const sql = `UPDATE ${this.getQuotedTable(ctx)} SET ${quoteColumn(column)} = ${expression}`
await ctx.db.execute(sql)
```

**Expected (per plan):**
```typescript
const versionManager = createColumnVersionManager(ctx.db, ...)
await versionManager.createVersion(tableName, column, expression, commandId)
```

**Impact:**
- Tier 1 undo is **not instant** (requires snapshot, defeats purpose)
- `column-versions.ts` is **unused** despite being implemented correctly
- Plan's key benefit (zero-copy undo) is **not achieved**

**Fix:** Replace `UPDATE` logic in `Tier1TransformCommand.execute()` with calls to `createColumnVersionManager().createVersion()`

---

### 2. Tier 2 Inverse SQL Not Stored

**Location:** `src/lib/commands/executor.ts:381-424`

**Problem:** `recordTimelineCommand()` doesn't store the inverse SQL from Tier 2 commands.

```typescript
// Current - inverseSql is never populated
const record: TimelineCommandRecord = {
  // ...
  inverseSql: undefined,  // Should call command.getInverseSql(ctx)
}
```

**Impact:** Tier 2 undo for `rename_column` won't work.

**Fix:** Call `command.getInverseSql(ctx)` if tier === 2 and store in record.

---

### 3. Diff View Creation Not Wired

**Location:** `src/lib/commands/executor.ts:172-177`

```typescript
if (!skipDiffView) {
  progress('diffing', 70, 'Creating diff view...')
  // diffViewName = await this.createDiffView(command, ctx, executionResult)  // COMMENTED OUT
}
```

**Impact:** Phase 1.5 (Diff View Foundation) is incomplete. Per plan, this is "the most important phase."

**Fix:** Implement `createDiffView()` method that calls `createTier1DiffView` or `createTier3DiffView` from `diff-views.ts`.

---

### 4. Redo Not Implemented

**Location:** `src/lib/commands/executor.ts:302-326`

```typescript
async redo(tableId: string): Promise<ExecutorResult> {
  // ...
  return {
    success: false,
    error: 'Redo not yet implemented - use timeline replay instead',
  }
}
```

**Impact:** Ctrl+Y broken.

**Fix:** Re-execute command from `TimelineCommandRecord.params` using `createCommand()` from registry.

---

## ⚠️ Moderate Issues

### 5. Missing Tier 3 Commands

**Implemented:** 4 of 11 planned
- ✅ `remove_duplicates`
- ✅ `cast_type`
- ✅ `split_column`
- ✅ `custom_sql`

**Missing:**
- ❌ `combine_columns`
- ❌ `standardize_date`
- ❌ `calculate_age`
- ❌ `unformat_currency`
- ❌ `fix_negatives`
- ❌ `pad_zeros`
- ❌ `fill_down`

**Note:** These are registered in `TIER_3_COMMANDS` but have no command class.

---

### 6. Audit Row Details Not Captured

**Location:** `src/lib/commands/executor.ts:426-442`

The current `recordAudit()` only calls `addTransformationEntry()` but doesn't capture row-level details like the existing `transformations.ts` does with `captureRowDetails()`.

**Impact:** Audit drill-down won't show before/after values.

**Fix:** Add row details capture using the `_audit_details` table pattern.

---

### 7. Commands Not Registered in Registry

The registry has `commandRegistry.set()` calls but commands aren't actually registered at startup.

**Location:** `src/lib/commands/registry.ts:27-37`

**Fix:** Add registration calls in `src/lib/commands/index.ts`:
```typescript
import { TrimCommand } from './transform/tier1/trim'
registerCommand('transform:trim', TrimCommand)
// ... etc
```

---

## 📋 Recommended Fix Priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | #1 Tier 1 column versioning | Medium | Core feature broken |
| **P0** | #7 Register commands | Low | Nothing works without it |
| **P1** | #2 Tier 2 inverse SQL | Low | Undo broken |
| **P1** | #3 Wire diff views | Medium | Phase 1.5 incomplete |
| **P2** | #4 Redo implementation | Medium | UX incomplete |
| **P2** | #6 Audit row details | Medium | Drill-down broken |
| **P3** | #5 Missing Tier 3 commands | High | Feature completeness |

---

## Files to Modify

1. `src/lib/commands/transform/base.ts` - Fix Tier 1 execute()
2. `src/lib/commands/executor.ts` - Store inverse SQL, wire diff views, implement redo
3. `src/lib/commands/index.ts` - Register all commands
4. Add missing Tier 3 command files

---

## Verification Checklist

After fixes:
- [ ] Tier 1 undo is instant (< 100ms regardless of row count)
- [ ] Tier 2 `rename_column` can be undone
- [ ] Tier 3 `remove_duplicates` can be undone via snapshot
- [ ] Diff views are created after each command
- [ ] `createCommand('transform:trim', params)` works
- [ ] Audit log shows row-level details on click
