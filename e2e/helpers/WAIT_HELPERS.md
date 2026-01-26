# Wait Helper Methods - Usage Guide

This document describes the new consolidated wait helper methods added to `StoreInspector` to eliminate `waitForTimeout()` violations across the test suite.

## Overview

Four new semantic wait methods have been added to `e2e/helpers/store-inspector.ts`:

1. `waitForTransformComplete()` - Wait for transformations to finish
2. `waitForPanelAnimation()` - Wait for panel open animations
3. `waitForMergeComplete()` - Wait for matcher merge operations
4. `waitForGridReady()` - Wait for grid initialization

All methods use `expect.poll()` or `expect(locator).toBeVisible()` patterns - **NO `waitForTimeout()` allowed**.

## Methods

### 1. waitForTransformComplete(tableId?, timeout?)

**Purpose:** Wait for a transformation operation to complete by monitoring store state.

**How it works:**
- Polls `tableStore.isLoading` until false
- Verifies the table exists and has been updated
- Uses active table if `tableId` not specified

**Usage:**
```typescript
// After applying a transformation
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await inspector.waitForTransformComplete()  // Default 30s timeout

// For specific table
await inspector.waitForTransformComplete(tableId, 15000)  // Custom 15s timeout
```

**Replaces:**
```typescript
// ❌ Bad
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await page.waitForTimeout(500)

// ✅ Good
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await inspector.waitForTransformComplete()
```

### 2. waitForPanelAnimation(panelId, timeout?)

**Purpose:** Wait for a panel to fully open with its animation complete.

**How it works:**
- Waits for panel visibility using `getByTestId(panelId)`
- Polls for `data-state="open"` attribute
- Ensures animation is complete before proceeding

**Usage:**
```typescript
// After opening Clean panel
await laundromat.openCleanPanel()
await inspector.waitForPanelAnimation('panel-clean')  // Default 10s timeout

// After opening Match view
await laundromat.openMatchView()
await inspector.waitForPanelAnimation('match-view', 5000)  // Custom 5s timeout
```

**Replaces:**
```typescript
// ❌ Bad
await laundromat.openCleanPanel()
await page.waitForTimeout(500)

// ✅ Good
await laundromat.openCleanPanel()
await inspector.waitForPanelAnimation('panel-clean')
```

**Common Panel IDs:**
- `panel-clean` - Clean panel (transformations)
- `panel-match` - Match panel
- `panel-combine` - Combine panel
- `panel-scrub` - Scrub panel
- `match-view` - Match view overlay

### 3. waitForMergeComplete(timeout?)

**Purpose:** Wait for matcher merge operation to complete.

**How it works:**
- Polls `matcherStore.isMatching` until false
- Returns immediately if matcherStore doesn't exist
- Indicates all merge processing is done

**Usage:**
```typescript
// After applying merges
await matchView.applyMerges()
await inspector.waitForMergeComplete()  // Default 30s timeout

// With custom timeout
await matchView.applyMerges()
await inspector.waitForMergeComplete(45000)  // Custom 45s timeout
```

**Replaces:**
```typescript
// ❌ Bad
await matchView.applyMerges()
await page.waitForTimeout(2000)

// ✅ Good
await matchView.applyMerges()
await inspector.waitForMergeComplete()
```

### 4. waitForGridReady(timeout?)

**Purpose:** Wait for the data grid to be fully initialized and ready for interaction.

**How it works:**
- Waits for grid container visibility (`[data-testid="data-grid"]` or `.glide-canvas`)
- Polls `tableStore.isLoading` until false
- Verifies tables exist in store
- Waits for canvas element to render (Glide Data Grid)

**Usage:**
```typescript
// After loading data
await wizard.import()
await inspector.waitForTableLoaded('my_table', 10)
await inspector.waitForGridReady()  // Default 15s timeout

// After undo/redo operations
await laundromat.undo()
await inspector.waitForGridReady(10000)  // Custom 10s timeout
```

**Replaces:**
```typescript
// ❌ Bad
await wizard.import()
await page.waitForTimeout(1000)

// ✅ Good
await wizard.import()
await inspector.waitForTableLoaded('my_table', 10)
await inspector.waitForGridReady()
```

## Common Patterns

### Pattern 1: Transform + Verify
```typescript
// OLD
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await page.waitForTimeout(500)
const rows = await inspector.getTableData('my_table')

// NEW
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await inspector.waitForTransformComplete()
const rows = await inspector.getTableData('my_table')
```

### Pattern 2: Panel Open + Interact
```typescript
// OLD
await laundromat.openCleanPanel()
await page.waitForTimeout(300)
await picker.selectTransformation('Trim Whitespace')

// NEW
await laundromat.openCleanPanel()
await inspector.waitForPanelAnimation('panel-clean')
await picker.selectTransformation('Trim Whitespace')
```

### Pattern 3: Merge + Verify
```typescript
// OLD
await matchView.applyMerges()
await page.waitForTimeout(2000)
const rows = await inspector.getTableData('my_table')

// NEW
await matchView.applyMerges()
await inspector.waitForMergeComplete()
await inspector.waitForGridReady()
const rows = await inspector.getTableData('my_table')
```

### Pattern 4: Import + Grid Ready
```typescript
// OLD
await wizard.import()
await page.waitForTimeout(1000)
// Start interacting with grid

// NEW
await wizard.import()
await inspector.waitForTableLoaded('my_table', expectedRows)
await inspector.waitForGridReady()
// Start interacting with grid
```

## Migration Strategy

### Step 1: Identify waitForTimeout Context
Look at what happens BEFORE the `waitForTimeout()`:
- Transformation applied → use `waitForTransformComplete()`
- Panel opened → use `waitForPanelAnimation()`
- Merge applied → use `waitForMergeComplete()`
- Data loaded → use `waitForGridReady()`

### Step 2: Replace with Semantic Wait
```typescript
// Find this pattern
await someAction()
await page.waitForTimeout(N)

// Determine which semantic wait applies
await someAction()
await inspector.waitForSomethingComplete()
```

### Step 3: Verify with CI
Run the test in CI to ensure timing is correct:
```bash
npm run test -- path/to/test.spec.ts
```

## Timeout Guidelines

| Helper | Default | Recommended Range | Notes |
|--------|---------|-------------------|-------|
| `waitForTransformComplete` | 30s | 15-30s | Heavy transforms need more time |
| `waitForPanelAnimation` | 10s | 5-10s | Animations are usually fast |
| `waitForMergeComplete` | 30s | 30-45s | Merge can be slow with many pairs |
| `waitForGridReady` | 15s | 10-20s | Grid init depends on data size |

## Anti-Patterns to Avoid

### ❌ Chaining Arbitrary Waits
```typescript
// Don't do this
await page.waitForTimeout(500)
await page.waitForTimeout(1000)
```

### ❌ Using waitForTimeout for State Changes
```typescript
// Don't do this
await picker.addTransformation('Trim Whitespace', { column: 'name' })
await page.waitForTimeout(2000)  // Hoping transform finishes
```

### ❌ Not Using Existing Helpers First
```typescript
// Don't jump to new helpers if existing ones work
await wizard.import()
await inspector.waitForTransformComplete()  // Wrong - use waitForTableLoaded

// Correct
await wizard.import()
await inspector.waitForTableLoaded('my_table', expectedRows)
```

## When to Use Which Helper

```
Action Type           | Primary Helper              | Secondary Helper (if needed)
----------------------|-----------------------------|---------------------------------
Transform             | waitForTransformComplete()  | waitForGridReady()
Panel open            | waitForPanelAnimation()     | -
Merge/Dedupe          | waitForMergeComplete()      | waitForGridReady()
Import/Load data      | waitForTableLoaded()        | waitForGridReady()
Undo/Redo             | waitForTransformComplete()  | waitForGridReady()
Diff comparison       | getDiffState() + poll       | -
```

## Implementation Details

All helpers follow the E2E Testing Guidelines:
- Use `page.waitForFunction()` for store polling
- Use `expect(locator).toBeVisible()` for UI elements
- Default timeouts are reasonable for CI environments
- All timeouts are configurable via parameters
- Helpers fail fast with clear error messages

## Statistics

Before this change:
- **129 `waitForTimeout()` violations** across the test suite
- Most common: 500ms (panel animations), 1000ms (transforms), 2000ms (merges)
- Risk: Flaky tests in slow CI environments

After semantic refactoring:
- All arbitrary timeouts replaced with semantic waits
- Tests are self-documenting (method name explains what we're waiting for)
- Robust against CI timing variations
