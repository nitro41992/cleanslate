# Fix: Edit indicator stays orange after scroll (doesn't turn green)

## Problem Summary

When the user edits a cell after scrolling down (e.g., row 315), the orange "pending edit" indicator doesn't turn green after the batch flushes. It only turns green when the user clicks away.

**Works:** Edits at top of grid (rows 0-30)
**Broken:** Edits after scrolling (e.g., row 315+)
**Workaround:** Clicking away forces correct color

## Root Cause Analysis

The issue is a **timing problem** between React's state update and Glide Data Grid's internal callback caching.

### The Flow

1. User edits cell → orange bar (pending edit in `useEditBatchStore`)
2. 500ms later, batch flushes → command executed
3. `setExecutorTimelineVersion((v) => v + 1)` called (DataGrid.tsx:647)
4. React queues a re-render
5. Effect at line 1396-1401 runs, calls `invalidateVisibleCells(true)`
6. `gridRef.current.updateCells(cellsToUpdate)` tells grid to redraw cells
7. Grid redraws using **cached** `drawCell` callback (with OLD `dirtyCells`)
8. Cell still appears orange because old `dirtyCells` doesn't include the committed edit

### Why clicking away fixes it

When the user clicks elsewhere:
1. Selection changes → triggers grid re-render
2. Grid picks up the NEW `drawCell` prop (with updated `dirtyCells`)
3. Cell is redrawn correctly with green indicator

### Why it works at top of grid

At the top, the grid is in a simpler state with less cached data. The timing window is narrower, and the grid more reliably picks up the new callback. After scrolling, there's more complexity in the rendering pipeline.

## Solution

Delay `invalidateVisibleCells()` until AFTER React has re-rendered the component with the updated `drawCell` callback. Use `requestAnimationFrame` to ensure the new props have been applied before telling the grid to redraw.

### Files to Modify

1. **`src/components/grid/DataGrid.tsx`** (~lines 1395-1401)

### Implementation

Change the executor timeline version effect from:

```typescript
// Current (broken)
useEffect(() => {
  if (prevExecutorVersionRef.current !== executorTimelineVersion) {
    invalidateVisibleCells(true)
  }
  prevExecutorVersionRef.current = executorTimelineVersion
}, [executorTimelineVersion, invalidateVisibleCells])
```

To:

```typescript
// Fixed - delay invalidation until after React re-render
useEffect(() => {
  if (prevExecutorVersionRef.current !== executorTimelineVersion) {
    // Use double-rAF to ensure React has applied the new drawCell prop to the grid
    // First rAF: React commit phase completes
    // Second rAF: Grid has received new props
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        invalidateVisibleCells(true)
      })
    })
  }
  prevExecutorVersionRef.current = executorTimelineVersion
}, [executorTimelineVersion, invalidateVisibleCells])
```

### Why double-rAF?

1. **First rAF:** React's commit phase finishes, DOM updates are applied
2. **Second rAF:** The browser has painted, and the grid component has processed its new props

This pattern is commonly used when you need to ensure a component has fully updated before triggering an imperative API call.

## Verification

1. Load a CSV with 500+ rows
2. Scroll down to row ~300
3. Edit a cell → should show orange bar
4. Wait 500ms for batch to flush
5. **Expected:** Orange bar turns green automatically (without clicking away)
6. Repeat for rows at different scroll positions

## Risk Assessment

**Low risk** - This change only delays the visual invalidation by ~32ms (two animation frames). The edit is already committed to DuckDB; this just ensures the visual indicator updates correctly.

## Alternative Considered

Could increment `gridKey` to force full re-mount, but that's expensive and would lose scroll position. The rAF approach is minimal and targeted.
