# Plan: Fix Split Column Undo Not Working

## Problem Summary

Split column undo fails with multiple symptoms:
1. Created columns don't get properly deleted
2. Subsequent transforms on source column affect "undone" rows
3. For large datasets, errors like `params.changes is not iterable` and `Table does not exist`

## Root Cause Analysis

### Bug #1: batch_edit parameter serialization mismatch

When batch_edit is synced to timelineStore, it uses the generic handler:
```typescript
// executor.ts:1442-1449 (generic handler)
const customParams = extractCustomParams(command.params)  // { changes: [...] }
timelineParams = {
  type: legacyCommandType,
  transformationType: 'batch',
  params: customParams,  // changes is NESTED in params.params
}
```

But `applyBatchEditCommand()` expects `changes` at the TOP level:
```typescript
// timeline-engine.ts:469-476
async function applyBatchEditCommand(tableName: string, params: BatchEditParams) {
  for (const change of params.changes) {  // ERROR: params.changes is undefined!
```

**Why this breaks split_column undo:** When undoing split_column (Tier 3), the system restores from snapshot and replays ALL commands. If batch_edit was applied before split_column, it fails during replay.

### Bug #2: match:merge parameter serialization mismatch (Same pattern)

MatchMergeCommand has:
```typescript
interface MatchMergeParams {
  matchColumn: string
  pairs: MatchPair[]  // Full MatchPair objects
}
```

But applyMergeCommand expects:
```typescript
interface MergeParams {
  type: 'merge'
  matchColumn: string
  mergedPairs: { keepRowId: string; deleteRowId: string }[]  // Different structure!
}
```

### Bug #3: param-extraction.ts registry mismatch

```typescript
// Current (wrong)
'transform:split_column': ['delimiter', 'newColumnNames', 'mode'],

// Actual SplitColumnParams interface
splitMode: SplitMode  // not 'mode'
delimiter?: string
position?: number     // missing
length?: number       // missing
```

## Fix Strategy

### Phase 1: Add Failing E2E Test (TDD)

**File:** `e2e/tests/split-column-undo.spec.ts`

```typescript
// Test 1: Basic split_column undo
// 1. Load table with compound field (e.g., "full_name")
// 2. Apply split_column on "full_name" with delimiter=" "
// 3. Verify split columns exist (full_name_1, full_name_2)
// 4. Undo split_column
// 5. Verify: split columns removed, original data intact

// Test 2: split_column undo after batch_edit (regression)
// 1. Load table
// 2. Apply batch_edit (cell edits) - will be replayed during undo
// 3. Apply split_column
// 4. Undo split_column
// 5. Verify: no replay errors, columns removed correctly
```

### Phase 2: Fix batch_edit Sync

**File:** `src/lib/commands/executor.ts` (insert after line 1437, before generic `else`)

```typescript
} else if (command.type === 'edit:batch') {
  const batchParams = command.params as { changes: CellChange[] }
  timelineParams = {
    type: 'batch_edit',
    changes: batchParams.changes,  // TOP LEVEL - matches BatchEditParams
  } as import('@/types').BatchEditParams
```

### Phase 3: Fix match:merge Sync

**File:** `src/lib/commands/executor.ts` (insert after batch_edit handler)

```typescript
} else if (command.type === 'match:merge') {
  const mergeParams = command.params as { matchColumn: string; pairs: MatchPair[] }
  // Transform pairs to mergedPairs format expected by applyMergeCommand
  const mergedPairs = mergeParams.pairs
    .filter(p => p.status === 'merged')
    .map(p => ({
      keepRowId: p.keepRow === 'A' ? p.rowA._cs_id : p.rowB._cs_id,
      deleteRowId: p.keepRow === 'A' ? p.rowB._cs_id : p.rowA._cs_id,
    }))
  timelineParams = {
    type: 'merge',
    matchColumn: mergeParams.matchColumn,
    mergedPairs,
  } as import('@/types').MergeParams
```

### Phase 4: Make applyBatchEditCommand Defensive

**File:** `src/lib/timeline-engine.ts` (line 469)

Handle both nested and top-level for backwards compatibility with existing timelines:

```typescript
async function applyBatchEditCommand(
  tableName: string,
  params: BatchEditParams | { params?: { changes: CellChange[] } }
): Promise<void> {
  // Handle both legacy nested structure and correct top-level structure
  const changes = 'changes' in params && Array.isArray(params.changes)
    ? params.changes
    : (params as { params?: { changes: CellChange[] } }).params?.changes

  if (!changes || !Array.isArray(changes)) {
    console.error('[REPLAY] batch_edit has no valid changes array:', params)
    return
  }

  for (const change of changes) {
    await updateCellByRowId(tableName, change.csId, change.columnName, change.newValue)
  }
}
```

### Phase 5: Fix Param Registry

**File:** `src/lib/commands/utils/param-extraction.ts` (line 151)

```typescript
'transform:split_column': ['splitMode', 'delimiter', 'position', 'length'],
```

## Files to Modify

| File | Change |
|------|--------|
| `e2e/tests/split-column-undo.spec.ts` | NEW - failing tests |
| `src/lib/commands/executor.ts` | Add `edit:batch` and `match:merge` special cases (~line 1437) |
| `src/lib/timeline-engine.ts` | Make applyBatchEditCommand defensive (~line 469) |
| `src/lib/commands/utils/param-extraction.ts` | Fix split_column param names (line 151) |

## Verification

```bash
# 1. Run failing test first (should fail)
npx playwright test "split-column-undo.spec.ts" --timeout=90000 --retries=0 --reporter=line

# 2. Apply fixes and re-run (should pass)
npx playwright test "split-column-undo.spec.ts" --timeout=90000 --retries=0 --reporter=line

# 3. Run existing tier-3 undo tests (should still pass)
npx playwright test "tier-3-undo" --timeout=90000 --retries=0 --reporter=line

# 4. Run column-ordering tests (also tests split_column)
npx playwright test "column-ordering.spec.ts" --timeout=90000 --retries=0 --reporter=line
```
