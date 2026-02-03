# Recipe Panel UX Redesign Plan

## UX Inspiration

Modern data tools like [Retool](https://retool.com/integrations/notion) and Notion emphasize **progressive disclosure** - show simple controls first, reveal complexity only when needed. Key patterns:

- **Action → Capture flow**: Apply a transform, then offer to save it (not the other way around)
- **Inline secondary actions**: Dropdowns that expand options without modal interruption
- **Tight coupling of related features**: Recipe as a "sidebar companion" to Clean, not a separate destination

---

## Problem Summary

The current Recipe panel has several UX issues:
1. **Overlapping close icons** - Sheet component's built-in X overlaps with FeaturePanel's secondary panel close button
2. **No way to add transforms to recipe** - Clean panel applies transforms but lacks "Add to Recipe" action
3. **Design inconsistency** - Recipe panel has its own two-column picker layout that looks distinct from Clean
4. **Recipe as standalone** - Recipe can be opened as primary panel, but should only be secondary to Clean

## Design Direction: "Methodical Precision"

Maintain the Notion-inspired minimal aesthetic. Recipe becomes a **compact companion tray** to Clean, not a full-featured panel. The focus is on:
- Capturing transforms from Clean (primary use case)
- Simple step management (enable/disable, reorder, delete)
- Export/import for templates

---

## Implementation Plan

### 1. Fix Overlapping Close Icons

**File:** `src/components/ui/sheet.tsx`

Remove the built-in Radix close button from SheetContent. FeaturePanel already handles panel closing via its header.

**Change:** Remove lines 64-67 (the `SheetPrimitive.Close` button)

```tsx
// BEFORE (lines 63-68)
<SheetPrimitive.Content>
  <SheetPrimitive.Close className="absolute right-4 top-4...">
    <X className="h-4 w-4" />
  </SheetPrimitive.Close>
  {children}
</SheetPrimitive.Content>

// AFTER - Remove the Close button entirely
<SheetPrimitive.Content>
  {children}
</SheetPrimitive.Content>
```

This leaves panel closing to FeaturePanel's existing close mechanism (ESC key, click outside, or header button when in dual mode).

---

### 2. Remove Recipe as Standalone Panel

**File:** `src/components/layout/ActionToolbar.tsx`

Remove Recipe from the toolbar actions entirely. Recipe will only be accessible via the Clean panel.

**Changes:**
- Remove `'recipe'` from the `actions` array (lines 60-66)
- Remove Recipe-specific click handling logic (lines 105-121)

**File:** `src/components/layout/FeaturePanel.tsx`

Remove `recipe` from `panelMeta` since it won't be a primary panel.

**File:** `src/stores/previewStore.ts`

Update `PanelType` to remove `'recipe'` as a valid primary panel type (keep it for secondary).

---

### 3. Add "Add to Recipe" Actions in Clean Panel

**File:** `src/components/panels/CleanPanel.tsx`

Add two new actions after the Apply button:

#### 3a. Split Button with Dropdown for "Add to Recipe"

After the primary "Apply Transformation" button, add a secondary "Add to Recipe" dropdown:

```tsx
{/* Apply Button (existing) */}
<Button onClick={handleApply} disabled={isApplying || !isValid()}>
  <Sparkles className="w-4 h-4 mr-2" />
  Apply Transformation
</Button>

{/* NEW: Add to Recipe Dropdown */}
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="outline" disabled={!isValid()}>
      <BookOpen className="w-4 h-4 mr-2" />
      Add to Recipe
      <ChevronDown className="w-3 h-3 ml-2" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={handleAddToNewRecipe}>
      <Plus className="w-4 h-4 mr-2" />
      Create New Recipe...
    </DropdownMenuItem>
    {recipes.length > 0 && (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Add to Existing</DropdownMenuLabel>
        {recipes.map(recipe => (
          <DropdownMenuItem
            key={recipe.id}
            onClick={() => handleAddToExistingRecipe(recipe.id)}
          >
            {recipe.name}
            <span className="ml-auto text-xs text-muted-foreground">
              {recipe.steps.length} steps
            </span>
          </DropdownMenuItem>
        ))}
      </>
    )}
  </DropdownMenuContent>
</DropdownMenu>
```

#### 3b. Handler Functions

```tsx
const handleAddToNewRecipe = () => {
  if (!selectedTransform) return

  // Create the step from current form state
  const step = buildStepFromCurrentForm()

  // Open dialog to name new recipe, then add step
  setShowNewRecipeDialog(true)
  setPendingStep(step)
}

const handleAddToExistingRecipe = (recipeId: string) => {
  if (!selectedTransform) return

  const step = buildStepFromCurrentForm()
  addStep(recipeId, step)

  // Open Recipe secondary panel to show the added step
  setSecondaryPanel('recipe')
  setSelectedRecipe(recipeId)

  toast.success('Step added to recipe', {
    description: `Added ${selectedTransform.label} to recipe`
  })
}

const buildStepFromCurrentForm = (): Omit<RecipeStep, 'id'> => {
  // Build step params from current form state
  const stepParams: Record<string, unknown> = {}
  if (selectedTransform?.params) {
    for (const param of selectedTransform.params) {
      if (params[param.name]) {
        if (param.type === 'number') {
          stepParams[param.name] = parseInt(params[param.name], 10)
        } else if (param.name === 'columns') {
          stepParams[param.name] = params[param.name].split(',').map((c) => c.trim())
        } else {
          stepParams[param.name] = params[param.name]
        }
      }
    }
  }

  return {
    type: `transform:${selectedTransform!.id}`,
    label: `${selectedTransform!.label}${selectedColumn ? ` → ${selectedColumn}` : ''}`,
    column: selectedTransform!.requiresColumn ? selectedColumn : undefined,
    params: Object.keys(stepParams).length > 0 ? stepParams : undefined,
    enabled: true,
  }
}
```

#### 3c. New Recipe Dialog (inline in CleanPanel)

```tsx
{/* New Recipe Dialog */}
<Dialog open={showNewRecipeDialog} onOpenChange={setShowNewRecipeDialog}>
  <DialogContent className="max-w-sm">
    <DialogHeader>
      <DialogTitle>Create New Recipe</DialogTitle>
      <DialogDescription>
        The current transform will be added as the first step.
      </DialogDescription>
    </DialogHeader>
    <div className="py-4">
      <Label htmlFor="new-recipe-name">Recipe Name</Label>
      <Input
        id="new-recipe-name"
        value={newRecipeName}
        onChange={(e) => setNewRecipeName(e.target.value)}
        placeholder="e.g., Email Cleanup"
        className="mt-2"
        autoFocus
      />
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setShowNewRecipeDialog(false)}>
        Cancel
      </Button>
      <Button onClick={handleCreateRecipeWithStep}>
        Create & Add Step
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

---

### 4. Simplify Recipe Secondary Panel

**File:** `src/components/panels/RecipePanel.tsx`

Completely rewrite RecipePanel to be a simple, compact component that only shows:
- Recipe selector dropdown (if multiple recipes exist)
- Simple numbered step list with toggle switches
- Import/Export buttons
- Apply Recipe button

Remove:
- `buildMode` and all its complex logic
- The embedded GroupedTransformationPicker (transforms come from Clean panel now)
- Two-column layout
- Complex step expansion/configuration

**New simplified RecipePanel structure:**

```tsx
export function RecipePanel() {
  // All props removed - always compact mode since it's always secondary

  return (
    <div className="flex flex-col h-full">
      {/* Header: Recipe selector or empty state */}
      <div className="p-3 border-b border-border/30">
        {recipes.length > 0 ? (
          <Select value={selectedRecipeId || ''} onValueChange={setSelectedRecipe}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select recipe..." />
            </SelectTrigger>
            <SelectContent>
              {recipes.map(r => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-2">
            No recipes yet
          </p>
        )}
      </div>

      {/* Steps list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {selectedRecipe?.steps.map((step, index) => (
            <div
              key={step.id}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm",
                step.enabled
                  ? "bg-muted/30"
                  : "bg-muted/10 opacity-50"
              )}
            >
              <span className="text-xs text-muted-foreground w-4">
                {index + 1}.
              </span>
              <span className="text-sm">{getStepIcon(step)}</span>
              <span className="flex-1 truncate text-xs">
                {formatStepLabel(step)}
              </span>
              <Switch
                checked={step.enabled}
                onCheckedChange={() => toggleStepEnabled(selectedRecipe.id, step.id)}
                className="scale-75"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-destructive"
                onClick={() => removeStep(selectedRecipe.id, step.id)}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}

          {selectedRecipe?.steps.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">
              Use "Add to Recipe" in the transform form to add steps
            </p>
          )}
        </div>
      </ScrollArea>

      {/* Footer actions */}
      <div className="p-2 border-t border-border/30 flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleImport}>
              <Upload className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import recipe</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleExport}
              disabled={!selectedRecipe || selectedRecipe.steps.length === 0}
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Export recipe</TooltipContent>
        </Tooltip>

        <div className="flex-1" />

        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={handleApplyRecipe}
          disabled={!selectedRecipe || selectedRecipe.steps.filter(s => s.enabled).length === 0}
        >
          <Play className="w-3 h-3 mr-1.5" />
          Apply
        </Button>
      </div>
    </div>
  )
}
```

---

### 5. Update FeaturePanel for Clean+Recipe Only

**File:** `src/components/layout/FeaturePanel.tsx`

Simplify to handle only the Clean panel as primary, with Recipe as always-available secondary:

- Remove Recipe from `panelMeta` primary panel options
- When Clean is open, show a toggle to expand/collapse Recipe sidebar
- Recipe sidebar should use same visual styling as Clean (no distinct background)

**Changes to header:**
- When Clean panel is open, add a small "Recipe" toggle button in the header
- Clicking it toggles the secondary panel on/off

---

### 6. Update App.tsx

**File:** `src/App.tsx`

- Remove `case 'recipe'` from `getPanelContent()` (lines 314-315)
- Update `getSecondaryPanelContent()` to always render RecipePanel when secondaryPanel is 'recipe'
- Remove the `compact` prop since RecipePanel is always compact now

---

### 7. Update recipeStore

**File:** `src/stores/recipeStore.ts`

Remove the `buildMode` state since we no longer have build/view/list modes.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/ui/sheet.tsx` | Remove built-in close button |
| `src/components/layout/ActionToolbar.tsx` | Remove Recipe from toolbar actions |
| `src/components/layout/FeaturePanel.tsx` | Simplify for Clean+Recipe only |
| `src/components/panels/CleanPanel.tsx` | Add "Add to Recipe" dropdown + handlers |
| `src/components/panels/RecipePanel.tsx` | Complete rewrite to simplified version |
| `src/stores/previewStore.ts` | Update PanelType |
| `src/stores/recipeStore.ts` | Remove buildMode state |
| `src/App.tsx` | Update panel rendering logic |

---

## Verification

1. **Visual verification:**
   - Open Clean panel → Recipe toggle visible in header
   - Click Recipe toggle → secondary panel slides in from left
   - No overlapping close buttons

2. **Workflow verification:**
   - Select transform in Clean → configure params → "Add to Recipe" dropdown appears
   - "Add to Recipe" → "Create New Recipe..." → dialog appears → creates recipe with step
   - "Add to Recipe" → existing recipe → step added, Recipe panel opens if closed

3. **Export/Import:**
   - Create recipe with steps → Export → JSON downloaded
   - Import JSON → recipe appears in selector → steps load correctly

4. **Apply Recipe:**
   - Select recipe with enabled steps → Apply → transforms execute in sequence

---

## Summary of User Requirements (from Q&A)

1. **Add to Recipe workflow**: Button in Clean panel with dropdown for "New Recipe" or "Add to Existing" (existing only shows when recipes exist)
2. **Recipe panel position**: Always secondary to Clean, never standalone
3. **Steps display**: Simple numbered list, compact
4. **Core use cases**: Both template import AND session capture equally important
5. **Add without apply**: Allow adding transforms to recipe without executing them
