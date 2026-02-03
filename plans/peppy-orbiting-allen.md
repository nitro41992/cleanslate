# Recipe Builder UX Redesign Plan

**Status: COMPLETED**

---

## Problem Summary

The current RecipeStepBuilder implementation has several issues:

1. **Duplicated data**: Hardcoded `TRANSFORM_CATEGORIES` duplicates what exists in `transformations.ts`
2. **Inconsistent UX**: Uses simple sequential dropdowns instead of the polished `GroupedTransformationPicker` with search, keyboard navigation, and grouped display
3. **Missing features**: No live preview, no validation messages, no transform hints/examples
4. **Poor visual design**: Basic inline form vs CleanPanel's professional two-column layout
5. **No component reuse**: Bespoke recreation instead of leveraging existing CleanPanel components

## Solution: Two-Column Recipe Builder

Transform the Recipe panel into a two-column layout when building steps, mirroring CleanPanel's proven design pattern.

### Why This Approach

| Option | Pros | Cons |
|--------|------|------|
| **A: Two-column (CHOSEN)** | Reuses CleanPanel patterns, smooth transitions, maintains 880px width | Requires refactoring RecipePanel |
| B: Panel slides to sidebar | Novel interaction | Complex panel composition, Sheet doesn't support side-by-side |
| C: Modal dialog | Simple isolation | Breaks established panel pattern, jarring experience |

---

## Architecture Overview

### Current State
```
RecipePanel (single column)
├── Recipe list
├── Recipe details
├── RecipeStepBuilder (inline form with dropdowns)
└── Footer actions
```

### Target State
```
RecipePanel (mode-based layout)
├── Mode: 'list' → Recipe list + empty state
├── Mode: 'view' → Split: Recipe list (left) | Recipe details (right)
└── Mode: 'build' → Split: GroupedTransformationPicker (left) | Step config (right)
```

---

## Component Changes

### 1. Delete: `RecipeStepBuilder.tsx`
- Remove the 349-line file with hardcoded categories
- All functionality moves to the refactored RecipePanel

### 2. Refactor: `RecipePanel.tsx`

**New layout structure:**
```tsx
<div className="flex h-full">
  {/* Left Column - Context-aware */}
  <div className="w-[340px] border-r flex flex-col">
    {buildMode === 'build' ? (
      <GroupedTransformationPicker
        selectedTransform={selectedTransform}
        onSelect={handleSelectTransform}
        onNavigateNext={handleNavigateNext}
      />
    ) : (
      <RecipeListSection
        recipes={recipes}
        selectedId={selectedRecipeId}
        onSelect={handleSelectRecipe}
      />
    )}
  </div>

  {/* Right Column - Main content */}
  <div className="flex-1 flex flex-col">
    {buildMode === 'build' ? (
      <StepConfigurationPanel
        transform={selectedTransform}
        tableColumns={tableColumns}
        onAddStep={handleAddStep}
        onCancel={() => setBuildMode('view')}
      />
    ) : selectedRecipe ? (
      <RecipeDetailsPanel
        recipe={selectedRecipe}
        onAddStep={() => setBuildMode('build')}
      />
    ) : (
      <EmptyState onCreateRecipe={handleCreateRecipe} />
    )}
  </div>
</div>
```

### 3. Reused Components (No Changes)

| Component | Location | Purpose in Recipe Builder |
|-----------|----------|---------------------------|
| `GroupedTransformationPicker` | `src/components/clean/` | Transform selection with search |
| `ColumnCombobox` | `src/components/ui/` | Single column selection |
| `MultiColumnCombobox` | `src/components/ui/` | Multi-column for combine_columns |
| `TransformPreview` | `src/components/clean/` | Optional: preview without executing |

### 4. Update: `recipeStore.ts`

Add build mode state:
```typescript
interface RecipeState {
  // ... existing fields
  buildMode: 'list' | 'view' | 'build'

  // Actions
  setBuildMode: (mode: 'list' | 'view' | 'build') => void
}
```

---

## UI/UX Specifications

### Mode: List (No recipe selected)
```
┌─────────────────────────────────────────────────────────────┐
│ Recipe Templates                                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│     ┌─────────────────────────────────────────────────┐    │
│     │  🧙  Build New Recipe                           │    │
│     └─────────────────────────────────────────────────┘    │
│     ┌─────────────────────────────────────────────────┐    │
│     │  📥  Import from File                           │    │
│     └─────────────────────────────────────────────────┘    │
│                                                             │
│     ─────────────────────────────────────────────────      │
│                                                             │
│     MY RECIPES (2)                                         │
│     ┌─────────────────────────────────────────────────┐    │
│     │ Email Cleanup              3 steps         ⋮    │    │
│     │ Date Standardizer          5 steps         ⋮    │    │
│     └─────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Mode: View (Recipe selected)
```
┌─────────────────────────────────────────────────────────────┐
│ Recipe Templates                                            │
├─────────────────────────────────────────────────────────────┤
│ MY RECIPES              │                                   │
│ ┌─────────────────────┐ │  Email Cleanup                    │
│ │ ▸ Email Cleanup  ✓  │ │  Clean and normalize email...    │
│ │   Date Standardizer │ │                                   │
│ └─────────────────────┘ │  Required: email                  │
│                         │                                   │
│ [+ New Recipe]          │  ─────────────────────────────    │
│                         │                                   │
│                         │  STEPS (3 enabled)                │
│                         │  ┌─────────────────────────────┐  │
│                         │  │ ≡ 1. ✂️ Trim → email    ⚡  │  │
│                         │  │ ≡ 2. a  Lowercase → email   │  │
│                         │  │ ≡ 3. 🔄 Replace → email     │  │
│                         │  └─────────────────────────────┘  │
│                         │                                   │
│                         │  [+ Add Step]                     │
├─────────────────────────┴───────────────────────────────────┤
│ [Export]  [Delete]                      [▶ Apply to Table]  │
└─────────────────────────────────────────────────────────────┘
```

### Mode: Build (Adding a step)
```
┌─────────────────────────────────────────────────────────────┐
│ Recipe Templates                              [← Back]      │
├─────────────────────────────────────────────────────────────┤
│ TRANSFORMATIONS         │  CONFIGURE STEP                   │
│ ┌─────────────────────┐ │                                   │
│ │ 🔍 Search...        │ │  ┌─────────────────────────────┐  │
│ └─────────────────────┘ │  │ ✂️ Trim Whitespace          │  │
│                         │  │ Remove leading/trailing...  │  │
│ ✦ Text Cleaning      ▼  │  │                             │  │
│ ┌─────────────────────┐ │  │ Examples:                   │  │
│ │ ✂️ Trim          ✓  │ │  │ "  hello  " → "hello"      │  │
│ │  a  Lowercase       │ │  └─────────────────────────────┘  │
│ │  A  Uppercase       │ │                                   │
│ │ Aa Title Case       │ │  Target Column                    │
│ └─────────────────────┘ │  ┌─────────────────────────────┐  │
│                         │  │ email                    ▼  │  │
│ ⬡ Find & Replace     ▶  │  └─────────────────────────────┘  │
│ ◫ Structure          ▶  │                                   │
│ ▣ Numeric            ▶  │  ┌─────────────────────────────┐  │
│ 📅 Dates             ▶  │  │ ✨ Add to Recipe            │  │
│ 🔒 Security          ▶  │  └─────────────────────────────┘  │
│                         │  [Cancel]                         │
└─────────────────────────┴───────────────────────────────────┘
```

---

## Typography & Visual Design

### Font Hierarchy (Matching App)
- **Headers**: `text-sm font-medium` (MY RECIPES, STEPS)
- **Recipe names**: `text-sm font-medium`
- **Descriptions**: `text-xs text-muted-foreground`
- **Step labels**: `text-sm` with transform icons

### Color Palette (From GroupedTransformationPicker)
| Group | Color | Usage |
|-------|-------|-------|
| Text Cleaning | `emerald-500` | Badges, selection highlight |
| Find & Replace | `blue-500` | Badges, selection highlight |
| Structure | `violet-500` | Badges, selection highlight |
| Numeric | `amber-500` | Badges, selection highlight |
| Security | `rose-500` | Badges, selection highlight |

### Step Status Badges (Existing - Keep)
- **Applied**: `text-emerald-500 border-emerald-500/50` with Check icon
- **Modified**: `text-amber-500 border-amber-500/50` with AlertCircle icon

### Animations
- Mode transitions: `animate-in fade-in slide-in-from-right duration-200`
- Step additions: `animate-in fade-in slide-in-from-top duration-150`

---

## Implementation Phases

### Phase 1: Refactor RecipePanel Layout
**Files:** `src/components/panels/RecipePanel.tsx`, `src/stores/recipeStore.ts`

1. Add `buildMode` state to recipeStore
2. Restructure RecipePanel with conditional two-column layout
3. Extract recipe list into a section component (inline, not separate file)
4. Add "Back" button and mode transitions

### Phase 2: Integrate GroupedTransformationPicker
**Files:** `src/components/panels/RecipePanel.tsx`

1. Import and render `GroupedTransformationPicker` in build mode
2. Handle transform selection and navigation callbacks
3. Map transform selection to step configuration state

### Phase 3: Build Step Configuration Panel
**Files:** `src/components/panels/RecipePanel.tsx`

1. Render transform info card (icon, label, description, examples, hints)
2. Add column selector using `ColumnCombobox`
3. Add dynamic params form (reuse CleanPanel patterns)
4. "Add to Recipe" button that calls `addStep()` without executing

### Phase 4: Polish & Delete Deprecated
**Files:** `src/components/panels/RecipeStepBuilder.tsx` (DELETE)

1. Remove RecipeStepBuilder.tsx entirely
2. Test all flows: create recipe, add steps, apply recipe
3. Verify keyboard navigation works
4. Ensure step status badges still function

---

## Files Modified

| File | Action | Lines Changed |
|------|--------|---------------|
| `src/components/panels/RecipePanel.tsx` | Major refactor | 814 → 1189 |
| `src/components/panels/RecipeStepBuilder.tsx` | **Deleted** | -349 |
| `src/stores/recipeStore.ts` | Add buildMode | +20 |

**Net change:** RecipePanel increased in size but now provides full two-column UX with GroupedTransformationPicker integration. RecipeStepBuilder deleted entirely.

---

## Key Design Decisions

1. **No separate component files** - Keep RecipeList and StepConfig inline in RecipePanel to avoid over-engineering
2. **Direct reuse of GroupedTransformationPicker** - Import directly, don't abstract further
3. **No TransformPreview for recipes** - Recipe steps are "declarations of intent", preview is optional/future enhancement
4. **Keep step-status.ts** - The "Already Applied" detection logic remains valuable

---

## Verification Plan

### Manual Testing
1. Open Recipes panel → See list view with CTAs
2. Select a recipe → See two-column view/details split
3. Click "Add Step" → Transition to build mode with picker
4. Search and select transform → See configuration panel
5. Configure and add step → Step appears in list, return to view mode
6. Verify step status badges still show correctly
7. Apply recipe to table → Confirm execution works

### E2E Tests
- No new test files needed
- Existing recipe tests should continue to pass
- May need to update selectors if test-ids change

---

## Out of Scope (Future Enhancements)

- Drag-and-drop step reordering (consider for future)
- TransformPreview in recipe builder (complex without active table context)
- Scrub command integration in picker (already supported via TRANSFORMATION_GROUPS)
