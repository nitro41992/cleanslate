# Plan: Undo Recipe Deletion via Toast Action

## Approach

Replace the confirmation dialog with an **undo toast** — the modern pattern used by Gmail, Slack, and Figma. Delete immediately on click, show a 6-second toast with an "Undo" button. If clicked, the recipe is fully restored. If the toast expires, deletion is permanent.

This is strictly better UX than a confirmation dialog: faster (one click vs two) and more forgiving (reversible after the fact).

## Changes (3 files)

### 1. `src/stores/recipeStore.ts` — Add `restoreRecipe` action

Add to `RecipeActions` interface (after line 67):
```typescript
restoreRecipe: (recipe: Recipe) => void
```

Add implementation (after `deleteRecipe`, after line 153):
```typescript
restoreRecipe: (recipe) => {
  set((state) => ({
    recipes: [...state.recipes, recipe],
    selectedRecipeId: recipe.id,
    buildMode: 'view',
  }))
},
```

Why a new action instead of reusing `addRecipe`: `addRecipe` generates a new ID and timestamps. We need to restore the exact original recipe (same ID, timestamps, step IDs).

### 2. `src/components/panels/RecipePanel.tsx` — Undo toast

- **Line 85**: Add `const restoreRecipe = useRecipeStore((s) => s.restoreRecipe)`
- **Line 102**: Remove `const [showDeleteDialog, setShowDeleteDialog] = useState(false)`
- **Lines 256-261**: Rewrite handler:
  ```typescript
  const handleDeleteRecipe = () => {
    if (!selectedRecipe) return
    const deletedRecipe = { ...selectedRecipe }
    deleteRecipe(deletedRecipe.id)
    toast('Recipe deleted', {
      duration: 6000,
      action: {
        label: 'Undo',
        onClick: () => restoreRecipe(deletedRecipe),
      },
    })
  }
  ```
- **Line 708**: Change `onClick={() => setShowDeleteDialog(true)}` → `onClick={handleDeleteRecipe}`
- **Lines 748-766**: Delete the entire `{/* Delete Confirmation Dialog */}` block

### 3. `src/components/panels/RecipePanelPrimary.tsx` — Same changes

- **Line 69**: Add `const restoreRecipe = useRecipeStore((s) => s.restoreRecipe)`
- **Line 86**: Remove `const [showDeleteDialog, setShowDeleteDialog] = useState(false)`
- **Lines 214-219**: Rewrite handler (same pattern as above)
- **Line 556**: Change `onClick={() => setShowDeleteDialog(true)}` → `onClick={handleDeleteRecipe}`
- **Lines 701-719**: Delete the entire `{/* Delete Confirmation Dialog */}` block

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to hold deleted recipe | Closure in handler | Zero state overhead; lives exactly as long as the toast |
| Toast system | Sonner (already imported) | Both panels already use `toast` from sonner; action API is clean |
| Confirmation dialog | Remove entirely | Undo toast replaces it — "This cannot be undone" would be a lie |
| Toast style | Neutral `toast()` not `toast.success()` | Deleting isn't a success; neutral is more appropriate |
| Duration | 6 seconds | Standard undo window (Gmail uses ~5s, Slack ~8s) |

## Edge Cases

- **Rapid multiple deletions**: Each closure captures its own recipe; Sonner stacks toasts; each undo is independent
- **Deleted recipe was selected**: `deleteRecipe` clears selection; `restoreRecipe` re-selects it
- **Persistence timing**: Debounced at 500ms. If undo < 500ms, the delete never hits OPFS. If undo > 500ms, two saves occur (one without, one with) — both correct

## Verification

1. Delete a recipe → toast with "Undo" appears for 6s
2. Click Undo → recipe reappears, is selected, all steps/timestamps intact
3. Let toast expire → recipe is permanently gone
4. Delete two recipes rapidly → two toasts, each undo restores the correct one
5. Delete last recipe → empty state → undo → recipe returns
6. `npm run build` passes (type check)
