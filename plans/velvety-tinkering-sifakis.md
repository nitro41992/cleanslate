# Memory Leak Investigation & Fix Plan

**Status:** ✅ APPROVED with Critical Verifications
**Branch:** `opfs-ux-polish` (master has memory issues)
**Issue:** Memory exhaustion after 4-5 transformations on 1M row dataset
**Approval Date:** January 23, 2026

---

## Problem Statement

User reports memory issues on master branch after running multiple transformations on ~1M rows:
- File Loaded: 1,010,000 rows
- Uppercase: 746,229 rows (6m ago)
- Standardize Date: 1,010,000 rows (3m ago)
- Remove Duplicates: 9,783 rows (3m ago)
- Calculate Age: 1,000,217 rows (2m ago)

**User Context:** "I thought we fixed any memory issues with the OPFS fixes"

OPFS implementation added:
- Compression (zstd, 30-50% reduction)
- 3GB memory limit (75% of 4GB WASM ceiling)
- Snapshot pruning (MAX_SNAPSHOTS_PER_TABLE = 5)
- Audit log pruning (last 100 entries)

But memory issues persist despite these optimizations.

---

## Root Cause Analysis

### Investigation Findings

**1. Diff Views Never Cleaned Up** ❌
- Each command creates a diff view: `v_diff_step_{tableId}_{stepIndex}`
- Views created via `createTier1DiffView()` and `createTier3DiffView()`
- **Functions exist but NEVER CALLED**: `dropDiffView()`, `dropAllDiffViews()`
- Location: `src/lib/commands/diff-views.ts:138-158`
- **Impact:** Diff views accumulate indefinitely (1 per command)
- With 1M rows, each diff view is a full table scan + CASE WHEN logic
- 5 commands = 5 diff views = 5M+ rows in memory

**2. Internal Tables Excluded from Memory Tracking** ⚠️
- File: `src/lib/duckdb/memory.ts:91-98`
- Memory estimation EXCLUDES:
  - `_timeline_*` (snapshot tables)
  - `_diff_*` (diff views)
  - `_original_*` (original snapshots)
  - `_audit_*` (audit detail tables)
- **Impact:** UI shows low memory usage, but actual usage is 3-5x higher
- User hits 3GB limit before seeing "critical" warning

**3. Snapshot Pruning Logic Has Off-By-One** ⚠️
- File: `src/lib/commands/executor.ts:583`
- Condition: `if (timeline.snapshots.size <= MAX_SNAPSHOTS_PER_TABLE) return`
- **Bug:** Should be `<` not `<=` - allows 6 snapshots before pruning
- With 1M rows: 6 snapshots × 1M rows = 6M rows retained
- **Impact:** Extra 1M rows retained unnecessarily

**4. No Cleanup on Undo/Redo** ⚠️
- When user undos past a command, its diff view and snapshot should be dropped
- Currently: snapshots pruned via LRU, but diff views remain forever
- **Impact:** Undo/redo cycles leave orphaned diff views

**5. Original Snapshots Never Pruned** ⚠️
- Created on first manual edit: `_original_{tableId}`
- Used for "Compare with Preview" in diff feature
- Never dropped, even if user never uses diff feature
- **Impact:** Extra 1M rows retained per table

---

## Proposed Solution

### Strategy Overview

**Principle:** Aggressive cleanup of ephemeral artifacts while preserving undo functionality.

**Three-Pronged Approach:**
1. **Proactive Cleanup:** Drop diff views immediately after highlighting extraction
2. **Memory-Aware Pruning:** Include internal tables in memory tracking
3. **Lifecycle Management:** Clean up on undo/redo, table deletion, and session end

---

## Implementation Plan

### Phase 1: Immediate Diff View Cleanup

**Goal:** Drop diff views as soon as they're no longer needed for highlighting.

**Current Flow:**
```
Command Execution
  ↓
Create Diff View (v_diff_step_X)
  ↓
Extract affected row IDs for highlighting
  ↓
[Diff view left in memory forever] ❌
```

**New Flow:**
```
Command Execution
  ↓
Create Diff View (v_diff_step_X)
  ↓
Extract affected row IDs for highlighting
  ↓
Drop Diff View immediately ✅
```

**Implementation:**

**File:** `src/lib/commands/executor.ts`

**Location:** After `extractAffectedRowIds()` call (~line 252)

**Before:**
```typescript
const highlightInfo = diffViewName
  ? await this.extractAffectedRowIds(ctx, diffViewName)
  : undefined
```

**After:**
```typescript
const highlightInfo = diffViewName
  ? await this.extractAffectedRowIds(ctx, diffViewName)
  : undefined

// Drop diff view immediately after extracting row IDs
// Diff views are ephemeral - only needed for highlighting extraction
if (diffViewName) {
  try {
    await ctx.db.execute(`DROP VIEW IF EXISTS "${diffViewName}"`)
    console.log(`[Memory] Dropped diff view: ${diffViewName}`)
  } catch (err) {
    // Non-fatal - don't fail the command
    console.warn(`[Memory] Failed to drop diff view ${diffViewName}:`, err)
  }
}
```

**Justification:**
- Diff views are only used to extract affected row IDs
- Once `highlightInfo.affectedRowIds` is populated, the view is useless
- Dropping immediately prevents accumulation
- Non-blocking (try/catch) - won't fail commands if drop fails

**Impact:** Reduces memory by ~1M rows per command execution

---

### Phase 2: Fix Snapshot Pruning Off-By-One

**Goal:** Ensure exactly MAX_SNAPSHOTS_PER_TABLE (5) snapshots retained, not 6.

**File:** `src/lib/commands/executor.ts:583`

**Before:**
```typescript
if (timeline.snapshots.size <= MAX_SNAPSHOTS_PER_TABLE) return
```

**After:**
```typescript
if (timeline.snapshots.size < MAX_SNAPSHOTS_PER_TABLE) return
```

**Justification:**
- `<=` allows 6 snapshots (0, 1, 2, 3, 4, 5) before pruning
- `<` enforces exactly 5 snapshots (prunes when size reaches 5)
- With 1M rows, saves 1M rows of memory

**Impact:** Reduces memory by ~1M rows (1 snapshot × 1M rows)

---

### Phase 3: Include Internal Tables in Memory Tracking

**Goal:** Show accurate memory usage including snapshots, diff views, audit tables.

**File:** `src/lib/duckdb/memory.ts:91-98`

**Before:**
```typescript
WHERE NOT internal
  AND table_name NOT LIKE '_timeline_%'
  AND table_name NOT LIKE '_audit_%'
  AND table_name NOT LIKE '_diff_%'
  AND table_name NOT LIKE '_original_%'
```

**After:**
```typescript
WHERE NOT internal
  -- Include internal CleanSlate tables in memory tracking
  -- (timeline snapshots, diff views, audit tables consume significant memory)
```

**Justification:**
- Current exclusions hide true memory usage
- With 5 snapshots + 5 diff views = 10M+ rows hidden
- Users hit 3GB limit before seeing "critical" warning
- Accurate tracking enables proactive cleanup

**Alternative (Conservative):**
If we want to preserve some exclusions:
```typescript
WHERE NOT internal
  AND table_name NOT LIKE '_audit_%'  -- Keep audit excluded (small)
  -- Include _timeline_, _diff_, _original_ in tracking
```

**Impact:** UI will show accurate memory usage, triggering warnings earlier

---

### Phase 4: Cleanup Orphaned Diff Views on Undo

**Goal:** Drop diff views for commands that are undone or redone past.

**File:** `src/lib/commands/executor.ts`

**Location:** Inside `undo()` method after snapshot restoration (~line 400)

**Add:**
```typescript
// After restoring snapshot, drop the diff view for the undone command
const undoneCmdRecord = timeline.commands[timeline.position]
if (undoneCmdRecord) {
  const stepIndex = timeline.position + 1
  const diffViewName = getDiffViewName(tableId, stepIndex)
  try {
    await ctx.db.execute(`DROP VIEW IF EXISTS "${diffViewName}"`)
    console.log(`[Undo] Dropped diff view: ${diffViewName}`)
  } catch (err) {
    console.warn(`[Undo] Failed to drop diff view:`, err)
  }
}
```

**Justification:**
- When user undos Command #3, its diff view is no longer needed
- If user redoes, a new diff view will be created
- Prevents accumulation during undo/redo cycles

**Impact:** Prevents memory leak during undo/redo workflows

---

### Phase 5: Drop Original Snapshots on Table Deletion

**Goal:** Clean up original snapshots when tables are deleted.

**File:** `src/lib/commands/executor.ts:94-107` (clearCommandTimeline function)

**Already implemented:** ✅

```typescript
export function clearCommandTimeline(tableId: string): void {
  const timeline = tableTimelines.get(tableId)
  if (timeline) {
    // Clean up snapshot tables
    for (const snapshotName of timeline.snapshots.values()) {
      dropTable(snapshotName).catch(() => {})
    }
    if (timeline.originalSnapshot) {
      dropTable(timeline.originalSnapshot).catch(() => {}) // ✅ Already drops original
    }
    tableTimelines.delete(tableId)
  }
}
```

**Status:** No changes needed - already implemented correctly.

---

### Phase 6: Proactive Snapshot Pruning on High Memory

**Goal:** If memory > 80%, aggressively prune snapshots down to MAX_SNAPSHOTS_PER_TABLE.

**File:** `src/lib/commands/executor.ts`

**Add helper function:**
```typescript
/**
 * Aggressively prune all table snapshots if memory is high.
 * Called when memory > 80% to free up space.
 */
private async pruneSnapshotsIfHighMemory(): Promise<void> {
  const memStatus = await getMemoryStatus()

  if (memStatus.percentage < 80) return // Not critical yet

  console.warn('[Memory] High memory usage detected, pruning snapshots...')

  let prunedCount = 0

  for (const [tableId, timeline] of tableTimelines.entries()) {
    // Prune down to MAX_SNAPSHOTS_PER_TABLE
    while (timeline.snapshots.size > MAX_SNAPSHOTS_PER_TABLE) {
      await this.pruneOldestSnapshot(timeline)
      prunedCount++
    }
  }

  if (prunedCount > 0) {
    console.log(`[Memory] Pruned ${prunedCount} snapshots due to high memory`)
  }
}
```

**Call location:** After command execution, before flushing (~line 290)

```typescript
// Step 8: Update stores
progress('complete', 100, 'Complete')
this.updateTableStore(ctx.table.id, executionResult)

// Proactive memory management
await this.pruneSnapshotsIfHighMemory()

// Auto-persist to OPFS (debounced, non-blocking)
const { flushDuckDB } = await import('@/lib/duckdb')
```

**Justification:**
- Prevents OOM before it happens
- Users with large datasets won't hit 3GB limit unexpectedly
- Trades some undo history for stability

**Impact:** Prevents memory exhaustion on large datasets

---

## File Modification Summary

| File | Change | Lines | Complexity |
|------|--------|-------|------------|
| `src/lib/commands/executor.ts` | Add diff view cleanup after extraction | +12 | Low |
| `src/lib/commands/executor.ts` | Fix snapshot pruning off-by-one | 1 | Trivial |
| `src/lib/commands/executor.ts` | Add diff view cleanup on undo | +10 | Low |
| `src/lib/commands/executor.ts` | Add proactive snapshot pruning helper | +25 | Medium |
| `src/lib/duckdb/memory.ts` | Include internal tables in tracking | -4 | Trivial |

**Total:** 5 changes across 2 files, ~45 lines added, ~4 lines removed

---

## Testing Strategy

### Manual Testing

**Test 1: Diff View Cleanup**
1. Load 1M row dataset
2. Open DevTools → Application → Storage → OPFS → DuckDB
3. Query: `SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '_diff_%'`
4. Apply 5 transformations
5. Re-query: Expect 0 diff views (all dropped after execution)
6. **Before fix:** 5 diff views remain
7. **After fix:** 0 diff views

**Test 2: Snapshot Pruning**
1. Load 1M row dataset
2. Apply 6 Tier 3 transformations (each creates a snapshot)
3. Query: `SELECT COUNT(*) FROM duckdb_tables() WHERE table_name LIKE '_cmd_snapshot_%'`
4. **Before fix:** 6 snapshots
5. **After fix:** 5 snapshots

**Test 3: Memory Tracking Accuracy**
1. Load 1M row dataset
2. Apply 3 transformations (creates 3 snapshots)
3. Check MemoryIndicator in status bar
4. Query: `SELECT SUM(estimated_size) FROM duckdb_tables()`
5. **Before fix:** UI shows ~300MB, actual is ~900MB (3× undercount)
6. **After fix:** UI shows ~900MB (accurate)

**Test 4: Undo Cleanup**
1. Apply 5 transformations
2. Undo 3 times
3. Query for diff views
4. **Before fix:** 5 diff views remain
5. **After fix:** 2 diff views remain (only for positions 0-1)

**Test 5: High Memory Pruning**
1. Load large dataset (2M rows)
2. Apply 10 transformations
3. Memory indicator should show < 80%
4. Console should log: "[Memory] Pruned X snapshots due to high memory"

### E2E Tests

**New test file:** `e2e/tests/memory-leak-regression.spec.ts`

```typescript
test.describe.serial('Memory Leak Regression', () => {
  let page: Page
  let inspector: StoreInspector

  test('should cleanup diff views after transformation', async () => {
    await laundromat.uploadFile(getFixturePath('large-1m.csv'))
    await wizard.import()

    // Apply transformation
    await laundromat.clickAddTransformation()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.clickRunRecipe()

    // Check no diff views remain
    const diffViews = await inspector.runQuery(`
      SELECT table_name FROM duckdb_tables()
      WHERE table_name LIKE '_diff_%'
    `)

    expect(diffViews.length).toBe(0)
  })

  test('should enforce MAX_SNAPSHOTS_PER_TABLE=5', async () => {
    // Apply 6 Tier 3 transformations
    for (let i = 0; i < 6; i++) {
      await applyTransformation('remove_duplicates')
    }

    // Check snapshot count
    const snapshots = await inspector.runQuery(`
      SELECT COUNT(*) as count FROM duckdb_tables()
      WHERE table_name LIKE '_cmd_snapshot_%'
    `)

    expect(snapshots[0].count).toBeLessThanOrEqual(5)
  })

  test('should show accurate memory including internal tables', async () => {
    await loadLargeDataset()

    // Get UI memory reading
    const uiMemory = await page.evaluate(() => {
      const store = window.useUIStore.getState()
      return store.memoryUsage
    })

    // Get actual DuckDB memory (including internal tables)
    const duckdbMemory = await inspector.runQuery(`
      SELECT SUM(estimated_size * column_count * 50) as total
      FROM duckdb_tables()
      WHERE NOT internal
    `)

    const actualBytes = duckdbMemory[0].total
    const difference = Math.abs(uiMemory - actualBytes) / actualBytes

    // UI should be within 20% of actual (accounting for compression)
    expect(difference).toBeLessThan(0.2)
  })
})
```

---

## Performance Impact

**Before Fix (5 commands on 1M rows):**
- User table: 1M rows (compressed)
- 5 diff views: 5M rows (uncompressed views)
- 6 snapshots: 6M rows (compressed)
- **Total:** ~12M rows in memory
- **Memory:** ~2.5-3GB (hits limit)

**After Fix (5 commands on 1M rows):**
- User table: 1M rows (compressed)
- 0 diff views: 0 rows ✅
- 5 snapshots: 5M rows (compressed) ✅
- **Total:** ~6M rows in memory
- **Memory:** ~1.2-1.5GB (50% reduction)

**Memory Savings:**
- Diff view cleanup: ~5M rows = ~1GB
- Snapshot pruning fix: ~1M rows = ~200MB
- **Total saved:** ~1.2GB (40% reduction)

---

## Risk Assessment

### Low Risk Changes

1. **Diff view cleanup:** Diff views are ephemeral, safe to drop immediately
2. **Snapshot pruning fix:** Off-by-one fix, mathematically correct
3. **Memory tracking:** Display-only change, doesn't affect behavior

### Medium Risk Changes

4. **Undo cleanup:** Could orphan diff views if undo logic has bugs
   - Mitigation: Diff views are recreated on redo, no data loss
5. **Proactive pruning:** Might prune too aggressively under high load
   - Mitigation: Only prunes when memory > 80%, preserves 5 snapshots

### Testing Coverage

- Manual testing covers all changes
- E2E tests verify memory behavior
- Console logging for debugging

---

## Rollback Strategy

If issues arise:

1. **Revert diff view cleanup:** Comment out `DROP VIEW` calls (2 locations)
2. **Revert memory tracking:** Restore `NOT LIKE` filters
3. **Revert snapshot pruning fix:** Change `<` back to `<=`
4. **Revert proactive pruning:** Comment out `pruneSnapshotsIfHighMemory()` call

All changes are additive (no deletions), easy to revert.

---

## Success Criteria

**User Experience:**
- Users can apply 10+ transformations on 1M rows without OOM
- Memory indicator shows accurate usage (within 20%)
- No performance degradation

**Technical:**
- 0 diff views remain after command execution
- Exactly 5 snapshots retained per table
- Memory usage reduced by 40-50%

**Validation:**
- All E2E tests pass
- Manual testing confirms memory reduction
- No regressions in undo/redo functionality

---

## Next Steps After Fix

1. **Monitor production metrics:**
   - Track memory usage over time
   - Monitor OOM crash rates
   - Measure snapshot count distribution

2. **Future optimizations:**
   - Implement snapshot compression (zstd on snapshots)
   - Add "Clear Undo History" button for power users
   - Consider LRU cache for diff views (keep last 3 for quick redo)

3. **Documentation:**
   - Update CLAUDE.md with memory management details
   - Add JSDoc comments on cleanup functions
   - Document MAX_SNAPSHOTS_PER_TABLE rationale

---

## Critical Files

**Primary:**
- `src/lib/commands/executor.ts` - Command execution & cleanup logic
- `src/lib/duckdb/memory.ts` - Memory tracking & estimation

**Secondary:**
- `src/lib/commands/diff-views.ts` - Diff view creation/deletion (already has dropDiffView)
- `src/stores/uiStore.ts` - Memory indicator display

**Testing:**
- `e2e/tests/memory-leak-regression.spec.ts` - New E2E tests

---

## Implementation Order

1. ✅ **Phase 1:** Immediate diff view cleanup (highest impact, lowest risk)
2. ✅ **Phase 2:** Fix snapshot pruning off-by-one (trivial change)
3. ✅ **Phase 3:** Include internal tables in memory tracking (UI accuracy)
4. ✅ **Phase 4:** Cleanup diff views on undo (prevent accumulation)
5. ✅ **Phase 5:** Proactive snapshot pruning (safety net)
6. ✅ **Testing:** E2E tests + manual validation

**Estimated Implementation Time:** 2-3 hours
**Estimated Testing Time:** 1-2 hours
**Total:** 3-5 hours

---

---

## Critical Verifications (From Review)

### ⚠️ Phase 1: Grid Highlighting Dependency (CRITICAL - HIGH IMPACT)
**Risk:** DataGrid or Undo/Redo visualization might query `v_diff_step_{tableId}_{stepIndex}` after command completes.

**Verification Required:**
- **File:** `src/components/grid/DataGrid.tsx`
- Confirm it relies solely on `highlightedRows` (array of IDs) passed via `timelineStore`
- Verify it NEVER attempts SQL queries against `v_diff_step_X` views
- **Test:** Apply transformation, verify grid highlighting still works after view is dropped

**JS Heap Pressure (ALREADY MITIGATED):**
- Current implementation has `MAX_HIGHLIGHT_ROWS = 10000` limit in `extractAffectedRowIds()` (line ~888)
- ✅ This prevents moving 1M row IDs from WASM to JS (would crash browser tab)
- **DO NOT REMOVE THIS LIMIT** - it's a critical safety guardrail
- For operations affecting >10k rows, highlighting is skipped (acceptable UX trade-off)

### ⚠️ Phase 3: Memory Reporting UI Impact (CALIBRATION NEEDED)
**Risk:** When internal tables included, reported memory jumps 3-5x (expected behavior).

**Current Thresholds** (`src/lib/duckdb/memory.ts`):
- `WARNING_THRESHOLD = 0.6` (1.8GB of 3GB limit)
- `CRITICAL_THRESHOLD = 0.8` (2.4GB of 3GB limit)
- `BLOCK_THRESHOLD = 0.95` (2.85GB - prevents new operations)

**Action Required:**
1. After enabling full tracking, test "normal" heavy session (1M rows, 5 transforms)
2. If it immediately triggers WARNING state, adjust thresholds:
   - Option A: Raise WARNING to 0.7 (2.1GB)
   - Option B: Distinguish "User Data" (critical) vs "History" (prunable) in UI
3. **Test:** Load 1M rows, apply 3 transformations, verify warning appears at appropriate point
4. Consider adding memory breakdown: "User Data: 500MB | Undo History: 1.2GB | System: 300MB"

### ⚠️ Phase 6: Proactive Pruning Safety (UX CRITICAL)
**Risk:** Pruning logic might accidentally prune current state or immediate previous state.

**Critical Guardrails:**
1. **NEVER prune snapshot at current position** (user's active state)
2. **NEVER prune snapshot at position - 1** (immediate undo target)
3. Only prune LRU (Longest-Running-Unused) snapshots from history tail
4. Preserve minimum undo depth (at least 1-2 steps back)

**Logic Check Required:**
```typescript
// In pruneSnapshotsIfHighMemory():
while (timeline.snapshots.size > MAX_SNAPSHOTS_PER_TABLE) {
  // MUST call pruneOldestSnapshot which uses LRU timestamp sorting
  await this.pruneOldestSnapshot(timeline)
  prunedCount++
}
```

**UX Requirement (MANDATORY):**
- **Add Toast Notification:** "Old undo history cleared to free memory"
- Users find it frustrating when Undo grays out silently
- **File:** Add toast import and call in `pruneSnapshotsIfHighMemory()`

**Test:** Load 2M rows, apply 10 transformations, verify:
1. Console logs pruning event
2. Toast notification appears
3. User can still undo at least 1-2 steps back

### ⚠️ Missing Consideration: The "Vacuum" Problem
**Issue:** DuckDB doesn't always release memory immediately after DROP VIEW/TABLE.

**Solution:**
- After Phase 1 (diff view drop) or Phase 6 (snapshot pruning), DuckDB may retain references in WAL
- **Action:** Rely on existing `flushDuckDB()` auto-flush mechanism (1s debounce)
- WAL checkpoint (TRUNCATE) will release memory on next flush
- No additional code needed - already implemented

### ⚠️ Missing Consideration: "Compare" Feature Impact (MUST VERIFY)
**Issue:** `_original_*` snapshots used for "Compare with Preview" diff mode.

**Verification Required:**
1. **File:** `src/features/diff/` components
2. Verify "Diff Mode" (side-by-side comparison) does NOT reuse ephemeral `v_diff_step_X` views
3. Expectation: Diff Mode should generate its own views on demand, not rely on execution artifacts
4. Check if `diffStore` or diff components query specific view names

**Test Scenario:**
1. Load dataset, apply 3 transformations (diff views get dropped in Phase 1)
2. Open "Compare with Preview" or "Diff" tab
3. Verify side-by-side comparison still works correctly
4. Check console for any errors about missing `v_diff_step_*` views

### ⚠️ E2E Test Flakiness
**Issue:** Memory comparison test `expect(difference).toBeLessThan(0.2)` might be flaky due to GC timing.

**Solution Options:**
1. Trigger force GC in browser context (requires Chrome with `--js-flags="--expose-gc"`)
2. Relax tolerance slightly for CI stability (e.g., 0.25 instead of 0.2)
3. Add retry logic with await for GC to settle

---

## Implementation Checklist (Pre-Flight)

Before implementing each phase, verify:

**Phase 1 (Diff View Cleanup):**
- [ ] Read DataGrid highlighting implementation
- [ ] Confirm grid uses `highlightInfo.affectedRowIds` array, not diff view queries
- [ ] Check for any lazy-loading of highlighting info from views
- [ ] Verify no other components query `v_diff_step_*` views

**Phase 3 (Memory Tracking):**
- [ ] Verify MemoryIndicator thresholds (warning: 60%, critical: 80%)
- [ ] Check if thresholds need recalibration for higher baseline
- [ ] Consider adding memory breakdown UI (optional)

**Phase 6 (Proactive Pruning):**
- [ ] Review snapshot pruning logic to ensure current position is never pruned
- [ ] Add user-facing toast notification for pruning events
- [ ] Verify LRU eviction order (oldest first)

**All Phases:**
- [ ] Test "Compare with Preview" diff mode after each phase
- [ ] Monitor browser heap (DevTools Memory Profiler) during testing
- [ ] Verify WAL checkpoint releases memory properly

---

## Open Questions

None - all investigation complete, solution designed, critical verifications identified.
