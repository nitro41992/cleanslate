# Plan: Recipe Sidebar Card Improvements

## Summary
Improve recipe step cards with: always-expanded state, user-friendly type labels, better column nesting, and step deduplication.

## Changes

### 1. Cards Always Expanded (RecipePanel.tsx)
**File:** `src/components/panels/RecipePanel.tsx`

Remove the expand/collapse logic from the minimized recipe panel. Currently, cards are collapsed by default with `expandedSteps` state tracking which are open.

**Changes:**
- Remove `expandedSteps` state and `toggleStepExpanded` function (lines 115, 244-255)
- Remove the chevron expand toggle button from step headers (lines 651-660)
- Always render the expanded details section (remove conditional `{isExpanded && ...}` at line 704)

Note: `RecipePanelPrimary.tsx` uses `RecipeStepCard` which is already always expanded.

---

### 2. User-Friendly Type Display (Category: Label format)
**Files:**
- `src/components/panels/RecipePanel.tsx`
- `src/components/recipe/RecipeStepCard.tsx`

Replace technical type (e.g., `transform:replace`) with human-readable "Category: Label" format.

**Current:** Shows `Type: transform:replace` in a code block

**New:** Show "Transform: Find & Replace" or "Scrub: Hash" etc.

**Implementation:**
- Create helper functions:
  ```typescript
  const getCategory = (stepType: string): string => {
    if (stepType.startsWith('scrub:')) return 'Scrub'
    if (stepType.startsWith('standardize:')) return 'Standardize'
    return 'Transform'
  }

  const getReadableType = (step: RecipeStep): string => {
    const transformId = step.type.replace(/^(transform|scrub|standardize):/, '')
    const transform = TRANSFORMATIONS.find((t) => t.id === transformId)
    const category = getCategory(step.type)
    const label = transform?.label || transformId
    return `${category}: ${label}`
  }
  ```
- Replace the code block display with plain text: `{getReadableType(step)}`

---

### 3. Better Step Header Nesting
**Files:**
- `src/components/panels/RecipePanel.tsx`
- `src/components/recipe/RecipeStepCard.tsx`

Current: `Find & Replace → Patient Name` (horizontal, gets truncated)

Proposed: Two-line layout with nested visual:
```
Find & Replace
  ↳ Patient Name
```

**Implementation:**
- Change header layout from single-line truncate to two-line stack
- Use `↳` (corner arrow) or similar for visual nesting
- Apply `pl-4` to the column name line for indentation

**RecipeStepCard.tsx changes (lines 144-154):**
```tsx
{/* Label */}
<div className="flex-1 min-w-0">
  <div className="font-medium text-sm leading-tight">
    {label}
  </div>
  {step.column && (
    <div className="text-xs text-muted-foreground pl-3 flex items-center gap-1">
      <span className="text-muted-foreground/60">↳</span>
      <span className="truncate">{step.column}</span>
    </div>
  )}
</div>
```

---

### 4. Recipe Step Deduplication (Exact Match)
**Files:**
- `src/stores/recipeStore.ts`
- `src/components/panels/CleanPanel.tsx`

Prevent adding duplicate steps to a recipe. A step is **duplicate** if it has:
- Same `type` (e.g., `transform:replace`)
- Same `column`
- Same `params` (deep equality using JSON.stringify)

**Note:** Same transform on different columns is allowed. Same transform on same column with different params is allowed.

**Implementation:**

1. **Update `addStep` in recipeStore.ts** to return a boolean:
```typescript
addStep: (recipeId, step) => {
  const recipe = get().recipes.find(r => r.id === recipeId)
  if (!recipe) return false

  // Check for exact duplicate
  const isDuplicate = recipe.steps.some(existing =>
    existing.type === step.type &&
    existing.column === step.column &&
    JSON.stringify(existing.params) === JSON.stringify(step.params)
  )

  if (isDuplicate) return false

  // ... existing add logic
  return true
}
```

2. **Update CleanPanel.tsx** to show toast on duplicate:
```typescript
const handleAddToExistingRecipe = (recipeId: string) => {
  const step = buildStepFromCurrentForm()
  if (!step) return

  const recipe = recipes.find((r) => r.id === recipeId)
  const added = addStep(recipeId, step)

  if (!added) {
    toast.info('Step already exists in recipe', {
      description: 'This exact step is already in the recipe'
    })
    return
  }
  // ... rest of existing logic
}
```

3. **Update type signature** in recipeStore interface:
```typescript
addStep: (recipeId: string, step: Omit<RecipeStep, 'id'>) => boolean
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/panels/RecipePanel.tsx` | Remove expand/collapse, update type display, update header nesting |
| `src/components/recipe/RecipeStepCard.tsx` | Update type display, update header nesting |
| `src/stores/recipeStore.ts` | Add duplicate detection in `addStep` |
| `src/components/panels/CleanPanel.tsx` | Handle duplicate response with toast |

---

## Verification

1. **Cards always expanded:**
   - Load a recipe with steps in secondary (minimized) Recipe panel
   - Verify all steps show Type, Column, and Parameters without needing to expand
   - No expand/collapse chevrons visible

2. **User-friendly types:**
   - Verify "transform:replace" displays as "Transform: Find & Replace"
   - Verify "scrub:hash" displays as "Scrub: Hash"
   - Verify "standardize:date" displays as "Standardize: Date Format"

3. **Better nesting:**
   - Add a step with a long column name like "Patient Full Name With Title"
   - Verify column name shows on second line with ↳ indent
   - Check the column name is visible without truncation in the header

4. **Deduplication (exact match):**
   - Add "Find & Replace" on "email" with find="foo", replace="bar"
   - Try to add exact same step → should show "Step already exists" toast
   - Add "Find & Replace" on "email" with find="x", replace="y" → should succeed (different params)
   - Add "Find & Replace" on "name" with find="foo", replace="bar" → should succeed (different column)

---

## Implementation Status

**COMPLETED** - All changes implemented:
1. ✅ Removed expand/collapse logic from RecipePanel.tsx (removed expandedSteps state, toggleStepExpanded function, and chevron toggle button)
2. ✅ Added user-friendly type display with getCategory() and getReadableType() helper functions
3. ✅ Updated header layout for better column nesting (two-line layout with ↳ arrow)
4. ✅ Added duplicate detection in recipeStore.ts addStep() - returns boolean
5. ✅ Updated CleanPanel.tsx to handle duplicate response with info toast

Build passes with `npm run build`.
