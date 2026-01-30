# Plan: Fix Audit Drill-Down After Tier 3 Transforms

**Status: IMPLEMENTED** (2026-01-30)

## Problem Summary

After a Tier 3 transform (like Split Column), audit drill-downs for subsequent Tier 1 transforms don't work. Root cause: Tier 1 audit capture compares to `__base` (original value from before ALL transforms), not the pre-transform value (before THIS specific transform).

## Scalability Analysis

**Pre-capture approach (Tier 2/3 style) doesn't scale:**
- Would INSERT 1M+ rows BEFORE knowing which will change
- Wasteful: most transforms only affect a subset of rows
- Memory overhead significant for large datasets

**Current `__base` approach IS efficient:**
- Only queries AFTER transform: `WHERE __base IS DISTINCT FROM column`
- Naturally filters to only affected rows
- DuckDB handles 1M+ row comparisons quickly
- The issue is just that `__base` has ORIGINAL values after Tier 3, not pre-transform values

## Proposed Solution: Reset `__base` After Tier 3

Keep the efficient `__base` comparison for audit, but reset it after Tier 3 so it represents the pre-transform state (not the original state).

### How It Works

1. **Normal Tier 1 flow (unchanged):**
   - First transform creates `column__base` with current values
   - Audit compares `column` to `column__base` → shows changes correctly

2. **After Tier 3 completes:**
   - Scan for existing `__base` columns in the rebuilt table
   - UPDATE each `__base` column to match current column values
   - This "resets" the baseline for subsequent Tier 1 transforms

3. **Subsequent Tier 1 after Tier 3:**
   - Finds existing `__base` column (now with post-Tier-3 values)
   - Applies transform and chains expression
   - Audit compares new values to reset `__base` → shows changes correctly

### Changes Required

#### 1. Add `__base` reset after Tier 3 (executor.ts)

**File:** `src/lib/commands/executor.ts`

After the existing Tier 3 cleanup block (around line 429-445), add:

```typescript
if (tier === 3) {
  // ... existing CHECKPOINT and clearColumnVersionStore code ...

  // Reset __base columns to current values for accurate subsequent audit capture
  // This ensures Tier 1 transforms after Tier 3 compare to post-Tier-3 state
  await this.resetBaseColumnsAfterTier3(updatedCtx)
}
```

#### 2. Implement `resetBaseColumnsAfterTier3` method (executor.ts)

```typescript
private async resetBaseColumnsAfterTier3(ctx: CommandContext): Promise<void> {
  // Get all columns from table
  const columns = await ctx.db.query<{ column_name: string }>(`
    SELECT column_name FROM (DESCRIBE "${ctx.table.name}")
  `)

  // Find __base columns and their corresponding source columns
  for (const col of columns) {
    if (col.column_name.endsWith('__base')) {
      const sourceCol = col.column_name.replace(/__base$/, '')
      // Check if source column exists
      const hasSource = columns.some(c => c.column_name === sourceCol)
      if (hasSource) {
        // Reset __base to current source value
        await ctx.db.execute(`
          UPDATE "${ctx.table.name}"
          SET "${col.column_name}" = "${sourceCol}"
        `)
        console.log(`[Executor] Reset ${col.column_name} to current ${sourceCol} values`)
      }
    }
  }
}
```

#### 3. Revert the hacky fix from earlier (executor.ts)

Remove the `previousExpression` computation added to `captureTier1RowDetails` today.

### Files to Modify

1. `src/lib/commands/executor.ts`
   - Add `resetBaseColumnsAfterTier3` method
   - Call it after Tier 3 operations
   - Revert `captureTier1RowDetails` to use simple `__base` comparison

### Benefits

- **Scales to 1M+ rows**: No pre-capture overhead, just efficient post-transform comparison
- **Simple mental model**: `__base` always = state before THIS transform
- **Minimal code change**: One new method, one call site
- **Undo preserved**: Tier 3 snapshots handle full restoration

### Trade-off

After Tier 3, you lose the ability to see "cumulative change from original" in drill-down. Each audit entry shows "change from previous state" instead. This is actually more useful for debugging individual transforms.

### Verification

1. Load CSV with 100k+ rows of text data
2. Apply Uppercase to a column (Tier 1) → verify drill-down works
3. Apply Split Column (Tier 3)
4. Apply Lowercase to the same column (Tier 1)
5. Verify drill-down shows the Lowercase changes (UPPERCASE → lowercase)
6. Verify performance is acceptable on large dataset

---

## Alternatives Considered

### A. Pre-capture for all tiers
- **Rejected**: Doesn't scale - would INSERT 1M+ rows before knowing which change

### B. Split Column in-place
- Store 0th term in source column, subsequent splits in new columns
- **Rejected**: Only helps one command, doesn't address root issue

### C. Complex expression chain reconstruction
- Compute previous expression from stack after Tier 3
- **Rejected**: Hacky, fragile, added complexity

---

## Implementation Summary

The fix was implemented in `src/lib/commands/executor.ts`:

1. **Added `resetBaseColumnsAfterTier3` method** (lines 1067-1108)
   - Scans table for `__base` columns after Tier 3 completes
   - Resets each `__base` column to current source column value
   - Non-fatal error handling (warns but doesn't fail command)

2. **Call site added after Tier 3** (line 452)
   - Called immediately after `clearColumnVersionStore()` in the tier === 3 block
   - Uses `updatedCtx` which has the refreshed table schema

3. **Simplified `captureTier1RowDetails`** (lines 1379-1445)
   - Removed complex `buildNestedExpression` logic for chained transforms
   - Now uses simple `__base` vs `column` comparison
   - `__base` is always the correct baseline after Tier 3 reset

4. **Removed unused import**
   - Removed `buildNestedExpression` from imports (line 50)
