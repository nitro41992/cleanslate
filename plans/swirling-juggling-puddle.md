# Plan: Preserve Grid Scroll Position During Cell Edits (2M Row Scale)

## Problem Summary

Every manual cell edit causes the grid to scroll back to the top-left. At 2M rows, this makes the app unusable for editing data deep in the dataset.

**Root Cause:** `CommandExecutor.updateTableStore()` increments `dataVersion` for ALL commands (line 1141), including simple cell edits. This triggers the DataGrid's main `useEffect` (line 247), which runs `setData([])` and reloads all data from DuckDB, losing scroll position.

**Irony:** The code already does local state updates (lines 451-460) and dirty cell invalidation — but the `dataVersion` change bypasses all that.

---

## Solution: Skip `dataVersion` Increment for Cell Edits

The industry-standard approach is to differentiate between **structural changes** (require full reload) and **cell value changes** (handled locally).

### Changes Required

#### 1. Add `skipDataVersionBump` flag to executor result

**File:** `src/lib/commands/executor.ts`

In the `execute()` method, after command execution, check if this is a "local-only" command that doesn't require a full grid reload:

```typescript
// Commands that modify cell values but don't change structure
const LOCAL_ONLY_COMMANDS = new Set(['edit:cell', 'edit:batch'])

// In execute(), after successful execution:
const skipDataVersionBump = LOCAL_ONLY_COMMANDS.has(command.type)

// Modify updateTableStore call:
if (!skipDataVersionBump) {
  this.updateTableStore(tableId, result)
}
```

#### 2. Add scroll position save/restore (fallback for structural changes)

**File:** `src/components/grid/DataGrid.tsx`

For transforms that DO require full reload (row count changes, column changes), preserve scroll position:

```typescript
// New state to track scroll position
const scrollPositionRef = useRef<{ col: number; row: number } | null>(null)

// Save position in onVisibleRegionChanged (already called on scroll)
const onVisibleRegionChanged = useCallback(
  async (range: { x: number; y: number; width: number; height: number }) => {
    // Save current position for restore after reload
    scrollPositionRef.current = { col: range.x, row: range.y }
    // ... existing prefetch logic
  },
  [...]
)

// Restore position after data loads (in the main useEffect, after setData)
useEffect(() => {
  // ... existing data loading logic ...

  // After data loads, restore scroll position
  if (scrollPositionRef.current && gridRef.current) {
    const { col, row } = scrollPositionRef.current
    // Use requestAnimationFrame to ensure grid has rendered
    requestAnimationFrame(() => {
      gridRef.current?.scrollTo(col, row)
    })
  }
}, [...])
```

#### 3. Optimize `getCellContent` dependencies (long-term)

**File:** `src/components/grid/DataGrid.tsx`

Move data to a ref to avoid recreating `getCellContent` on every data change:

```typescript
// Replace useState with useRef for data (visible rows cache)
const dataRef = useRef<Record<string, unknown>[]>([])

// Sync state to ref when data changes
useEffect(() => {
  dataRef.current = data
}, [data])

// Update getCellContent to read from ref
const getCellContent = useCallback(
  ([col, row]: Item) => {
    const adjustedRow = row - loadedRangeRef.current.start
    const rowData = dataRef.current[adjustedRow]
    // ... rest unchanged
  },
  [columns, editable]  // Remove 'data' from dependencies
)
```

---

## Implementation Order

| Step | Change | Impact | Risk |
|------|--------|--------|------|
| 1 | Skip `dataVersion` for `edit:cell` | Fixes 95% of cases | Low - cell edits already update locally |
| 2 | Save/restore scroll position | Fallback for transforms | Low - additive change |
| 3 | Ref-based `getCellContent` | Performance at 2M rows | Medium - needs careful testing |

---

## Files to Modify

1. **`src/lib/commands/executor.ts`** (~10 lines)
   - Add `LOCAL_ONLY_COMMANDS` set
   - Conditionally skip `updateTableStore` for cell edits

2. **`src/components/grid/DataGrid.tsx`** (~25 lines)
   - Add `scrollPositionRef`
   - Save position in `onVisibleRegionChanged`
   - Restore position after data loads in main `useEffect`
   - (Optional Step 3) Move data to ref for `getCellContent` optimization

---

## Verification

1. **Manual Test - Cell Edit:**
   - Load a large CSV (100k+ rows)
   - Scroll to row ~50,000
   - Edit a cell
   - **Expected:** Grid stays at same scroll position

2. **Manual Test - Transform:**
   - Scroll to row ~50,000
   - Apply a transform (e.g., trim whitespace)
   - **Expected:** Grid returns to approximately same scroll position

3. **E2E Test:**
   - Add test in `e2e/tests/grid-scroll-position.spec.ts`
   - Verify scroll position preserved after cell edit
   - Verify scroll position restored after transform

---

## Why This Approach?

1. **Minimal change** - Only ~35 lines of code
2. **Follows industry pattern** - AG Grid, MUI DataGrid use same approach
3. **Backwards compatible** - Structural changes still trigger full reload
4. **Scales to 2M rows** - No new data structures or caching layers
5. **Uses existing infrastructure** - `scrollTo` API already available on gridRef
