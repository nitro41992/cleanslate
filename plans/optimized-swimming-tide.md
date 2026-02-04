# Recipe Card Redesign Plan

## Goal
Redesign the recipe step cards to be visually cohesive with the Transform picker cards, using shadcn components and maintaining a consistent design language. Cards remain always expanded (no collapse toggle).

## Current State Analysis

### Transform Picker Cards (reference design)
- **Icon container**: `w-8 h-8 rounded-lg` with category-colored background (`bg-emerald-500/10`, etc.)
- **Color system**: 7 categories (emerald, blue, violet, amber, rose, teal, slate)
- **Layout**: Icon + Label (text-sm font-medium) + Description (text-xs text-muted-foreground)
- **Selection state**: Left border + tinted background (`border-l-2 border-emerald-500 bg-emerald-500/5`)
- **Hover**: `hover:bg-muted/40`
- **Category badges**: `text-[10px] px-1.5 py-0.5 rounded-full border`

### Current Recipe Cards (issues)
- No color-coded icon backgrounds (transform icons displayed raw)
- Step indicator dots (2px circles) feel disconnected from transform aesthetic
- Parameters section uses plain text, not styled like transform descriptions
- Visual weight doesn't match transform cards
- Action buttons have inconsistent sizing

## Design Decisions

### 1. Unified Color System
Extract color classes to a shared utility and map recipe step types to their transform category colors.

### 2. Always Expanded Card Layout

```
Pipeline Connector (thin vertical line, 8px)
┌─────────────────────────────────────────────────────────────┐
│ [●] [Icon]  Label                          [↑][↓][⏻][🗑]   │
│     bg      └─ column_name                                  │
├─────────────────────────────────────────────────────────────┤
│ Target format:     YYYY-MM-DD                               │
│ Case sensitive:    true                                     │
└─────────────────────────────────────────────────────────────┘
Pipeline Connector (thin vertical line, 8px)
```

**Header row:**
- Step indicator dot (colored by category, replaces generic primary dot)
- Icon in 8x8 container with category background color
- Step number + Label
- Column name below label with ↳ indicator
- Action buttons: move up, move down, toggle enable, delete

**Parameters section:**
- Border-top separator
- Key-value pairs in compact rows
- Styled consistently with transform card descriptions

### 3. Visual Styling
- **Enabled**: Left border with category color + subtle tinted background (matching transform picker selected state)
- **Disabled**: Muted appearance, no color accent, reduced opacity
- **Pipeline connectors**: Thin colored vertical lines between cards (matches step dot color)
- **Highlighted (newly added)**: Ring animation with category color

### 4. Privacy/Scrub Step Cards
Privacy steps have multiple columns with different scrub methods. Instead of the current bullet list format:
```
• Name → hash
• Phone Number → redact
```

Use the same `↳` column indicator pattern as other cards:
```
↳ Name → hash
↳ Phone Number → redact
↳ Position → mask
```

This keeps visual consistency across all card types while still showing the scrub method for each column.

## Implementation Plan

### Step 1: Create Shared Color Utilities
**File:** `src/lib/ui/transform-colors.ts` (new file)

```typescript
import { TRANSFORMATION_GROUPS } from '@/lib/transformations'

export type TransformCategoryColor = 'emerald' | 'blue' | 'violet' | 'amber' | 'rose' | 'teal' | 'slate'

export const categoryColorClasses: Record<TransformCategoryColor, {
  iconBg: string
  border: string
  selectedBg: string
  badge: string
  dot: string
  connector: string
}> = {
  emerald: {
    iconBg: 'bg-emerald-500/10',
    border: 'border-l-2 border-emerald-500',
    selectedBg: 'bg-emerald-500/5',
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    dot: 'bg-emerald-500',
    connector: 'bg-emerald-500/30',
  },
  blue: {
    iconBg: 'bg-blue-500/10',
    border: 'border-l-2 border-blue-500',
    selectedBg: 'bg-blue-500/5',
    badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    dot: 'bg-blue-500',
    connector: 'bg-blue-500/30',
  },
  violet: {
    iconBg: 'bg-violet-500/10',
    border: 'border-l-2 border-violet-500',
    selectedBg: 'bg-violet-500/5',
    badge: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    dot: 'bg-violet-500',
    connector: 'bg-violet-500/30',
  },
  amber: {
    iconBg: 'bg-amber-500/10',
    border: 'border-l-2 border-amber-500',
    selectedBg: 'bg-amber-500/5',
    badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    dot: 'bg-amber-500',
    connector: 'bg-amber-500/30',
  },
  rose: {
    iconBg: 'bg-rose-500/10',
    border: 'border-l-2 border-rose-500',
    selectedBg: 'bg-rose-500/5',
    badge: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    dot: 'bg-rose-500',
    connector: 'bg-rose-500/30',
  },
  teal: {
    iconBg: 'bg-teal-500/10',
    border: 'border-l-2 border-teal-500',
    selectedBg: 'bg-teal-500/5',
    badge: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    dot: 'bg-teal-500',
    connector: 'bg-teal-500/30',
  },
  slate: {
    iconBg: 'bg-slate-500/10',
    border: 'border-l-2 border-slate-500',
    selectedBg: 'bg-slate-500/5',
    badge: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    dot: 'bg-slate-500',
    connector: 'bg-slate-500/30',
  },
}

// Map transform ID to category color
const transformToColor = new Map<string, TransformCategoryColor>()
TRANSFORMATION_GROUPS.forEach(group => {
  group.transforms.forEach(id => {
    transformToColor.set(id, group.color)
  })
})

export function getTransformColor(transformId: string): TransformCategoryColor {
  return transformToColor.get(transformId) || 'slate'
}
```

### Step 2: Enhance transform-lookup.ts
**File:** `src/lib/recipe/transform-lookup.ts`

Add function to get category color for a recipe step:
```typescript
import { getTransformColor, categoryColorClasses, type TransformCategoryColor } from '@/lib/ui/transform-colors'

export function getStepColorClasses(step: RecipeStep) {
  const transformId = getTransformId(step.type)
  const color = getTransformColor(transformId)
  return categoryColorClasses[color]
}

export function getStepColor(step: RecipeStep): TransformCategoryColor {
  const transformId = getTransformId(step.type)
  return getTransformColor(transformId)
}
```

### Step 3: Redesign RecipeStepCard Component
**File:** `src/components/recipe/RecipeStepCard.tsx`

Key changes:
1. Use color-coded icon container (8x8 rounded-lg with category background)
2. Apply left border + background tint for enabled state
3. Color-code the step indicator dot and pipeline connectors
4. Consistent action button sizing and spacing
5. Parameters section with cleaner styling

**New structure:**
```tsx
<div className="relative">
  {/* Top connector */}
  {!isFirst && <div className={cn('absolute left-4 -top-2 w-0.5 h-2', colors.connector)} />}

  {/* Card */}
  <div className={cn(
    'relative rounded-lg border transition-all duration-200',
    step.enabled && colors.border,
    step.enabled ? cn('bg-card', colors.selectedBg) : 'bg-muted/30 opacity-60',
    isHighlighted && 'ring-2 ring-primary/60'
  )}>
    {/* Step dot */}
    <div className={cn('absolute left-4 top-4 w-2 h-2 rounded-full', step.enabled ? colors.dot : 'bg-muted-foreground/40')} />

    {/* Header */}
    <div className="flex items-start gap-2 pl-8 pr-2 pt-3 pb-2">
      {/* Icon container - matches transform picker */}
      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', colors.iconBg)}>
        <span className="text-base">{icon}</span>
      </div>

      {/* Label + column */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{index + 1}.</span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        {step.column && (
          <div className="text-xs text-muted-foreground pl-4 flex items-center gap-1">
            <span className="text-muted-foreground/60">↳</span>
            <span className="truncate">{step.column}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5">
        {/* Move up/down, toggle, delete buttons */}
      </div>
    </div>

    {/* Parameters */}
    {params.length > 0 && (
      <div className="pl-8 pr-3 pb-3 pt-2 border-t border-border/30">
        <div className="space-y-1.5">
          {params.map(({ name, label, value }) => (
            <div key={name} className="flex items-start gap-3 text-xs">
              <span className="text-muted-foreground min-w-[100px]">{label}:</span>
              <span className="text-foreground/80">{formatRecipeValue(value)}</span>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>

  {/* Bottom connector */}
  {!isLast && <div className={cn('absolute left-4 -bottom-2 w-0.5 h-2', colors.connector)} />}
</div>
```

### Step 4: Update Scrub Rules Formatting
**File:** `src/lib/recipe/format-helpers.tsx`

Change the scrub rules display from bullet points to ↳ indicators:
```tsx
// Before (current):
<span className="text-muted-foreground/50">•</span>
<span className="font-medium">{rule.column}</span>
<span className="text-muted-foreground">→</span>
<span>{rule.method}</span>

// After (new):
<span className="text-muted-foreground/60">↳</span>
<span className="font-medium">{rule.column}</span>
<span className="text-muted-foreground mx-1">→</span>
<span className="text-foreground/80">{rule.method}</span>
```

This makes privacy/scrub cards visually consistent with other cards that show columns with the ↳ indicator.

### Step 5: Update RecipePanel Inline Cards
**File:** `src/components/panels/RecipePanel.tsx`

Currently renders inline step cards with custom markup. Update to:
1. Use the shared color system
2. Match icon container styling (8x8 with color bg)
3. Apply left border styling for enabled state
4. Keep compact layout but with visual alignment to transform cards

**Key changes to inline cards:**
- Add color-coded icon container instead of raw emoji
- Apply `colors.border` and `colors.selectedBg` for enabled state
- Use consistent typography (text-sm font-medium for labels)

## Files to Modify

| File | Action | Changes |
|------|--------|---------|
| `src/lib/ui/transform-colors.ts` | CREATE | Shared color utilities with category mappings |
| `src/lib/recipe/transform-lookup.ts` | MODIFY | Add `getStepColorClasses()` and `getStepColor()` |
| `src/lib/recipe/format-helpers.tsx` | MODIFY | Update scrub rules to use ↳ indicator instead of bullets |
| `src/components/recipe/RecipeStepCard.tsx` | MODIFY | Full visual redesign with color system |
| `src/components/panels/RecipePanel.tsx` | MODIFY | Update inline step cards to use color system |

## Existing Utilities to Reuse

- `getStepIcon(step)` - from transform-lookup.ts
- `getStepLabel(step)` - from transform-lookup.ts
- `formatRecipeValue(value)` - from format-helpers.tsx
- `getTransformDefinition(step)` - from transform-lookup.ts
- `cn()` utility for conditional classes
- `Tooltip`, `TooltipTrigger`, `TooltipContent` - shadcn
- `Button` with ghost variant - shadcn
- `Switch` component - shadcn

## Visual Reference

The transform picker card pattern to match:
```tsx
<button className={cn(
  'w-full flex items-center gap-3 px-3 py-2 rounded-lg',
  'transition-colors duration-150',
  'hover:bg-muted/40',
  selectedTransform?.id === t.id && colors.selected  // left border + bg tint
)}>
  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', colors.iconBg)}>
    <span className="text-base">{icon}</span>
  </div>
  <div className="flex-1 min-w-0 text-left">
    <span className="text-sm font-medium text-foreground block truncate">{label}</span>
    <span className="text-xs text-muted-foreground block truncate">{description}</span>
  </div>
</button>
```

## Verification Plan

1. Visual comparison with transform picker cards for consistency
2. Test all 7 color categories (text, replace, structure, numeric, dates, privacy, advanced)
3. Verify enabled/disabled states display correctly
4. Test reorder buttons functionality
5. Verify highlight animation for newly added steps
6. Check RecipePanel (secondary) and RecipePanelPrimary (full view)
7. Test with scrub and standardize step types (non-transform prefixes)
