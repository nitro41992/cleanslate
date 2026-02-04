# Recipe Panel Navigation Redesign

## Summary

Add a Recipe toggle button to the Transform panel header, and replace icon-only expand/collapse buttons with explicit text buttons ("Full View" / "Compact").

## Changes

### 1. CleanPanel.tsx - Add Header Bar with Recipe Toggle

**File:** `src/components/panels/CleanPanel.tsx`

Add a minimal header bar above the two-column layout (before line 593):

```tsx
<div className="flex flex-col h-full">
  {/* Header bar with Recipe toggle */}
  <div className="flex items-center justify-end px-4 py-2 border-b border-border/40 shrink-0">
    <Button
      variant={secondaryPanel === 'recipe' ? 'secondary' : 'outline'}
      size="sm"
      onClick={handleToggleRecipe}
      className="gap-2"
    >
      <BookOpen className="w-4 h-4" />
      Recipe
      {selectedRecipe?.steps.length > 0 && (
        <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
          {selectedRecipe.steps.length}
        </Badge>
      )}
    </Button>
  </div>

  {/* Existing two-column layout */}
  <div className="flex flex-1 min-h-0">
    ...
  </div>
</div>
```

**New imports:**
- `BookOpen` from lucide-react
- `Badge` from `@/components/ui/badge`

**New state access:**
- `secondaryPanel` from previewStore
- `selectedRecipe` via `selectSelectedRecipe` selector from recipeStore

**Toggle handler:**
```tsx
const handleToggleRecipe = () => {
  if (secondaryPanel === 'recipe') {
    closeSecondaryPanel()
  } else {
    setSecondaryPanel('recipe')
  }
}
```

---

### 2. RecipePanel.tsx - Replace Icon with "Full View" Button

**File:** `src/components/panels/RecipePanel.tsx`

Replace lines 372-384 (Maximize2 icon button with tooltip):

**Before:**
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleExpandToRecipePanel}>
      <Maximize2 className="w-4 h-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent side="bottom">Expand to full Recipe view</TooltipContent>
</Tooltip>
```

**After:**
```tsx
<Button
  variant="outline"
  size="sm"
  className="h-8 shrink-0"
  onClick={handleExpandToRecipePanel}
>
  Full View
</Button>
```

Remove `Maximize2` from imports.

---

### 3. RecipePanelPrimary.tsx - Replace Icon with "Compact" Button

**File:** `src/components/panels/RecipePanelPrimary.tsx`

Replace lines 327-339 (Minimize2 icon button with tooltip):

**Before:**
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCollapseToClean}>
      <Minimize2 className="w-3.5 h-3.5" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>Collapse to Clean view</TooltipContent>
</Tooltip>
```

**After:**
```tsx
<Button
  variant="outline"
  size="sm"
  className="h-7"
  onClick={handleCollapseToClean}
>
  Compact
</Button>
```

Remove `Minimize2` from imports.

---

## Files Modified

| File | Change |
|------|--------|
| `src/components/panels/CleanPanel.tsx` | Add header bar with Recipe toggle button |
| `src/components/panels/RecipePanel.tsx` | Replace Maximize2 icon → "Full View" text button |
| `src/components/panels/RecipePanelPrimary.tsx` | Replace Minimize2 icon → "Compact" text button |

## No Changes Needed

- `previewStore.ts` - Existing state (`secondaryPanel`, `setSecondaryPanel`, `closeSecondaryPanel`) is sufficient
- `recipeStore.ts` - Existing `selectSelectedRecipe` selector works for badge display

## Verification

1. Open app with no Recipe panel → Recipe button shows `outline` variant
2. Click Recipe button → Recipe panel opens as secondary (340px), button changes to `secondary` variant
3. Click Recipe button again → Recipe panel closes
4. With Recipe panel open, click "Full View" → Navigates to full RecipePanelPrimary (880px)
5. Click "Compact" → Returns to Clean + Recipe secondary mode
6. Create recipe with steps → Badge shows step count on Recipe button
