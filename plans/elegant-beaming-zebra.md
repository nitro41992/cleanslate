# Icon Modernization Plan

## Overview

Replace cartoony emoji icons with professional Lucide stroke icons throughout CleanSlate Pro. The existing Lucide library is sufficient - no new dependencies needed.

## Current Problems

1. **Main logo**: `Sparkles` icon feels cliché ("AI magic star everywhere")
2. **Transform icons**: Emojis (✂️ 🔄 🔍 📝 💵 📅 🎂 🛡️ 💻) look like phone app icons
3. **Group headers**: Unicode symbols (✦ ⬡ ◫ ▣ ◉ ⌘) inconsistent with stroke icons

## Approach: Lucide-Only (No New Dependencies)

Lucide already has 1600+ icons integrated with shadcn/ui. Replace emoji strings with React components.

---

## Implementation

### 1. Update Type System

**File**: `src/lib/transformations.ts`

Change `icon` property from `string` to `LucideIcon`:

```typescript
import type { LucideIcon } from 'lucide-react'

export interface TransformationDefinition {
  // ...
  icon: LucideIcon  // Was: string
  // ...
}
```

### 2. Replace Transform Icons

**File**: `src/lib/transformations.ts`

| Transform | Current | New Lucide | Import |
|-----------|---------|------------|--------|
| trim | `'✂️'` | `Scissors` | Scissors |
| lowercase | `'a'` | `ArrowDownAZ` | ArrowDownAZ |
| uppercase | `'A'` | `ArrowUpAZ` | ArrowUpAZ |
| title_case | `'🔤'` | `CaseSensitive` | CaseSensitive |
| sentence_case | `'Aa'` | `CaseLower` | CaseLower |
| remove_accents | `'ê'` | `Languages` | Languages |
| remove_non_printable | `'🚫'` | `FileX2` | FileX2 |
| collapse_spaces | `'⎵'` | `Minimize2` | Minimize2 |
| remove_duplicates | `'🔄'` | `ListX` | ListX |
| replace | `'🔍'` | `ArrowLeftRight` | ArrowLeftRight |
| replace_empty | `'🔄'` | `CircleDot` | CircleDot |
| rename_column | `'📝'` | `TextCursorInput` | TextCursorInput |
| cast_type | `'🔢'` | `Braces` | Braces |
| custom_sql | `'💻'` | `Terminal` | Terminal |
| unformat_currency | `'💵'` | `DollarSign` | DollarSign |
| fix_negatives | `'−'` | `Minus` | Minus |
| pad_zeros | `'0'` | `Hash` | Hash |
| standardize_date | `'📅'` | `Calendar` | Calendar |
| calculate_age | `'🎂'` | `CalendarCheck` | CalendarCheck |
| split_column | `'✂️'` | `SplitSquareHorizontal` | SplitSquareHorizontal |
| combine_columns | `'🔗'` | `Combine` | Combine |
| fill_down | `'⬇️'` | `ArrowDownToLine` | ArrowDownToLine |
| privacy_batch | `'🛡️'` | `ShieldCheck` | ShieldCheck |

### 3. Replace Group Icons

**File**: `src/lib/transformations.ts`

| Group | Current | New Lucide |
|-------|---------|------------|
| Text Cleaning | `'✦'` | `Type` |
| Find & Replace | `'⬡'` | `Search` |
| Structure | `'◫'` | `TableProperties` |
| Numeric | `'▣'` | `Calculator` |
| Dates | `'◉'` | `CalendarDays` |
| Privacy | `'🛡️'` | `Shield` |
| Advanced | `'⌘'` | `Terminal` |

### 4. Update Rendering Components

**File**: `src/components/clean/GroupedTransformationPicker.tsx`

Change from:
```tsx
<span className="text-base leading-none">{t.icon}</span>
```
To:
```tsx
<t.icon className="w-4 h-4" />
```

Locations: ~3 places rendering transform icons

---

**File**: `src/components/panels/CleanPanel.tsx`

Change from:
```tsx
<span className="text-lg">{selectedTransform.icon}</span>
```
To:
```tsx
<selectedTransform.icon className="w-5 h-5" />
```

---

**File**: `src/lib/recipe/transform-lookup.ts`

Update `getStepIcon()`:
```typescript
import type { LucideIcon } from 'lucide-react'
import { RefreshCw } from 'lucide-react'

export function getStepIcon(step: RecipeStep): LucideIcon {
  const transform = getTransformDefinition(step)
  return transform?.icon || RefreshCw
}
```

---

**File**: `src/components/recipe/RecipeStepCard.tsx`

Line 138, change from:
```tsx
<span className="text-base">{icon}</span>
```
To:
```tsx
{(() => { const Icon = icon; return <Icon className="w-4 h-4" /> })()}
```

Or refactor to:
```tsx
const StepIcon = icon
// ...
<StepIcon className="w-4 h-4" />
```

### 5. Replace Logo Icon

**File**: `src/components/layout/AppHeader.tsx`

Replace `Sparkles` with `Layers` (represents data layers/tables being cleaned):

```tsx
import { Layers } from 'lucide-react'
// Line 74:
<Layers className="w-4 h-4 text-primary-foreground" />
```

**Alternative options**: `Workflow`, `Database`, `Grid3X3` (user can choose)

### 6. Toolbar Icon Refinement (Optional)

**File**: `src/components/layout/ActionToolbar.tsx`

| Action | Current | Suggested |
|--------|---------|-----------|
| Transform | `Sparkles` | `Wand2` (magic wand, less cliché) |

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | Type change, icon imports, replace all emoji icons |
| `src/lib/recipe/transform-lookup.ts` | `getStepIcon()` return type |
| `src/components/clean/GroupedTransformationPicker.tsx` | Icon rendering (~3 locations) |
| `src/components/panels/CleanPanel.tsx` | Selected transform icon rendering |
| `src/components/recipe/RecipeStepCard.tsx` | Step icon rendering |
| `src/components/layout/AppHeader.tsx` | Logo icon |
| `src/components/layout/ActionToolbar.tsx` | (Optional) Transform toolbar icon |

---

## Backwards Compatibility

**No breaking changes**:
- Recipe exports store `type`, not `icon` - icons are resolved at runtime
- OPFS state stores transform types, not icons
- Existing recipes will automatically get new icons

---

## Verification

1. Run dev server: `npm run dev`
2. Check transform picker - all icons should render as stroke icons
3. Select a transform - icon should appear in CleanPanel header
4. Create/load a recipe - step cards should show icons
5. Verify dark mode contrast
6. Run build: `npm run build` (TypeScript check)
7. Run E2E tests: `npm run test`
