# Fix: Diff "Compare with Preview" Regression on Shard Branch

## Context

The `feat/arrow-ipc-coi-threading` branch implements the full Zero-Resident Architecture (12 commits, all sprints + phases complete). Everything works **except** the diff "Compare with Preview" mode, which silently fails when using shard-backed snapshots. This is a regression introduced by the Phase 4D dematerialization logic added in commit `f2e1057`.

The diff feature is core functionality — this must be fixed before the branch can merge to master.

---

## Root Cause

**File**: `src/lib/diff-engine.ts`, lines 307-316

**The bug**: `runDiff()` unconditionally calls `dematerializeActiveTable()` at the start of every diff operation. This function DROPs the active table from DuckDB memory (exporting it to OPFS shards) to free ~120MB RAM during the diff.

**Why it breaks preview mode**: In "Compare with Preview" mode, the active table IS the diff target (`tableB`). The sequence:

1. User clicks "Run Comparison" → `handleRunDiff()` fires
2. `setIsComparing(true)` at DiffView.tsx:236
3. `runDiff("parquet:original_fr_b2_base", "fr_b2_base", ...)` enters `withDuckDBLock()`
4. **Line 310**: `dematerializeActiveTable()` → **DROPs `fr_b2_base` from DuckDB**, marks it frozen
5. **Line 362**: `tableExists("fr_b2_base")` → returns **false** (it was just dropped!)
6. **Line 364**: `throw new Error('Table "fr_b2_base" does not exist')`
7. Error caught in DiffView.tsx:395 → toast may flash → `setIsComparing(false)`
8. `finally` block rematerializes the table, but the diff never ran

The `isComparing` flag flips true→false so quickly that the E2E test's poll never observes it as `true`.

---

## Fix

### Change 1: Skip dematerialization when active table is the diff target

**File**: `src/lib/diff-engine.ts`, lines 305-316

**Current code** (line 307-316):
```typescript
// Phase 4D: Temporarily dematerialize active table to free ~120MB during diff
let dematerializedTable: { tableName: string; tableId: string } | null = null
try {
  const { dematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
  dematerializedTable = await dematerializeActiveTable()
  ...
} catch (err) {
  console.warn('[Diff] Dematerialization skipped:', err)
}
```

**Fix**: Add a guard — only dematerialize if the active table is NOT one of the tables being compared. Use `tableB` (always known at this point) as the check. For safety, also check `tableA` (handles edge cases in two-tables mode where the active table happens to be one of the compared tables).

```typescript
// Phase 4D: Temporarily dematerialize active table to free ~120MB during diff
// IMPORTANT: Skip if active table is one of the tables being compared.
// In preview mode, the active table IS tableB (the diff target).
// Dematerializing it would DROP the very table we need to JOIN against.
let dematerializedTable: { tableName: string; tableId: string } | null = null
try {
  const { dematerializeActiveTable } = await import('@/lib/opfs/snapshot-storage')
  const { useTableStore } = await import('@/stores/tableStore')
  const activeTable = useTableStore.getState().tables.find(
    t => t.id === useTableStore.getState().activeTableId
  )
  const activeTableInUse = activeTable && (
    activeTable.name === tableB ||
    activeTable.name === tableA  // tableA may be "parquet:..." so this won't match, which is fine
  )
  if (!activeTableInUse) {
    dematerializedTable = await dematerializeActiveTable()
    if (dematerializedTable) {
      onProgress?.({ phase: 'Preparing...', current: 0, total: 0 })
    }
  }
} catch (err) {
  console.warn('[Diff] Dematerialization skipped:', err)
}
```

**Alternative (simpler)**: Since `dematerializeActiveTable()` already imports `useTableStore` internally, we could add the `tableB` guard inside that function. But that changes its public API contract. The guard at the call site is more explicit and doesn't modify the shared utility.

### Change 2: Unskip E2E test

**File**: `e2e/tests/zero-resident-architecture.spec.ts`, line 201

Change `test.skip(` to `test(` and remove the skip comment block.

---

## Files Modified

| File | Change | Lines |
|------|--------|-------|
| `src/lib/diff-engine.ts` | Add guard around `dematerializeActiveTable()` call | ~307-316 |
| `e2e/tests/zero-resident-architecture.spec.ts` | Unskip test 5 | ~201-206 |

---

## Verification

### 1. Run the unskipped E2E test
```bash
npx playwright test "zero-resident-architecture.spec.ts" --timeout=90000 --retries=0 --reporter=line
```
All 5 tests should pass, including the previously-skipped diff test.

### 2. Run existing diff tests
```bash
npx playwright test "diff-filtering.spec.ts" --timeout=90000 --retries=0 --reporter=line
```
These were reportedly failing on this branch — they should now pass.

### 3. Build + lint
```bash
npm run build && npm run lint
```

### 4. Manual smoke test
- Upload CSV → apply transform → open diff → "Compare with Preview" → verify comparison completes and shows modified rows
- Upload two CSVs → diff in "Compare Tables" mode → verify still works (two-tables mode should be unaffected)

---

## Why This Is Safe

- **Preview mode** (active table = tableB): Dematerialization is now correctly skipped. The source is already shard-backed via ChunkManager, so memory savings come from processing shards, not from dropping the target table.
- **Two-tables mode** (active table may or may not be in the comparison): If the active table is one of the compared tables, dematerialization is skipped (correct). If it's an unrelated table, dematerialization proceeds as before (no change in behavior).
- The `finally` block at line 954-967 still handles rematerialization for cases where dematerialization did occur.
