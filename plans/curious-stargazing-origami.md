# Plan: Include Privacy/Scrub Columns in Recipe Column Mapping

## Problem

When a recipe contains a Privacy step (`scrub:batch` command), the columns used by that step are not included in:
1. The column mapping dialog (when applying a recipe to a table with different column names)
2. The "N columns" badge count displayed in the recipe UI

This causes the recipe to fail when applied because unmapped columns in the Privacy step can't be found.

**Example from screenshots:**
- Recipe shows "2 columns" but Privacy step has 4 rules (Name, Joining Date, Phone Number, Position)
- Column mapping dialog only shows Department and Joining Date (from steps 1-2)
- Error: `Column "Joining Date" not found in table` because the Privacy step columns weren't mapped

## Root Cause

The `extractRequiredColumns()` function extracts columns from:
- `step.column`
- `step.params.sourceColumns`
- `step.params.column`
- `step.params.columns`

But **NOT** from:
- `step.params.rules` - array of `ScrubBatchRule` objects used by `scrub:batch`

Each `ScrubBatchRule` has a `column` property that needs to be extracted.

Additionally, `applyMappingToParams()` doesn't map column names inside the `rules` array.

## Files to Modify

| File | Line | Change |
|------|------|--------|
| `src/stores/recipeStore.ts` | 323-354 | Add `rules` extraction to `extractRequiredColumns()` |
| `src/lib/recipe/recipe-exporter.ts` | 200-230 | Add same `rules` extraction logic |
| `src/lib/recipe/column-matcher.ts` | 161-180 | Update `applyMappingToParams()` to map columns in `rules` |

## Implementation

### 1. Update `extractRequiredColumns()` in `recipeStore.ts` (line 350)

Add after the `columns` array check:

```typescript
// For scrub:batch rules
const rules = step.params.rules as Array<{ column: string }> | undefined
if (rules && Array.isArray(rules)) {
  rules.forEach((rule) => {
    if (rule && typeof rule.column === 'string') {
      columns.add(rule.column)
    }
  })
}
```

### 2. Update `extractRequiredColumns()` in `recipe-exporter.ts` (line 226)

Add identical logic after the `cols` array check.

### 3. Update `applyMappingToParams()` in `column-matcher.ts` (line 174)

Add handling for `rules` array:

```typescript
} else if (key === 'rules' && Array.isArray(value)) {
  // Map columns inside scrub:batch rules
  result[key] = value.map((rule) => {
    if (rule && typeof rule === 'object' && 'column' in rule && typeof rule.column === 'string') {
      return { ...rule, column: mapping[rule.column] || rule.column }
    }
    return rule
  })
}
```

## Verification

### Manual Testing
1. Create a recipe with:
   - A regular transform (e.g., Standardize Date on "Joining Date")
   - A Privacy step with multiple column rules (e.g., Name→hash, Phone Number→redact)
2. Verify the column count badge shows all columns (not just 2)
3. Apply the recipe to a table with different column names
4. Verify the mapping dialog shows ALL columns including Privacy step columns
5. Map the columns and apply - verify the recipe executes without errors

### E2E Test (if existing recipe E2E tests)
```bash
npx playwright test "recipe" --timeout=90000 --retries=0 --reporter=line
```

## Impact

- **Low risk**: Changes are additive - only adding new extraction logic
- **No breaking changes**: Existing recipes work unchanged
- **Backwards compatible**: Old recipes without `rules` are unaffected
