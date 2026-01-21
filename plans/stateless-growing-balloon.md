# Plan: Remove Recipe System - Direct Apply Transformations

## Summary

Replace the recipe-based transformation system in CleanPanel with a simpler direct-apply model. Users select ONE transformation, configure it, click "Apply" and it executes immediately. No queue management.

## Current Flow (Recipe-based)
1. User opens Clean panel
2. Clicks "Add Transformation" → dialog opens
3. Selects transformation type, configures, adds to queue
4. Repeats to build recipe of multiple steps
5. Clicks "Run Recipe" → executes all in sequence
6. Results appear in preview/audit

## New Flow (Direct-apply)
1. User opens Clean panel
2. Clicks transformation tile (inline grid, no dialog)
3. Configuration form slides in below
4. Clicks "Apply Transformation"
5. Executes immediately → results in preview/audit
6. Form resets, user can add another transformation

---

## Files to Modify

### 1. `src/components/panels/CleanPanel.tsx` - REWRITE
**Current**: Recipe builder with step list, run/clear buttons, TransformationPicker dialog
**New**: 2-column grid of transformation tiles + inline configuration form + Apply button

Changes:
- Remove recipe list UI (ScrollArea with step cards)
- Remove "Run Recipe" and "Clear Recipe" buttons
- Remove TransformationPicker dialog integration
- Add 2-column transformation grid (9 tiles)
- Add inline configuration section (column selector, params)
- Add single "Apply Transformation" button
- Execute transformation directly on apply
- Show success feedback (checkmark, toast)
- Auto-reset form after successful apply

### 2. `src/stores/previewStore.ts` - SIMPLIFY
Remove recipe-related state and actions:
```typescript
// DELETE these:
pendingRecipe: TransformationStep[]
addRecipeStep: (step) => void
removeRecipeStep: (index) => void
clearRecipe: () => void
reorderRecipe: (fromIndex, toIndex) => void
```

Also update `setActiveTable` to remove `pendingRecipe: []` from the reset.

### 3. `src/features/laundromat/components/TransformationPicker.tsx` - DELETE
No longer needed - transformation selection is now inline in CleanPanel.

### 4. `src/features/laundromat/components/RecipePanel.tsx` - DELETE
Duplicate/legacy component from before panel-based redesign.

---

## New CleanPanel Component Design

```
┌─────────────────────────────────────┐
│ CLEAN & TRANSFORM                   │
├─────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐             │
│ │  ✂️     │ │   a     │             │
│ │  Trim   │ │Lowercase│             │
│ └─────────┘ └─────────┘             │
│ ┌─────────┐ ┌─────────┐             │
│ │   A     │ │  🔄     │             │
│ │Uppercase│ │Remove   │             │
│ └─────────┘ │Dupes    │             │
│             └─────────┘             │
│ ... (all 9 transformations)         │
├─────────────────────────────────────┤
│ (When transformation selected:)     │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ ✂️ Trim Whitespace              │ │
│ │ Remove leading/trailing spaces  │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Target Column                       │
│ ┌─────────────────────────────────┐ │
│ │ Select column...            ▾   │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │    ✨ Apply Transformation      │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Component State (local only)
```typescript
const [isApplying, setIsApplying] = useState(false)
const [selectedTransform, setSelectedTransform] = useState<TransformationDefinition | null>(null)
const [selectedColumn, setSelectedColumn] = useState<string>('')
const [params, setParams] = useState<Record<string, string>>({})
const [lastApplied, setLastApplied] = useState<string | null>(null)
```

### Apply Flow
```typescript
const handleApply = async () => {
  // 1. Build TransformationStep
  const step = { id, type, label, column, params }

  // 2. Execute immediately
  const result = await applyTransformation(activeTable.name, step)

  // 3. Log to audit store
  addTransformationEntry({ ... })

  // 4. Track in pending operations
  addPendingOperation({ type: 'transform', label, config: step })

  // 5. Update table metadata
  updateTable(activeTable.id, { rowCount: result.rowCount })

  // 6. Show success, reset form
  toast.success(...)
  setTimeout(() => resetForm(), 1500)
}
```

---

## Implementation Steps

### Step 1: Update previewStore
- Remove `pendingRecipe` from state
- Remove `addRecipeStep`, `removeRecipeStep`, `clearRecipe`, `reorderRecipe` actions
- Update `setActiveTable` to not reference `pendingRecipe`

### Step 2: Rewrite CleanPanel
- Replace entire component with new direct-apply design
- Remove TransformationPicker import
- Add transformation grid with tile buttons
- Add inline configuration form
- Add Apply button with immediate execution
- Add visual feedback (selected state, success checkmark)

### Step 3: Delete unused files
- Delete `src/features/laundromat/components/TransformationPicker.tsx`
- Delete `src/features/laundromat/components/RecipePanel.tsx`

### Step 4: Update tests (if any reference recipe)
- Check E2E tests for recipe-related selectors
- Update to use new direct-apply flow

---

## Visual Design Notes

- **Grid tiles**: 2-column layout, icon + label, hover/selected states
- **Selected tile**: Primary color border + subtle background
- **Success state**: Green checkmark on tile after apply
- **Configuration**: Slides in with `animate-in slide-in-from-top-2`
- **Apply button**: Full width, uses Sparkles icon, prominent
- **Loading**: Spinner on button, disabled state during execution

---

## Verification

1. Start dev server: `npm run dev`
2. Upload a CSV file
3. Open Clean panel (keyboard shortcut `1` or click toolbar)
4. Verify transformation grid displays all 9 transformations
5. Click a transformation → configuration slides in
6. Select column, configure params
7. Click "Apply Transformation"
8. Verify:
   - Loading state shows
   - Transformation executes
   - Success toast appears
   - Audit log shows entry
   - Data preview updates
   - Form resets after 1.5s
9. Apply another transformation
10. Verify audit log shows both entries
11. Run linter: `npm run lint`
