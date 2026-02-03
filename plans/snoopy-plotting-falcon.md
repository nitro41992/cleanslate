# Plan: Standardize Unique Value Replacement → Find & Replace

## Status: ✅ Implemented

## Problem Statement

The Standardize panel's "apply mappings" functionality currently:
- Emits a single `standardize:apply` command
- Shows "Standardize Values" in audit log
- Is included in recipes as a corpus-dependent operation (problematic because cluster results vary by dataset)

The user wants unique value replacements to be represented as deterministic Find & Replace transforms so they:
1. Show in audit log as individual "Find & Replace" entries
2. Are captured in recipes as portable, reproducible steps
3. Standardize overall (like Match, Combine, Scrub) becomes out-of-scope for recipes

## Design Decision

**Emit as separate `transform:replace` commands** for each mapping.

Rationale:
- Audit log reflects what actually happened ("replaced 'jon' with 'john'")
- Recipe naturally captures deterministic Find & Replace steps
- More granular undo (can undo individual replacements)
- Matches user mental model

## Changes Required

### 1. StandardizeView.tsx - Emit Find & Replace Commands

**File:** `src/features/standardizer/StandardizeView.tsx`

Change `handleApply()` to:
- Loop through mappings from `getSelectedMappings()`
- Create one `transform:replace` command per mapping
- Execute sequentially (or batch if performance is a concern)

```typescript
// Before (single standardize:apply)
const command = createCommand('standardize:apply', { tableId, column, algorithm, mappings })
await executeWithConfirmation(command, tableId)

// After (multiple transform:replace)
for (const mapping of mappings) {
  const command = createCommand('transform:replace', {
    tableId,
    column: columnName,
    find: mapping.fromValue,
    replace: mapping.toValue,
    caseSensitive: true,   // Exact value match
    matchType: 'exact',    // Full cell value, not substring
  })
  await executor.execute(command)
}
```

### 2. Recipe Exporter - Remove standardize:apply

**File:** `src/lib/recipe/recipe-exporter.ts`

Remove `'standardize:apply'` from `RECIPE_COMPATIBLE_COMMANDS`:

```typescript
// Before
const RECIPE_COMPATIBLE_COMMANDS = [
  'standardize:apply',  // Remove this
  // ... other commands
]
```

### 3. Consider Batch Execution (Optional Enhancement)

If users apply 50+ mappings, 50 separate commands may clutter the audit log. Consider:

**Option A:** Execute as separate commands but group in audit UI
- Commands are separate (granular undo)
- Audit sidebar groups consecutive Find & Replace on same column

**Option B:** Execute as batch but emit individual timeline entries
- Single SQL transaction for performance
- Multiple timeline entries for recipe capture

Recommendation: Start with Option A (simple implementation), optimize if needed.

## Files to Modify

| File | Change |
|------|--------|
| `src/features/standardizer/StandardizeView.tsx` | `handleApply()` emits multiple `transform:replace` |
| `src/lib/recipe/recipe-exporter.ts` | Remove `standardize:apply` from compatible commands |

## Files to Review (No Changes Expected)

- `src/lib/commands/transform/tier1/replace.ts` - Verify `matchType: 'exact'` behavior
- `src/stores/recipeStore.ts` - No changes needed
- `src/lib/commands/standardize/apply.ts` - Can be deprecated or kept for backwards compatibility

## Verification

1. **Manual Test:**
   - Open Standardize panel
   - Run fingerprint clustering on a column
   - Select mappings (e.g., "jon" → "john", "jane" → "Jane")
   - Apply
   - Verify audit log shows individual "Find & Replace" entries
   - Export as recipe
   - Verify recipe contains Find & Replace steps (not standardize)
   - Apply recipe to new table
   - Verify same transformations apply

2. **Edge Cases:**
   - Apply 0 mappings → should show toast "No Changes Selected" (existing behavior)
   - Apply 1 mapping → single Find & Replace in audit
   - Apply 10+ mappings → all appear as Find & Replace
   - Undo → individual Find & Replace commands can be undone separately

## Verified: SQL Equivalence

`transform:replace` with `matchType: 'exact'` + `caseSensitive: true` generates:
```sql
CASE WHEN col = 'find' THEN 'replace' ELSE col END
```

This is equivalent to what `standardize:apply` does via CASE-WHEN. The mapping is direct:

| Standardize Mapping | → | Find & Replace Params |
|---------------------|---|----------------------|
| `fromValue: 'jon'` | → | `find: 'jon'` |
| `toValue: 'john'` | → | `replace: 'john'` |
| (exact match) | → | `matchType: 'exact', caseSensitive: true` |

## Open Questions

1. **Should we delete the `standardize:apply` command entirely?**
   - Recommendation: Keep it for now (backwards compatibility with existing saved timelines)
   - Deprecate in future version

2. **Should consecutive Find & Replace entries be visually grouped in audit UI?**
   - Recommendation: Not in this PR, can be a follow-up enhancement

3. **What about the `_standardize_audit_details` table?**
   - No longer needed for new operations
   - Can be cleaned up in a separate PR

## Implementation Summary

### Changes Made:

1. **`src/features/standardizer/StandardizeView.tsx`**
   - Modified `handleApply()` to emit individual `transform:replace` commands
   - First command uses `executeWithConfirmation` (handles redo state discard dialog)
   - Remaining commands execute sequentially via `executor.execute()`
   - Each command uses `caseSensitive: true` and `matchType: 'exact'`

2. **`src/lib/recipe/recipe-exporter.ts`**
   - Removed `'standardize:apply'` from `INCLUDED_COMMANDS`
   - Removed standardize-specific logic from `getCommandType()`
   - Added `'standardize'` to exclude patterns in `filterRecipeCompatibleEntries()`
