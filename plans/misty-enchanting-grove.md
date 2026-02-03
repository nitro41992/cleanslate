# Plan: Distinguish Unique vs Actionable Standardizations for Recipe Export

## Problem Statement

After commit `1f04f5c`, ALL standardize operations (both unique and actionable) are converted to `transform:replace` commands. This is problematic because:

1. **Actionable tab standardizations** use fuzzy matching logic (fingerprint, metaphone, etc.) to cluster similar values
2. **Fuzzy matching logic should NOT be part of recipe creation** - recipes should be deterministic
3. We need a way to **distinguish and exclude** the fuzzy-matching-based operations from recipes

## Current Behavior (After 1f04f5c)

```
User applies standardization → ALL mappings become transform:replace
                             ↓
                       Recipe exports ALL as "Find & Replace"
                             ↓
                       Problem: Fuzzy-based mappings in recipes
```

## Desired Behavior

```
Unique tab (single-value clusters)     → transform:replace → IN recipes
Actionable tab (multi-value clusters)  → standardize:apply → EXCLUDED from recipes
```

## Key Files to Modify

1. `src/stores/standardizerStore.ts` - Add `isUnique` flag to mappings
2. `src/features/standardizer/StandardizeView.tsx` - Conditionally emit different command types

## Implementation Steps

### Step 1: Update Mapping Type in standardizerStore.ts

Add `isUnique` flag to the mappings returned by `getSelectedMappings()`:

```typescript
// Line 465: Update the mappings type
const mappings: { fromValue: string; toValue: string; rowCount: number; isUnique: boolean }[] = []

// Line 473-477: For single-value clusters (unique), add isUnique: true
mappings.push({
  fromValue: value.value,
  toValue: value.customReplacement,
  rowCount: value.count,
  isUnique: true,  // NEW
})

// Line 488-492: For multi-value clusters (actionable), add isUnique: false
mappings.push({
  fromValue: value.value,
  toValue: masterValue.value,
  rowCount: value.count,
  isUnique: false,  // NEW
})
```

### Step 2: Update StandardizeView.tsx handleApply()

Split mappings into unique and actionable, then emit different command types:

**Key changes:**
1. Partition mappings by `isUnique` flag
2. Execute unique mappings as `transform:replace` (current behavior)
3. Execute actionable mappings as single `standardize:apply` command

```typescript
// Partition mappings
const uniqueMappings = mappings.filter(m => m.isUnique)
const actionableMappings = mappings.filter(m => !m.isUnique)

// Execute unique mappings as transform:replace (recipe-compatible)
for (const mapping of uniqueMappings) {
  const cmd = createCommand('transform:replace', {
    tableId,
    column: columnName,
    find: mapping.fromValue,
    replace: mapping.toValue,
    caseSensitive: true,
    matchType: 'exact',
  })
  await executor.execute(cmd)
}

// Execute actionable mappings as standardize:apply (excluded from recipes)
if (actionableMappings.length > 0) {
  const cmd = createCommand('standardize:apply', {
    tableId,
    column: columnName,
    algorithm,  // From standardizerStore
    mappings: actionableMappings.map(m => ({
      fromValue: m.fromValue,
      toValue: m.toValue,
    })),
  })
  await executor.execute(cmd)
}
```

**Note:** The `standardize:apply` command requires an `algorithm` parameter (fingerprint, metaphone, token_phonetic). This is already tracked in the standardizerStore.

### Step 3: Verify Recipe Exporter (No Changes Needed)

In `src/lib/recipe/recipe-exporter.ts`:
- ✅ `standardize:apply` is NOT in `INCLUDED_COMMANDS` (line 62 comment)
- ✅ Filter pattern excludes "standardize" (line 252)
- ✅ `transform:replace` IS included (line 35)

## Verification

1. **Apply unique standardization** (All tab) → shows as "Find & Replace" in audit → appears in recipe export
2. **Apply actionable standardization** (Actionable tab) → shows as "Standardize Values" in audit → NOT in recipe export
3. **Export recipe** → only contains Find & Replace commands, no standardize commands
4. **Import recipe on new dataset** → deterministic behavior (no fuzzy matching)

## Files & Line Numbers

| File | Lines | Change |
|------|-------|--------|
| `src/stores/standardizerStore.ts` | 465, 473-477, 488-492 | Add `isUnique` flag to mappings |
| `src/features/standardizer/StandardizeView.tsx` | 128-221 | Split by `isUnique`, emit different commands |

## Summary

| Standardization Type | Command Emitted | In Recipe? | Rationale |
|---------------------|-----------------|------------|-----------|
| Unique (All tab) | `transform:replace` | ✅ Yes | User-defined, deterministic |
| Actionable (Actionable tab) | `standardize:apply` | ❌ No | Uses fuzzy matching, not reproducible |
