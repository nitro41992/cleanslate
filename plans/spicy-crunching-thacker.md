# Fix: Formula Builder recipe steps bypass column mapping dialog

## Root Cause

There are **two copies** of `extractRequiredColumns` — one in `recipeStore.ts` (used at runtime) and one in `recipe-exporter.ts` (used for audit export). The store version is **missing formula-specific column extraction**:

| Column source | `recipe-exporter.ts` | `recipeStore.ts` |
|---|---|---|
| `step.column` | Yes | Yes |
| `step.params.column` | Yes | Yes |
| `step.params.sourceColumns` | Yes | Yes |
| `step.params.columns` | Yes | Yes |
| `step.params.rules[].column` | Yes | Yes |
| **`step.params.referencedColumns`** | **Yes** | **MISSING** |
| **`step.params.targetColumn`** | **Yes** | **MISSING** |

Because the store version misses formula columns, `recipe.requiredColumns` is empty for formula-only recipes. `matchColumns([], tableColumns)` returns zero unmapped columns, so the mapping dialog never appears. Execution proceeds directly, the formula command validates, finds the missing column, and throws.

## Fix

**DRY: Replace the store's local function with an import from the exporter.**

### File: `src/stores/recipeStore.ts`

1. Add import at top:
   ```typescript
   import { extractRequiredColumns } from '@/lib/recipe/recipe-exporter'
   ```

2. Delete the local `extractRequiredColumns` function (lines 319-364).

No other files need changes. The exporter version is a strict superset. No circular dependency risk (`recipe-exporter.ts` only imports from `@/types`).

### Call sites affected (all inside `recipeStore.ts`, no signature change):
- Line 187: `addStep` — `requiredColumns: extractRequiredColumns([...r.steps, newStep])`
- Line 205: `updateStep` — `requiredColumns: extractRequiredColumns(...)`
- Line 222: `removeStep` — `requiredColumns: extractRequiredColumns(...)`

## Verification

1. Load a table (e.g. `messy_HR_data`)
2. Create a recipe with a Formula Builder step referencing columns specific to that table (e.g. `ROUND(@UnrelatedMetric, 2)`, replace mode → `UnrelatedMetric`)
3. Switch to a different table that lacks those columns
4. Click "Apply" on the recipe
5. **Expected:** Column mapping dialog appears with `UnrelatedMetric` listed as unmapped
6. Map it to an appropriate column → recipe executes successfully
