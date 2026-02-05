# Plan: Visually Differentiate Action Toolbar Groups

## Problem

All 6 toolbar buttons (Transform, Smart Replace, Merge, Combine, Diff, Recipes) are rendered as a flat horizontal list with identical styling. This is misleading because:

- **Transform, Smart Replace, Merge, Combine** = data mutation actions (they change your data)
- **Diff** = read-only comparison tool (inspects data, doesn't mutate)
- **Recipes** = workflow management (records/replays transform sequences)

These serve fundamentally different cognitive purposes and should be visually differentiated.

## Approach: Subgroup with Visual Container + Separator

Split the toolbar into two visual groups within the same center toolbar area. The data actions get a subtle background container (pill shape) making them the "primary zone." Diff and Recipes sit outside the container as secondary/auxiliary tools, separated by a vertical divider.

```
                    Center Toolbar
     ┌─────────────────────────────────────┐
     │ Transform  Smart Replace  Merge  Combine │  |  Diff  Recipes
     └─────────────────────────────────────┘
           ↑ bg-muted/30 rounded-lg pill            ↑ separator  ↑ outside pill
```

### Why This Approach

1. **No spatial disruption** - all buttons stay in the center toolbar, no muscle memory relearning
2. **Strong visual hierarchy** - the container creates an immediate "these belong together" signal
3. **Minimal code change** - only `ActionToolbar.tsx` changes, 1 file ~15 lines
4. **Zero test breakage** - `data-testid` attributes remain on same Button elements
5. **Zero keyboard shortcut impact** - `actions` array stays intact, `AppLayout.tsx` unchanged
6. **Professional aesthetic** - subtle container fits regulated-industry users

### Why Not Other Approaches

- **Separator only**: Too subtle in dark mode where borders are already low-contrast
- **Move to right section**: Breaks muscle memory, reduces discoverability (icon-only), spreads logic across 2 components

## Implementation

### Step 1: Use `frontend-design` skill for visual refinement

Invoke the frontend-design skill to design the exact visual treatment, considering:
- Dark mode container contrast (bg-muted/30 vs bg-card background)
- Button hover/active states within the container
- Optional group labels ("Actions" / "Tools") if there's vertical room
- Separator styling between groups
- Whether Diff/Recipes should have subtly different button styling (e.g., `outline` variant instead of `ghost`)

### Step 2: Modify `ActionToolbar.tsx`

**File:** `src/components/layout/ActionToolbar.tsx`

Split the single `.map()` into two groups:

```tsx
const dataActions = actions.filter(a =>
  ['clean', 'standardize', 'match', 'combine'].includes(a.id)
)
const metaActions = actions.filter(a =>
  ['diff', 'recipe'].includes(a.id)
)
```

Render with visual grouping:

```tsx
<div className="flex items-center gap-1" role="toolbar" aria-label="Data operations">
  {/* Data mutation actions - primary group */}
  <div role="group" aria-label="Data transformations"
       className="flex items-center gap-0.5 bg-muted/30 rounded-lg px-1 py-0.5">
    {dataActions.map(action => <ToolbarButton ... />)}
  </div>

  {/* Separator */}
  <Separator orientation="vertical" className="h-5 mx-1" />

  {/* Meta tools - secondary group */}
  <div role="group" aria-label="Workspace tools"
       className="flex items-center gap-0.5">
    {metaActions.map(action => <ToolbarButton ... />)}
  </div>
</div>
```

### Step 3: Verify

1. Visual: Check dark mode contrast, active states, responsive behavior
2. Keyboard: Press T, S, M, C, D, R shortcuts
3. E2E: `npx playwright test "recipe.spec.ts" "feature-coverage.spec.ts" --timeout=90000 --retries=0 --reporter=line`

## Files to Modify

| File | Change |
|------|--------|
| `src/components/layout/ActionToolbar.tsx` | Split rendering into 2 groups, add container + separator |

## Files NOT Modified (verified safe)

| File | Why safe |
|------|----------|
| `src/components/layout/AppLayout.tsx` | Imports `actions` array - unchanged |
| `src/components/layout/AppHeader.tsx` | Renders `<ActionToolbar>` - no change needed |
| `src/components/layout/FeaturePanel.tsx` | Panel logic unchanged |
| `e2e/page-objects/laundromat.page.ts` | Uses `getByTestId('toolbar-*')` - selectors still work |

## Verification

1. `npm run build` - TypeScript check passes
2. Visual inspection in dark mode - container visible, groups distinct
3. Keyboard shortcuts T/S/M/C/D/R all still work
4. `npx playwright test "recipe.spec.ts" "feature-coverage.spec.ts" --timeout=90000 --retries=0 --reporter=line`
