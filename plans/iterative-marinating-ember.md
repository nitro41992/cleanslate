# Plan: Formula Builder Recipe Integration

## Summary
Integrate Formula Builder into the recipe system so users can add formula steps to recipes. Show referenced columns on recipe cards and validate column existence when applying recipes.

## Changes Overview

### 1. Add to Recipe System
**File:** `src/lib/recipe/recipe-exporter.ts`

Add `'transform:excel_formula'` to `INCLUDED_COMMANDS` set (after line 53, with other Tier 3 transforms):
```typescript
'transform:custom_sql',
'transform:excel_formula', // ADD THIS
```

Update `extractRequiredColumns()` (after line 235) to handle formula columns:
```typescript
// For excel_formula: add referencedColumns
const referencedColumns = step.params?.referencedColumns as string[] | undefined
if (referencedColumns && Array.isArray(referencedColumns)) {
  referencedColumns.forEach((c) => columns.add(c))
}

// For excel_formula replace mode: targetColumn is a dependency
const targetColumn = step.params?.targetColumn as string | undefined
if (targetColumn) {
  columns.add(targetColumn)
}
```

### 2. Store Column References When Building Recipe Step
**File:** `src/components/panels/CleanPanel.tsx`

In `buildStepFromCurrentForm()`, add special handling for `excel_formula` that:
- Extracts column references from formula using `extractColumnRefs()` from `@/lib/formula`
- Stores them in `step.params.referencedColumns`
- Sets appropriate label based on output mode

### 3. Update Column Mapping for Formulas
**File:** `src/lib/recipe/column-matcher.ts`

In `applyMappingToParams()`, add handling for:
- `referencedColumns` array mapping
- `formula` string - replace `@columnName` and `@[Column Name]` references
- `targetColumn` string mapping

Add helper function `applyMappingToFormula(formula, mapping)` to replace column refs in formula text.

### 4. Display Formula Columns in Recipe Card
**File:** `src/components/recipe/RecipeStepCard.tsx`

The card already shows all params via `getAllParams()`. For formula steps, the params will display:
- `formula` - the formula expression
- `outputMode` - "new" or "replace"
- `outputColumn` or `targetColumn` - the output column
- `referencedColumns` - array of columns used

Add custom formatting in `format-helpers.tsx` for `referencedColumns` to show as `@Column` format.

### 5. Update Audit Text
**File:** `src/lib/commands/transform/tier3/excel-formula.ts`

Change lines 239-240 from `"Excel Formula →"` to `"Formula Builder →"`:
```typescript
action: outputMode === 'new'
  ? `Formula Builder → ${outputColumn}`
  : `Formula Builder → ${targetColumn}`,
```

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/recipe/recipe-exporter.ts` | Add to INCLUDED_COMMANDS, update extractRequiredColumns |
| `src/components/panels/CleanPanel.tsx` | Store referencedColumns when building recipe step |
| `src/lib/recipe/column-matcher.ts` | Add formula column mapping |
| `src/lib/recipe/format-helpers.tsx` | Format referencedColumns as @Column |
| `src/lib/commands/transform/tier3/excel-formula.ts` | Update audit text |

## Verification

1. **Manual Testing:**
   - Apply Formula Builder transform, click "Add to Recipe"
   - Verify recipe card shows formula, output column, and referenced columns
   - Apply recipe to same table - should work
   - Apply recipe to table with different column names - mapping dialog should appear
   - Apply recipe to table missing columns - should show error

2. **Check Audit Log:**
   - Apply Formula Builder, verify audit shows "Formula Builder →" not "Excel Formula →"

3. **Check Undo/Redo:**
   - Apply formula via recipe, undo, redo - params should preserve correctly
