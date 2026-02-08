# Fix: Recipe Replay Type Mismatch + Persistence Race on Large Tables

## Context

When running a recipe on a 1M+ row table, two issues surface:

1. **Type mismatch crash**: The `replace` command uses `REGEXP_REPLACE()` for case-insensitive find-and-replace. DuckDB requires VARCHAR inputs for this function — it won't auto-cast from DOUBLE. When a recipe recorded on a VARCHAR column is replayed against a DOUBLE column (e.g., "Age"), the transform crashes.

2. **Persistence race condition**: The shard transform system drops the live DuckDB table to free ~500MB of memory, then processes shards one-by-one from OPFS. During this window (can be 30-120s), the persistence auto-save subscription fires and tries to export the nonexistent table, causing cascading "table does not exist" errors.

---

## Fix 1: Cast to VARCHAR in String Function Paths

### File: `src/lib/commands/transform/tier1/replace.ts`

**`getTransformExpression()`** — Add `CAST(... AS VARCHAR)` wrapping on the column placeholder for all 4 branches (exact/contains × case-sensitive/insensitive):

```typescript
const castCol = `CAST(${COLUMN_PLACEHOLDER} AS VARCHAR)`
```

Use `castCol` instead of `col` in:
- Line 43: exact + case-sensitive CASE expression
- Line 45: exact + case-insensitive LOWER comparison
- Line 50: contains + case-sensitive REPLACE call
- Line 61: contains + case-insensitive REGEXP_REPLACE call

**`getAffectedRowsPredicate()`** — Same casting for the WHERE predicate:

```typescript
const castCol = `CAST(${col} AS VARCHAR)`
```

Use in lines 75, 77, 82, 84 (all string comparisons: `=`, `LOWER()`, `LIKE`).

**`execute()` batch mode** — Same pattern with quoted column:

```typescript
const castCol = `CAST("${col}" AS VARCHAR)`
```

Use `castCol` in the batch `expr` (lines 101-117) and update the sample predicate at line 121 to also use the cast.

**Reference**: `replace-empty.ts` already uses this exact `CAST(... AS VARCHAR)` pattern (lines 27, 36, 45).

### Files: `collapse-spaces.ts`, `remove-non-printable.ts`

Same mechanical fix — wrap column references with `CAST(... AS VARCHAR)` in `getTransformExpression()`, `getAffectedRowsPredicate()`, and `execute()` batch mode. These also use `REGEXP_REPLACE` and have the same vulnerability.

---

## Fix 2: Suppress Auto-Save During Shard Transform

### File: `src/lib/commands/batch-utils.ts`

**Location**: `runShardTransform()`, before line 329 (the `DROP TABLE` statement).

**Change**: Call `markTableAsRecentlySaved()` to suppress persistence auto-save for the duration of the shard transform:

```typescript
// Suppress auto-save: table is about to be dropped and rebuilt via shards.
// Output is written directly to OPFS (snapshotAlreadySaved=true), so
// persistence doesn't need to re-export.
const { markTableAsRecentlySaved } = await import('@/hooks/usePersistence')
markTableAsRecentlySaved(ctx.table.id, 120_000) // 2 min window for large tables
```

**Why this works**: `markTableAsRecentlySaved` sets a timestamp in a module-level Map. When the persistence subscription fires, it checks `wasRecentlySaved()` and skips the save if within the window. This pattern is already used by `timeline-engine.ts` (lines 492-493, 550-551).

**Why 120s**: 1M+ row tables with 20 shards can take 2-5 minutes. 120s covers most cases; if it expires mid-transform, the worst case is a harmless save failure that retries after the table is rebuilt.

---

## Implementation Sequence

1. Fix `replace.ts` — add CAST wrapping to all 4 methods
2. Fix `collapse-spaces.ts` and `remove-non-printable.ts` — same pattern
3. Fix `batch-utils.ts` — add `markTableAsRecentlySaved` before DROP
4. Run existing E2E tests to verify no regressions

## Critical Files

| File | Change |
|------|--------|
| `src/lib/commands/transform/tier1/replace.ts` | Add `CAST(... AS VARCHAR)` to all string function paths |
| `src/lib/commands/transform/tier1/collapse-spaces.ts` | Same CAST pattern |
| `src/lib/commands/transform/tier1/remove-non-printable.ts` | Same CAST pattern |
| `src/lib/commands/batch-utils.ts` | Add `markTableAsRecentlySaved` before table DROP |

## Verification

1. Build passes: `npm run build`
2. E2E suite: `npm run test`
3. Manual: Apply "Find & Replace" (case-insensitive) on a DOUBLE column — should succeed instead of crashing
