# Plan: Privacy Transforms UI Improvements

## Issues to Address

### Issue 1: Add Column Placement & Helper Text
**Current:** "Add Column" dropdown is at the top, above the columns list
**Desired:** "Add Column" should be below the columns list (above "Generate Key Map Table")
**Also:** Placeholder text should change from "Select column to add..." to "Add more columns..." after the first column is added

### Issue 2: Recipe Integration & Panel Layout
**Current:** PrivacySubPanel takes over the entire panel (lines 593-601 in CleanPanel.tsx), hiding the transform picker
**Desired:**
- Middle section should remain visible showing the transform picker (other transforms accessible)
- Privacy configuration should be in the rightmost section only
- "Add to Recipe" button should be available like other transforms

---

## Implementation Plan

### Part 1: Add Column Placement (Quick Fix)
**File:** `src/components/clean/PrivacySubPanel.tsx`

1. Move the "Add Column" section (lines 283-293) to AFTER the "Columns" list (after line 336)
2. Update the placeholder text to be dynamic:
   - When `rules.length === 0`: "Select column to add..."
   - When `rules.length > 0`: "Add more columns..."

### Part 2: Recipe Integration & Panel Layout (Structural Change)

**Approach:** Instead of PrivacySubPanel taking over the entire panel, render it only in the right column while keeping the transform picker visible in the left column.

**Files to modify:**
1. `src/components/panels/CleanPanel.tsx` - Change conditional rendering
2. `src/components/clean/PrivacySubPanel.tsx` - Restructure layout and add recipe functionality

**Changes:**

#### A. CleanPanel.tsx
- Remove the conditional that replaces the entire panel with PrivacySubPanel (lines 593-602)
- Instead, render PrivacySubPanel inside the right column when `selectedTransform?.id === 'privacy_batch'`
- Keep the GroupedTransformationPicker always visible in the left column

#### B. PrivacySubPanel.tsx - Layout Restructure
- Remove the outer two-column flex layout since it will now fit in a single column (right section only)
- Reorganize the UI to be a single vertical column layout:
  - Columns list (with remove buttons)
  - Add Column dropdown (with dynamic placeholder)
  - Hash Secret section (when applicable)
  - Generate Key Map checkbox
  - Preview section for selected column
  - Method selector
  - Action buttons: [Apply All] [Add to Recipe ▼]
  - Cancel button

#### C. PrivacySubPanel.tsx - Add Recipe Integration
- Import recipe store hooks: `useRecipeStore`
- Import UI components: `DropdownMenu`, `BookOpen`, `ChevronDown`, `Plus`
- Add state for recipe dialog: `showNewRecipeDialog`, `newRecipeName`, `pendingStep`
- Add functions:
  - `buildStepFromCurrentForm()` - builds `RecipeStep` for privacy batch operation
  - `canAddToRecipe()` - validates form state
  - `handleAddToNewRecipe()` - opens new recipe dialog
  - `handleCreateRecipeWithStep()` - creates recipe and adds step
  - `handleAddToExistingRecipe(recipeId)` - adds step to existing recipe
- Add "Add to Recipe" dropdown button next to "Apply All"
- Add Dialog for creating new recipe (same pattern as CleanPanel)

---

## Critical Files

| File | Changes |
|------|---------|
| `src/components/clean/PrivacySubPanel.tsx` | Restructure layout, move Add Column, add recipe integration |
| `src/components/panels/CleanPanel.tsx` | Render PrivacySubPanel in right column, keep picker visible |

---

## Verification

1. **Add Column placement**:
   - Add a column, verify "Add Column" dropdown appears BELOW the columns list
   - Verify placeholder changes to "Add more columns..." after first column added

2. **Transform picker visibility**:
   - Select "Privacy Transforms", verify other transform groups still visible in left column
   - User can switch to a different transform without losing Privacy panel state

3. **Recipe integration**:
   - Configure privacy rules (multiple columns with different methods)
   - Click "Add to Recipe" dropdown
   - Verify can create new recipe with privacy step
   - Verify can add to existing recipe
   - Check Recipe panel shows the privacy step correctly

4. **Apply functionality**:
   - Verify "Apply All" still works correctly
   - Verify hash secret validation still works
   - Verify key map generation option works
