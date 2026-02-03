# Recipe Management Redesign Plan

## Overview

Transform Recipe from a secondary-only panel into an **independent, primary-class feature** while maintaining integration with the Clean & Transform views for adding steps. The redesign addresses visual overflow issues and ensures all transform parameters are properly captured and displayed.

---

## Problems to Solve

1. **Cards overflow behind Clean panel** - The dual-panel layout (1220px) doesn't properly contain recipe step cards
2. **Missing transform parameters** - "Find & Replace" and other transforms don't show all key fields (e.g., the "replace" value)
3. **Recipe is tied to Clean** - Users want Recipe as its own independent functionality

---

## Design Direction: Industrial-Utilitarian Precision

Recipe management for a regulated data operations suite should feel like **laboratory instrumentation** - precise, functional, and confidence-inspiring. The key visual element: a **vertical pipeline** showing data flowing through transformation steps.

---

## Implementation Plan

### Phase 1: Fix Parameter Storage Bug

**File:** `src/components/panels/CleanPanel.tsx`

**Problem:** Line 362 filters out falsy values including empty strings:
```typescript
if (params[param.name]) {  // Empty strings are falsy!
```

**Fix:** Store all explicitly set parameters:
```typescript
if (params[param.name] !== undefined) {
  // For empty strings, explicitly store them
  if (params[param.name] === '' && param.required !== false) {
    continue // Skip truly optional empty values
  }
  stepParams[param.name] = ...
}
```

Also need to include default values from transform definitions when building steps.

---

### Phase 2: Promote Recipe to Primary Panel

**Files to modify:**
- `src/stores/previewStore.ts` - Add Recipe as primary panel option
- `src/components/layout/FeaturePanel.tsx` - Handle Recipe as primary panel
- `src/components/layout/ActionToolbar.tsx` - Add Recipe button to toolbar

**Changes:**
1. Add Recipe button to the main toolbar (BookOpen icon)
2. Allow Recipe to open as a full 880px primary panel for viewing/managing recipes
3. When adding steps from Recipe panel, switch to Clean as primary with Recipe as secondary (preserves familiar Clean UX)

---

### Phase 3: Create New RecipePanel Design

**New component:** `src/components/panels/RecipePanelPrimary.tsx`

**Layout (880px width):**
```
┌────────────────────────────────────────────────────────┐
│  HEADER: Recipe name + actions (export, delete, etc)   │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────────────────────┐  ┌────────────────────────┐  │
│  │                      │  │                        │  │
│  │   RECIPE LIST        │  │   RECIPE DETAIL        │  │
│  │   (Sidebar 280px)    │  │   (Main area)          │  │
│  │                      │  │                        │  │
│  │   • Recipe 1 ✓       │  │   Pipeline View:       │  │
│  │   • Recipe 2         │  │   ──────────────────   │  │
│  │   • Recipe 3         │  │   │ Step 1: Trim     │  │
│  │                      │  │   │   → email        │  │
│  │   [+ New Recipe]     │  │   ├──────────────────│  │
│  │                      │  │   │ Step 2: Replace  │  │
│  │                      │  │   │   → name         │  │
│  │                      │  │   │   Find: "nan"    │  │
│  │                      │  │   │   Replace: ""    │  │
│  │                      │  │   └──────────────────│  │
│  │                      │  │                        │  │
│  │                      │  │   [+ Add Step]         │  │
│  └──────────────────────┘  └────────────────────────┘  │
│                                                        │
├────────────────────────────────────────────────────────┤
│  FOOTER: Apply to Table dropdown + Apply button        │
└────────────────────────────────────────────────────────┘
```

**Key design elements:**

1. **Two-column layout** - Recipe list on left, detail view on right
2. **Pipeline visualization** - Steps connected by a vertical line with flow indicators
3. **Rich step cards** - Show ALL parameters in a structured format
4. **"Add Step" button** - Opens Clean panel as secondary to configure a new step

---

### Phase 4: Redesign Step Cards

**New component:** `src/components/recipe/RecipeStepCard.tsx`

Each step card displays:
```
┌─────────────────────────────────────────┐
│  ●  1. Find & Replace → Email           │
│     ─────────────────────────────────   │
│     Find:           "nan"               │
│     Replace:        (empty)             │  ← Show empty explicitly
│     Case Sensitive: No                  │
│     Match Type:     Contains            │
│                                         │
│     [↑] [↓] [Toggle] [Delete]          │
└─────────────────────────────────────────┘
       │
       ▼ (connector to next step)
```

**Parameter display rules:**
1. Show ALL parameters from transform definition, not just stored values
2. Mark empty values with "(empty)" in muted italic text
3. Show boolean values as "Yes"/"No"
4. Show arrays as comma-separated lists
5. Group related parameters visually

---

### Phase 5: "Add Step" Flow

When user clicks "+ Add Step" in the independent Recipe panel:

1. Switch Clean to primary panel (full 880px width - familiar UX)
2. Recipe stays open as secondary panel (340px on left)
3. Clean panel shows transform picker with the existing "Add to Recipe" button
4. After configuring transform and clicking "Add to Recipe", step is added
5. User can continue adding more steps or close Clean to return to Recipe-only view

This keeps the Clean & Transform UI unchanged and familiar, while Recipe acts as a companion that receives the new steps.

---

### Phase 6: Fix Overflow Issues

**File:** `src/components/layout/FeaturePanel.tsx`

**Root cause:** The 340px secondary panel can overflow when content exceeds available height.

**Fixes:**
1. Add `overflow-y-auto` to the secondary panel content area
2. Ensure step cards use `shrink-0` to prevent flex compression
3. Add `max-h-full` constraints to ScrollArea components
4. Set proper `z-index` hierarchy: primary panel > secondary panel > overlay

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/panels/CleanPanel.tsx` | Fix parameter storage (line 362) |
| `src/components/panels/RecipePanel.tsx` | Keep for secondary-mode display (simplified) |
| `src/components/panels/RecipePanelPrimary.tsx` | **NEW** - Primary recipe management UI |
| `src/components/recipe/RecipeStepCard.tsx` | **NEW** - Rich step card component |
| `src/components/recipe/RecipePipeline.tsx` | **NEW** - Pipeline visualization |
| `src/components/layout/FeaturePanel.tsx` | Handle Recipe as primary, fix overflow |
| `src/components/layout/ActionToolbar.tsx` | Add Recipe button to toolbar |
| `src/stores/previewStore.ts` | Support Recipe as primary panel |
| `src/App.tsx` | Route Recipe panel in getPanelContent() |
| `src/lib/transformations.ts` | Ensure all params have explicit defaults |

---

## Parameter Preservation Fix

**In `buildStepFromCurrentForm()` (CleanPanel.tsx:355-387):**

```typescript
const buildStepFromCurrentForm = (): Omit<RecipeStep, 'id'> | null => {
  if (!selectedTransform) return null

  const stepParams: Record<string, unknown> = {}
  if (selectedTransform.params) {
    for (const param of selectedTransform.params) {
      const value = params[param.name]

      // Include the parameter if:
      // 1. It has a non-empty value, OR
      // 2. It has an explicit empty string (user cleared it), OR
      // 3. It differs from the default
      const hasValue = value !== undefined && value !== ''
      const hasExplicitEmpty = value === '' && param.required === false
      const differsFromDefault = value !== param.default

      if (hasValue || hasExplicitEmpty || differsFromDefault) {
        if (param.type === 'number') {
          stepParams[param.name] = parseInt(value, 10)
        } else if (param.name === 'columns') {
          stepParams[param.name] = value.split(',').map((c: string) => c.trim())
        } else {
          stepParams[param.name] = value
        }
      }
    }
  }
  // ... rest of function
}
```

**In `formatStepParams()` (RecipePanel.tsx:169-203):**

Enhance to show all parameters from the transform definition, not just stored values:

```typescript
const formatStepParams = (step: RecipeStep): React.ReactNode => {
  const transformId = step.type.replace(/^(transform|scrub|standardize):/, '')
  const transform = TRANSFORMATIONS.find((t) => t.id === transformId)

  if (!transform?.params) return null

  // Show ALL defined params, using stored value or default
  return (
    <div className="space-y-1.5">
      {transform.params.map((paramDef) => {
        const value = step.params?.[paramDef.name] ?? paramDef.default ?? ''
        const isEmpty = value === '' || value === null || value === undefined

        return (
          <div key={paramDef.name} className="flex items-start gap-2 text-xs">
            <span className="text-muted-foreground min-w-[100px]">
              {paramDef.label}:
            </span>
            {isEmpty ? (
              <span className="text-muted-foreground/60 italic">(empty)</span>
            ) : (
              <span className="text-foreground font-medium">{formatValue(value)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

---

## Verification

1. **Parameter preservation:**
   - Create a Find & Replace step with empty "Replace with" field
   - Verify the step card shows "Replace: (empty)"
   - Export recipe to JSON, verify "replace": "" is included
   - Re-import and verify step still shows the parameter

2. **Independent Recipe view:**
   - Click Recipe in toolbar, verify it opens as primary (880px)
   - Create new recipe, add steps via Clean panel
   - Verify Clean opens as secondary (340px) when adding steps
   - Verify recipe list and detail view work correctly

3. **Overflow fix:**
   - Add 10+ steps to a recipe
   - Verify scrolling works correctly
   - Verify no content clips behind other panels

---

## Summary

This plan transforms Recipe from a secondary-only panel into a first-class feature with its own independent view. The key changes:

1. **Fix the parameter bug** - Store and display ALL parameters, including empty strings
2. **Promote Recipe to primary** - Add toolbar button, support 880px primary panel for recipe management
3. **Preserve familiar Clean UX** - When adding steps, Clean stays primary with Recipe as secondary
4. **Redesign step cards** - Show complete parameter information in a structured format
5. **Fix overflow** - Proper scroll containment in dual-panel mode

**User flow:**
- Click Recipe in toolbar → Opens Recipe as primary (880px) for viewing/managing recipes
- Click "+ Add Step" in Recipe → Switches to Clean as primary, Recipe as secondary
- Configure transform in Clean → Add to Recipe → Step appears in Recipe panel
- Close Clean → Return to Recipe-only view
