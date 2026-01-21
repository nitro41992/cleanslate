# Plan: Diff View Redesign + E2E Test Fixes

## Overview

The UI redesign broke the Diff feature and many E2E tests. This plan addresses:
1. Creating a dedicated Diff View as a full-page modal (not just a panel)
2. Designing a distinctive, production-grade UI for the comparison view
3. Fixing E2E tests that broke due to the redesign

---

## Part 1: Diff View Redesign

### Problem Analysis

The current Diff implementation has issues:
- `DiffPanel.tsx` is a side panel (400px) that's too cramped for comparison results
- `DiffPage.tsx` exists but is **never imported or used** anywhere
- The diff output shows in the main preview grid, which is confusing
- Users might accidentally try to "persist" a diff result as a table
- No dedicated export functionality for diff results

### Design Concept: "Delta Inspector"

**Aesthetic Direction:** Editorial meets Data Dashboard
- Notion-style dark theme foundation with dramatic color accents
- High-contrast diff status indicators (emerald/rose/amber)
- Split-pane layout: Configuration left, Results right
- Floating summary pills as live indicators
- Smooth staggered row animations

### Implementation Approach

#### 1. New Component: `DiffView.tsx`

A full-screen modal/overlay that opens when user clicks "Diff" button:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ← Back to Tables    DELTA INSPECTOR    [Export CSV ▼]  [Blind Mode]  [×]  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ ┌─────────────────┐  ┌──────────────────────────────────────────────────┐  │
│ │ CONFIGURE       │  │                                                   │  │
│ │                 │  │  ┌─────┬─────┬─────┬─────┐                       │  │
│ │ Table A         │  │  │ +42 │ -18 │ ~73 │ =847│  Summary Pills        │  │
│ │ [patients_v1 ▼] │  │  └─────┴─────┴─────┴─────┘                       │  │
│ │                 │  │                                                   │  │
│ │ Table B         │  │  ┌─────────────────────────────────────────────┐ │  │
│ │ [patients_v2 ▼] │  │  │ STATUS │ ID  │ NAME    │ EMAIL    │ STATUS │ │  │
│ │                 │  │  ├────────┼─────┼─────────┼──────────┼────────┤ │  │
│ │ ─────────────── │  │  │ ADDED  │ 156 │ J.Smith │ j@ex.com │ Active │ │  │
│ │                 │  │  │ ADDED  │ 157 │ M.Jones │ m@ex.com │ Pending│ │  │
│ │ Match Keys      │  │  │ REMOVED│ 023 │ K.Brown │ k@ex.com │ Closed │ │  │
│ │ ☑ patient_id   │  │  │ CHANGED│ 089 │ L.Davis │ NEW_VAL  │ Active │ │  │
│ │ ☐ email        │  │  │        │     │         │ ↑old_val │        │ │  │
│ │ ☐ name         │  │  └─────────────────────────────────────────────┘ │  │
│ │                 │  │                                                   │  │
│ │ [Run Comparison]│  │  Showing 133 differences (10,000 row limit)      │  │
│ └─────────────────┘  └──────────────────────────────────────────────────┘  │
│                                                                              │
│ ⚠ This is a comparison view. Results cannot be saved as a table.           │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 2. Visual Design Specifications

**Color Palette (extends existing CSS variables):**
```css
/* Diff-specific accent colors - more vibrant than current */
--diff-added-bg: hsl(152 60% 12%);      /* Deep emerald background */
--diff-added-text: hsl(152 80% 60%);    /* Bright emerald text */
--diff-added-border: hsl(152 70% 30%);  /* Emerald border */

--diff-removed-bg: hsl(350 60% 14%);    /* Deep rose background */
--diff-removed-text: hsl(350 80% 65%);  /* Bright rose text */
--diff-removed-border: hsl(350 70% 35%);/* Rose border */

--diff-modified-bg: hsl(40 60% 12%);    /* Deep amber background */
--diff-modified-text: hsl(40 90% 60%);  /* Bright amber text */
--diff-modified-border: hsl(40 70% 30%);/* Amber border */
```

**Typography:**
- Headers: System font (inherits from app)
- Status badges: Monospace with tight letter-spacing
- Cell values: Tabular numbers, monospace for "before → after"

**Animations:**
- Results fade-in with stagger (50ms delay per row, max 10 rows)
- Summary pills count up from 0 with easing
- Row hover reveals subtle glow matching status color

#### 3. Key Features

1. **Full-screen overlay** - Not a side panel, uses Dialog/Sheet at full viewport
2. **Split layout** - Config panel (280px fixed) + Results area (flex)
3. **Live summary pills** - Animated counters for added/removed/modified/unchanged
4. **Status column with icons** - Plus, Minus, RefreshCw icons with color
5. **Cell-level highlighting** - Modified cells show "old → new" with strikethrough
6. **Export dropdown** - CSV, JSON, or "Copy to Clipboard"
7. **Blind mode toggle** - Hides status for unbiased review
8. **Non-persistable warning** - Clear indicator this is a view, not a table

#### 4. Files to Create/Modify

**Create:**
- `src/components/diff/DiffView.tsx` - Main full-screen diff component
- `src/components/diff/DiffConfigPanel.tsx` - Left configuration panel
- `src/components/diff/DiffResultsGrid.tsx` - Right results grid with virtualization
- `src/components/diff/DiffSummaryPills.tsx` - Animated summary counters
- `src/components/diff/DiffStatusBadge.tsx` - Status indicator component
- `src/components/diff/DiffExportMenu.tsx` - Export options dropdown
- `src/lib/diff-export.ts` - CSV/JSON export utilities

**Modify:**
- `src/App.tsx` - Add DiffView as full-screen overlay (state-controlled)
- `src/components/layout/ActionToolbar.tsx` - Change Diff button behavior
- `src/stores/previewStore.ts` - Add `isDiffViewOpen` state
- `src/index.css` - Add new diff color variables

**Delete (dead code):**
- `src/features/diff/DiffPage.tsx` - Unused full-page component
- `src/components/panels/DiffPanel.tsx` - Replace with new design

---

## Part 2: E2E Test Fixes

### Test Failure Analysis

The redesign changed from **recipe-based workflow** to **direct-apply transformations**:

**Old workflow (what tests expect):**
```typescript
await laundromat.clickAddTransformation()
await picker.addTransformation('Uppercase', { column: 'name' })
await laundromat.clickRunRecipe()
```

**New workflow (what's implemented):**
```typescript
await picker.addTransformation('Uppercase', { column: 'name' })
// Transformation applies immediately - no "Run Recipe" button
```

### Tests That Need Implementation Updates

Based on the test analysis, these are the critical failing tests:

#### Category 1: Missing Page Object Methods

**File:** `e2e/page-objects/laundromat.page.ts`

Missing methods that tests call:
- `clickAddTransformation()` - No longer exists in new UI
- `clickRunRecipe()` - Recipe system was removed

**Fix approach:** Update `LaundromatPage` to work with new panel-based UI:
```typescript
// New method to open Clean panel and access transformations
async openCleanPanel() {
  await this.page.getByTestId('toolbar-clean').click()
}

// Direct transformation application (replaces clickRunRecipe)
async applyTransformation(name: string, options: { column: string }) {
  // Click transformation tile, select column, transformation applies immediately
}
```

#### Category 2: Route Navigation Tests

Tests navigate to routes that don't exist in single-page app:
- `await page.goto('/diff')` - No route handler
- `await page.goto('/matcher')` - No route handler
- `await page.goto('/scrubber')` - No route handler
- `await page.goto('/combiner')` - No route handler

**Fix approach:** Update tests to use panel-based navigation:
```typescript
// Instead of: await page.goto('/diff')
await page.goto('/')
await page.getByTestId('toolbar-diff').click()
// Then interact with DiffView overlay
```

### Test Files Requiring Updates

| Test File | Issue | Fix Strategy |
|-----------|-------|--------------|
| `feature-coverage.spec.ts` | Route navigation + transformation workflow | Update to panel-based navigation |
| `export.spec.ts` | `clickAddTransformation()` calls | Update page object methods |
| `audit-details.spec.ts` | Transformation workflow | Use direct-apply pattern |
| `e2e-flow.spec.ts` | Full workflow broken | Rewrite for new architecture |

### Page Object Updates Required

**`e2e/page-objects/laundromat.page.ts`:**
```typescript
export class LaundromatPage {
  // Existing methods remain...

  // ADD: Panel navigation
  async openCleanPanel() {
    await this.page.getByTestId('toolbar-clean').click()
  }

  async openDiffView() {
    await this.page.getByTestId('toolbar-diff').click()
    // Wait for DiffView overlay to open
  }

  async openMatchPanel() {
    await this.page.getByTestId('toolbar-match').click()
  }

  async openCombinePanel() {
    await this.page.getByTestId('toolbar-combine').click()
  }

  async openScrubPanel() {
    await this.page.getByTestId('toolbar-scrub').click()
  }

  async closePanel() {
    await this.page.keyboard.press('Escape')
  }
}
```

**`e2e/page-objects/transformation-picker.page.ts`:**
```typescript
export class TransformationPickerPage {
  // UPDATE: Work with CleanPanel transformation tiles
  async addTransformation(name: string, options: { column: string }) {
    // 1. Click transformation tile in CleanPanel
    // 2. Select column from dropdown
    // 3. Transformation applies immediately (no "Run Recipe")
  }
}
```

---

## Implementation Order

### Phase 1: Core Diff View (Priority)
1. Create new diff color CSS variables
2. Create `DiffView.tsx` full-screen component
3. Create `DiffSummaryPills.tsx` with animation
4. Create `DiffResultsGrid.tsx` with virtual scrolling
5. Create `DiffExportMenu.tsx` with CSV/JSON export
6. Integrate into `App.tsx` as overlay
7. Update `ActionToolbar.tsx` to open DiffView

### Phase 2: E2E Test Infrastructure
1. Update `LaundromatPage` page object with panel methods
2. Update `TransformationPickerPage` for direct-apply pattern
3. Create `DiffViewPage` page object for new DiffView

### Phase 3: Test Fixes (Don't modify test logic, update implementation)
1. Update feature-coverage tests to pass with new navigation
2. Update export tests to pass with direct-apply
3. Update audit tests to work with new workflow
4. Verify all FR-B2 diff tests pass with new DiffView

---

## Verification

### Manual Testing
1. Open app, load two CSV files
2. Click "Diff" button in toolbar
3. Verify DiffView opens as full-screen overlay
4. Select tables, key columns, run comparison
5. Verify summary pills animate in
6. Verify results grid shows color-coded rows
7. Test export to CSV
8. Test blind mode toggle
9. Verify "cannot persist" warning is visible
10. Close overlay with X or Escape

### E2E Tests
```bash
npm test -- --grep "FR-B2"      # Diff tests
npm test -- --grep "FR-A3"      # Transformation tests
npm test -- --grep "export"     # Export tests
npm test                        # Full suite
```

---

## Critical Files Summary

### Files to Create
- `src/components/diff/DiffView.tsx`
- `src/components/diff/DiffConfigPanel.tsx`
- `src/components/diff/DiffResultsGrid.tsx`
- `src/components/diff/DiffSummaryPills.tsx`
- `src/components/diff/DiffStatusBadge.tsx`
- `src/components/diff/DiffExportMenu.tsx`
- `src/lib/diff-export.ts`
- `e2e/page-objects/diff-view.page.ts`

### Files to Modify
- `src/App.tsx` - Add DiffView overlay
- `src/components/layout/ActionToolbar.tsx` - Update Diff button
- `src/stores/diffStore.ts` - Add `isViewOpen` state
- `src/index.css` - Add diff color variables
- `e2e/page-objects/laundromat.page.ts` - Add panel methods
- `e2e/page-objects/transformation-picker.page.ts` - Direct-apply pattern

### Files to Delete
- `src/features/diff/DiffPage.tsx` - Dead code
- `src/components/panels/DiffPanel.tsx` - Replaced by DiffView
