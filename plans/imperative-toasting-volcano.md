# Plan: Tab-Based Clean Panel with Formula Builder Promotion

## Goal
Restructure the Clean Panel so users choose between **Quick Transforms** (grouped picker) and **Formula Builder** (promoted to first-class tab). Feature-flag off niche transforms and Custom SQL. Add LPAD + REGEXREPLACE to formula builder for parity.

---

## Changes

### 1. Create Feature Flags Config
**New file:** `src/lib/feature-flags.ts`

```ts
export const ENABLE_CUSTOM_SQL = false

export const HIDDEN_TRANSFORMS = new Set([
  'custom_sql',
  'remove_accents',
  'remove_non_printable',
  'fill_down',
])
```

### 2. Filter Transforms from Picker
**File:** `src/lib/transformations.ts`

- Import `HIDDEN_TRANSFORMS` from feature-flags
- Export a filtered `VISIBLE_TRANSFORMATIONS` (excludes hidden + `excel_formula` since it's now a tab)
- Export a filtered `VISIBLE_TRANSFORMATION_GROUPS` that:
  - Removes hidden transform IDs from each group's `transforms` array
  - Removes `excel_formula` from the Advanced group
  - Drops groups that become empty after filtering (Advanced group will be empty)
- Keep original `TRANSFORMATIONS` and `TRANSFORMATION_GROUPS` untouched for backwards compatibility (recipe replay, command system, etc.)

### 3. Update GroupedTransformationPicker
**File:** `src/components/clean/GroupedTransformationPicker.tsx`

- Import `VISIBLE_TRANSFORMATIONS` and `VISIBLE_TRANSFORMATION_GROUPS` instead of originals
- Use filtered lists for rendering and search
- No structural changes to the component itself

### 4. Add Tab UI to CleanPanel
**File:** `src/components/panels/CleanPanel.tsx`

- Import `Tabs, TabsList, TabsTrigger, TabsContent` from `@/components/ui/tabs`
- Add tab state (default: "transforms")
- Restructure layout:

```
┌─────────────────────────────────────────────┐
│  [Quick Transforms]  |  [Formula Builder]    │  ← Tabs bar (full width)
├─────────────────────────────────────────────┤
│                                               │
│  "transforms" tab:                            │
│    Left (340px): GroupedTransformationPicker   │
│    Right (flex): Config/Preview/Apply          │
│                                               │
│  "formula" tab:                               │
│    Full-width FormulaEditor + Apply/Cancel     │
│                                               │
└─────────────────────────────────────────────┘
```

- When "formula" tab is active, render FormulaEditor in full-width layout with action buttons (Apply Formula, Add to Recipe, Cancel)
- Remove the `excel_formula` branch from the right-column conditional rendering (it's now handled by the tab)
- Remove the Custom SQL context helper rendering (feature-flagged off)
- Keep `selectedTransform` state but reset it when switching tabs

### 5. Add LPAD and REGEXREPLACE to Formula Builder
**File:** `src/lib/formula/ast.ts`
- Add `'LPAD'` and `'REGEXREPLACE'` to `FunctionName` union type

**File:** `src/lib/formula/functions.ts`
- Add LPAD spec:
  - `LPAD(text, length, pad_char)` → `LPAD(CAST(text AS VARCHAR), length, pad_char)`
  - Category: `text`, returnsString: true
  - 3 args (text, target_length, pad_string)
- Add REGEXREPLACE spec:
  - `REGEXREPLACE(text, pattern, replacement)` → `REGEXP_REPLACE(CAST(text AS VARCHAR), pattern, replacement, 'g')`
  - Category: `text`, returnsString: true
  - 3 args

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/feature-flags.ts` | **NEW** - Feature flag constants |
| `src/lib/transformations.ts` | Add filtered exports (`VISIBLE_TRANSFORMATIONS`, `VISIBLE_TRANSFORMATION_GROUPS`) |
| `src/components/clean/GroupedTransformationPicker.tsx` | Use filtered transform lists |
| `src/components/panels/CleanPanel.tsx` | Add tab-based layout, move FormulaEditor to its own tab |
| `src/lib/formula/ast.ts` | Add LPAD, REGEXREPLACE to FunctionName |
| `src/lib/formula/functions.ts` | Add LPAD, REGEXREPLACE specs |

## Files NOT Modified (important)
- Command system (`src/lib/commands/`) - untouched, all commands still exist
- Recipe system - untouched, recipes can still reference all transforms including hidden ones
- Timeline/undo system - untouched
- FormulaEditor sub-components - no changes needed (already self-contained)

---

## Verification

1. **Dev server:** `npm run dev` - verify Clean Panel renders with tabs
2. **Quick Transforms tab:** Verify hidden transforms (Remove Accents, Fill Down, Remove Non-Printable, Custom SQL, Formula Builder) don't appear in picker
3. **Formula Builder tab:** Verify FormulaEditor renders correctly, can write formulas, apply, and cancel
4. **LPAD function:** In formula builder, type `LPAD(@column, 9, "0")` and verify autocomplete + apply works
5. **REGEXREPLACE function:** Type `REGEXREPLACE(@column, "\\s+", " ")` and verify it works
6. **Build check:** `npm run build` - verify no TypeScript errors
7. **Existing tests:** `npm run test` - verify no regressions (transforms still work via command system)
