# Fix: Drill-Down Shows Original Instead of Previous State for Chained Tier 1 Transforms

## Problem Summary
When applying multiple Tier 1 transformations to the same column, the audit drill-down for the 2nd+ transformation incorrectly shows the **original** state instead of the state **after the previous transformation**.

**Example:**
1. Column "email" has value `"  John  "`
2. Apply Trim → value becomes `"John"`, `email__base` = `"  John  "`
3. Apply Uppercase → value becomes `"JOHN"`, `email__base` = `"  John  "` (unchanged)

**Current behavior:**
- Transform 1 drill-down: `"  John  "` → `"John"` ✓
- Transform 2 drill-down: `"  John  "` → `"JOHN"` ✗

**Expected behavior:**
- Transform 2 drill-down: `"John"` → `"JOHN"` ✓

## Root Cause

In `src/lib/commands/executor.ts`, the `captureTier1RowDetails()` function (lines 1379-1445) always compares `column` vs `column__base`:

```sql
WHERE ${quotedBaseCol} IS DISTINCT FROM ${quotedCol}
```

The `__base` column is created on the **first** Tier 1 transform and holds the **original** value. For chained Tier 1 transforms, `__base` never changes (by design - it enables expression-chain undo), so all subsequent transforms compare against the original.

**Key insight:** Tier 2/3 transforms correctly capture the pre-execution state via `capturePreExecutionDetails()` (line 331-336), but Tier 1 skips this because `tier !== 1` evaluates to `false` (line 328).

## Solution

For **chained** Tier 1 transforms (when an expression stack already exists), capture the pre-execution column value before applying the transform, then use that as `previous_value` instead of `__base`.

### Implementation Approach

1. **Detect chained Tier 1 transforms**: Check if `columnVersions.get(column)` has an existing expression stack
2. **Capture pre-execution state**: Use `capturePreSnapshot()` from `audit-snapshot.ts` directly (NOT `capturePreExecutionDetails` which uses type-specific handlers)
3. **Store correct previous values**: Use `capturePostDiff()` to compute differences using the pre-snapshot
4. **Fallback for first transform**: Keep existing `__base` comparison for the initial transform

**Key insight:** The existing `capturePreExecutionDetails()` (line 1331) uses `captureTier23RowDetails()` which has type-specific handlers and doesn't handle Tier 1 transforms like `trim`, `uppercase`, etc. Instead, we use `capturePreSnapshot()` / `capturePostDiff()` directly which are generic and work for any column.

### Files to Modify

| File | Change |
|------|--------|
| `src/lib/commands/executor.ts` | Add chained Tier 1 detection and use audit-snapshot for pre/post capture |

### Detailed Changes

#### `src/lib/commands/executor.ts`

**1. Add imports (top of file):**
```typescript
import {
  capturePreSnapshot,
  capturePostDiff,
} from './audit-snapshot'
```

**2. Detect chained Tier 1 after tier is determined (after line 231):**
```typescript
// Detect if this is a chained Tier 1 transform (existing expression stack)
const column = (command.params as { column?: string }).column
let isChainedTier1 = false
if (tier === 1 && column) {
  const versionInfo = ctx.columnVersions.get(column)
  isChainedTier1 = !!(versionInfo && versionInfo.expressionStack.length > 0)
}
```

**3. Add chained Tier 1 pre-capture (after line 336, before execution):**
```typescript
// Chained Tier 1: Capture pre-transform state using audit-snapshot
// (Can't use captureTier23RowDetails since it doesn't handle Tier 1 types)
if (!skipAudit && isChainedTier1 && column) {
  try {
    await capturePreSnapshot(
      ctx.db,
      ctx.table.name,
      column,
      preGeneratedAuditEntryId
    )
  } catch (err) {
    console.warn('[EXECUTOR] Failed to capture pre-snapshot for chained Tier 1:', err)
  }
}
```

**4. Add chained Tier 1 post-capture (after execution, around line 618):**
```typescript
// Chained Tier 1: Compute diff from pre-snapshot (instead of using __base)
if (!skipAudit && isChainedTier1 && column && auditInfo?.auditEntryId) {
  try {
    await capturePostDiff(
      updatedCtx.db,
      updatedCtx.table.name,
      column,
      auditInfo.auditEntryId
    )
    console.log(`[EXECUTOR] Captured chained Tier 1 audit details via pre-snapshot`)
  } catch (err) {
    console.warn('[EXECUTOR] Failed to capture post-diff for chained Tier 1:', err)
  }
}
```

**5. Skip captureTier1RowDetails for chained Tier 1 (modify line 620):**
```typescript
// Skip for chained Tier 1 - we already captured via pre-snapshot/post-diff
const shouldCaptureTier1 = !skipAudit &&
  auditInfo?.hasRowDetails &&
  auditInfo?.auditEntryId &&
  tier === 1 &&
  !isChainedTier1  // NEW: Skip if chained (already captured above)
```

**6. Ensure consistent auditEntryId for chained Tier 1 (modify line 464-466):**
```typescript
// BEFORE:
if (tier !== 1 && !commandStoresOwnAuditDetails) {
  auditInfo.auditEntryId = preGeneratedAuditEntryId
}

// AFTER: Also use preGeneratedAuditEntryId for chained Tier 1
if ((tier !== 1 || isChainedTier1) && !commandStoresOwnAuditDetails) {
  auditInfo.auditEntryId = preGeneratedAuditEntryId
}
```
This ensures the pre-snapshot and audit entry use the same ID.

## Verification

### Manual Test
1. Upload a CSV with a text column
2. Apply Trim to the column
3. Apply Uppercase to the same column
4. Click drill-down on Transform 1 → should show original → trimmed
5. Click drill-down on Transform 2 → should show trimmed → uppercased (not original → uppercased)

### E2E Test
Add a test case in `e2e/tests/` that verifies:
- Chained Tier 1 transforms show correct previous values
- First transform still works correctly
- Mix of Tier 1 and Tier 3 transforms work correctly

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Performance overhead for chained Tier 1 | Pre-snapshot is temp table + single pass - minimal overhead |
| Regression in first transform behavior | Only change behavior when `expressionStack.length > 0` |
| Interaction with Tier 3 `resetBaseColumnsAfterTier3` | After Tier 3 reset, next Tier 1 is "first" again (stack length = 0) |

## Backward Compatibility

- First Tier 1 transform: No change (uses `__base` comparison)
- Tier 2/3 transforms: No change (already uses pre-snapshot)
- Chained Tier 1: New behavior (uses pre-snapshot like Tier 2/3)
- Undo/Redo: Not affected (uses expression chain, not audit snapshots)
