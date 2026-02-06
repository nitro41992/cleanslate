# Plan: Modify Recipe Step

## Scope
Users can edit a recipe step's **column** and **params** (not the transform type) via a pencil icon on `RecipeStepCard`. The step opens in CleanPanel's transform tab with live preview against the active table. Saving updates the step in place with a warning dialog that offers a JSON backup download.

---

## Files to Modify (4) + Create (1)

### New
| File | Purpose |
|------|---------|
| `src/components/recipe/ConfirmStepUpdateDialog.tsx` | Warning dialog with backup download before destructive update |

### Modified
| File | Change |
|------|--------|
| `src/stores/recipeStore.ts` | Add `editingStepContext` state + 3 actions |
| `src/components/recipe/RecipeStepCard.tsx` | Add pencil icon button, `onEdit` prop |
| `src/components/panels/RecipePanelPrimary.tsx` | Wire `onEdit` → `startEditingStep` + panel transition |
| `src/components/panels/CleanPanel.tsx` | Edit-step mode: pre-populate form, lock picker, swap Apply for Update Step, banner, dialog |

### DRY Refactor
| File | Change |
|------|--------|
| `src/lib/recipe/recipe-exporter.ts` | Extract `downloadRecipeAsJson(recipe)` utility (currently duplicated in RecipePanel + RecipePanelPrimary) |
| `src/components/panels/RecipePanel.tsx` | Use shared `downloadRecipeAsJson` |
| `src/components/panels/RecipePanelPrimary.tsx` | Use shared `downloadRecipeAsJson` |

---

## Implementation Steps

### 1. Extract shared export utility
**File:** `src/lib/recipe/recipe-exporter.ts` (existing)

Add `downloadRecipeAsJson(recipe: Recipe)` — the blob-download logic currently copy-pasted in both `RecipePanel.tsx:253` and `RecipePanelPrimary.tsx:220`. Refactor both callers to use it.

### 2. Add editing state to recipeStore
**File:** `src/stores/recipeStore.ts`

```typescript
// New state
editingStepContext: {
  recipeId: string
  stepId: string
  originalStep: RecipeStep  // snapshot for cancel
} | null

// New actions
startEditingStep(recipeId, stepId)   // captures snapshot, sets context
cancelEditingStep()                   // clears context, no changes
commitEditingStep(updates)            // calls updateStep(), clears context
```

`editingStepContext` is excluded from the persistence subscription (it's transient UI state like `buildMode`).

### 3. Add edit button to RecipeStepCard
**File:** `src/components/recipe/RecipeStepCard.tsx`

- Add optional `onEdit?: () => void` prop
- Render a `Pencil` icon button in the action buttons row (between move-down and the enable/disable switch)
- Disabled with tooltip for `scrub:batch` steps ("Privacy batch steps cannot be edited inline") and unknown transform types
- Button has `aria-label="Edit step"`

### 4. Wire edit in RecipePanelPrimary
**File:** `src/components/panels/RecipePanelPrimary.tsx`

- Pass `onEdit` to each `RecipeStepCard` instance
- `onEdit` callback: calls `startEditingStep(selectedRecipe.id, step.id)`, then does the same panel transition as `handleAddStep` (line 283-291): `setActivePanel('clean')`, `setSecondaryPanel('recipe')`

### 5. Create ConfirmStepUpdateDialog
**File:** `src/components/recipe/ConfirmStepUpdateDialog.tsx`

Follows `ConfirmDiscardDialog.tsx` pattern (shadcn AlertDialog):
- **Title:** "Update Recipe Step?" with `AlertTriangle` icon
- **Body:** "This will permanently modify this step. There is no versioning — the original configuration will be lost."
- **Actions:**
  - `Download Backup` button (outline) — calls `downloadRecipeAsJson(recipe)`
  - `Cancel` — closes dialog
  - `Update Step` button (primary) — confirms update

Uses `Button` for confirm (not `AlertDialogAction`) to avoid the race condition documented in `ConfirmDiscardDialog`.

### 6. Edit-step mode in CleanPanel
**File:** `src/components/panels/CleanPanel.tsx`

**A. Pre-populate form** — `useEffect` watching `editingStepContext`:
- Look up `TransformationDefinition` via `getTransformId(step.type)` from `transform-lookup.ts`
- Set `selectedTransform` to the definition (locked)
- Set `selectedColumn` from `step.column` (editable — user remaps for new dataset)
- Convert `step.params` (Record<string, unknown>) to `Record<string, string>` and set `params`
- For `excel_formula` steps: switch to formula tab, populate `formulaParams` instead

**B. Conditional UI** when `editingStepContext !== null`:
- **Banner** at top of config area: "Editing step N of [Recipe Name]" with a Cancel link that calls `cancelEditingStep()`
- **Picker**: disabled/read-only (transform type is locked)
- **Apply button**: text changes to "Update Step", on click opens `ConfirmStepUpdateDialog` instead of executing
- **AddToRecipeButton**: hidden
- **Cancel button**: calls `cancelEditingStep()`

**C. On confirm**: call `commitEditingStep({ column, params, label })` from the current form state, show toast "Recipe step updated"

**D. On cancel / exit**: `useEffect` cleanup resets form when `editingStepContext` becomes null (tracked via ref to avoid mount reset)

---

## Edge Cases

| Case | Handling |
|------|----------|
| Step column doesn't exist in active table | Column selector shows empty — user picks a new column. This IS the "adapt for new dataset" workflow. |
| No active table loaded | Form opens but preview shows nothing, Update button still works (updates recipe definition only) |
| Formula steps (`excel_formula`) | Switches to formula tab, pre-populates `formulaParams` |
| `scrub:batch` steps | Edit button disabled with tooltip — too complex for v1 |
| Unknown transform type | Edit button disabled with tooltip |
| User navigates away mid-edit | `cancelEditingStep()` called on panel unmount |

---

## Out of Scope (Intentional)
- Edit from secondary RecipePanel (inline cards) — same pattern, can follow later
- Recipe versioning
- Running the edited step against the table (preview only, step updates recipe definition)

---

## Verification
1. Create a recipe with a `replace` step (find: "foo", replace: "bar")
2. Load a new dataset, click pencil on the step
3. Verify form pre-populated with "foo"/"bar", column editable
4. Change find to "baz", pick a new column
5. Click Update Step → warning dialog appears
6. Click Download Backup → JSON downloads
7. Click Update Step → step updated in recipe, toast shown
8. Verify recipe panel reflects new params
9. Cancel flow: click pencil, make changes, click Cancel Edit → no changes to recipe
