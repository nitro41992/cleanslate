# Plan: Dirty Cell Indicator Persistence Bug

## Problem Statement
Dirty indicators (red triangles) on edited cells do not persist after page refresh. The user also notes that dirty indicators for cells out of view (after scrolling) also disappear on refresh.

## Root Cause Analysis

### How Dirty Cells Work
1. **Storage**: `cellChanges` array in `TimelineCommand` within `timelineStore`
2. **Key Format**: `"csId:columnName"` where csId is `_cs_id` value
3. **Rendering**: Red triangle in `DataGrid.tsx:504-521` via `drawCell` callback
4. **Computation**: `getDirtyCellsAtPosition(tableId)` at lines 514-535 in timelineStore.ts

### The Bug: Zustand Subscription Race Condition

The `DataGrid.tsx` component (lines 130-150) computes `dirtyCells` via useMemo with these dependencies:
```typescript
const getDirtyCellsAtPosition = useTimelineStore((s) => s.getDirtyCellsAtPosition)
// ...
const dirtyCells = useMemo(() => {
  // ...
}, [tableId, getDirtyCellsAtPosition, timelinePosition, executorTimelineVersion])
```

**The problem**: When `loadTimelines()` is called after page refresh:
1. The function reference `getDirtyCellsAtPosition` doesn't change (it's the same function)
2. The `timelinePosition` may not have changed yet (depends on render timing)
3. So the useMemo doesn't recompute, and `dirtyCells` remains empty

The underlying `timelines` Map IS correctly populated with `cellChanges` after deserialization - but the subscription doesn't trigger a re-render.

## Implementation Plan

### Step 1: Add Store Inspector Helper
**File:** `e2e/helpers/store-inspector.ts`

Add a method to get dirty cells from the timeline store for test assertions:

```typescript
// Add interface
export interface TimelineDirtyCellsState {
  dirtyCells: string[]  // Array of "csId:columnName" keys
  count: number
}

// Add method
async getTimelineDirtyCells(tableId?: string): Promise<TimelineDirtyCellsState> {
  return page.evaluate(({ tableId }) => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
    if (!stores?.timelineStore || !stores?.tableStore) {
      return { dirtyCells: [], count: 0 }
    }
    const tableState = (stores.tableStore as any).getState()
    const timelineState = (stores.timelineStore as any).getState()
    const activeTableId = tableId || tableState?.activeTableId
    const dirtyCells = timelineState?.getDirtyCellsAtPosition?.(activeTableId) || new Set()
    return {
      dirtyCells: Array.from(dirtyCells),
      count: dirtyCells.size,
    }
  }, { tableId })
}
```

### Step 2: Create E2E Test
**File:** `e2e/tests/dirty-cell-persistence.spec.ts`

```typescript
test.describe('Dirty Cell Indicator Persistence', () => {
  // Fresh browser context per test (Tier 3 - OPFS heavy)

  test('should persist dirty cell indicators across page refresh', async () => {
    // 1. Load basic-data.csv (5 rows)
    // 2. Edit cell at row 0, col 1 (name column)
    // 3. Verify dirty cells in timeline store > 0
    // 4. Flush OPFS and save app state
    // 5. Reload page, wait for hydration
    // 6. Verify dirty cells in timeline store still > 0
    // 7. Verify cell key matches original
  })
})
```

### Step 3: Fix the Subscription Bug
**File:** `src/components/grid/DataGrid.tsx`

Change the subscription from function reference to direct timeline data:

```typescript
// BEFORE (lines 120-150):
const getDirtyCellsAtPosition = useTimelineStore((s) => s.getDirtyCellsAtPosition)
const dirtyCells = useMemo(() => {
  const legacyDirtyCells = getDirtyCellsAtPosition(tableId)
  // ...
}, [tableId, getDirtyCellsAtPosition, timelinePosition, executorTimelineVersion])

// AFTER:
const timeline = useTimelineStore((s) => tableId ? s.timelines.get(tableId) : undefined)
const dirtyCells = useMemo(() => {
  if (!tableId || !timeline) return new Set<string>()

  const dirtyCells = new Set<string>()
  for (let i = 0; i <= timeline.currentPosition && i < timeline.commands.length; i++) {
    const cmd = timeline.commands[i]
    if (cmd.cellChanges) {
      for (const change of cmd.cellChanges) {
        dirtyCells.add(`${change.csId}:${change.columnName}`)
      }
    }
    if (cmd.commandType === 'manual_edit' && cmd.params.type === 'manual_edit') {
      dirtyCells.add(`${cmd.params.csId}:${cmd.params.columnName}`)
    }
  }

  // Merge with executor dirty cells (for current session edits not yet in timeline)
  const executor = getCommandExecutor()
  const executorDirtyCells = executor.getDirtyCells(tableId)
  for (const cell of executorDirtyCells) {
    dirtyCells.add(cell)
  }

  return dirtyCells
}, [tableId, timeline, executorTimelineVersion])
```

This subscribes directly to the `timeline` object, which WILL change when `loadTimelines()` sets new timelines.

### Step 4: Verify
1. Run E2E test: `npm run test e2e/tests/dirty-cell-persistence.spec.ts`
2. Manual test: Edit → refresh → verify red triangle
3. Manual test: Edit → scroll away → refresh → scroll back → verify red triangle

## Files to Modify

| File | Change |
|------|--------|
| `e2e/helpers/store-inspector.ts` | Add `getTimelineDirtyCells()` method |
| `e2e/tests/dirty-cell-persistence.spec.ts` | **NEW** - E2E test |
| `src/components/grid/DataGrid.tsx` | Fix timeline subscription (lines 120-150) |

## Test Verification
```bash
npm run test e2e/tests/dirty-cell-persistence.spec.ts
```

---

## Implementation Complete ✅

### Additional Bug Found: BigInt Serialization Mismatch

After implementing the Zustand subscription fix, dirty indicators still didn't show after refresh. Root cause:

**The Problem:**
1. `_cs_id` column is BIGINT in DuckDB (from `ROW_NUMBER() OVER ()`)
2. In `getTableDataWithRowIds()` (line 684), the code used type assertion `as string` but didn't actually convert
3. This meant `csId` was stored as BigInt (`1n`) in `cellChanges`
4. After JSON serialization to app-state.json and restore, the format was inconsistent
5. The dirty cell key comparison `${csId}:${columnName}` failed due to type mismatch

**The Fix:**
Changed `src/lib/duckdb/index.ts` line 684:
```typescript
// BEFORE: Type assertion only, no conversion
const csId = json[CS_ID_COLUMN] as string

// AFTER: Explicit conversion for consistent serialization
const csId = String(json[CS_ID_COLUMN])
```

### Files Modified

| File | Change |
|------|--------|
| `e2e/helpers/store-inspector.ts` | Added `getTimelineDirtyCells()` method ✅ |
| `e2e/tests/dirty-cell-persistence.spec.ts` | **NEW** - 3 E2E tests ✅ |
| `src/components/grid/DataGrid.tsx` | Fixed timeline subscription (lines 118-161) ✅ |
| `src/lib/opfs/snapshot-storage.ts` | Added OPFS write locks and retry logic ✅ |
| `src/lib/duckdb/index.ts` | Fixed BigInt to string conversion (line 684) ✅ |

### All Tests Pass
```
✓ should persist dirty cell indicators across page refresh
✓ should persist dirty cell indicators for scrolled-out-of-view cells
✓ should persist multiple dirty cell indicators across refresh
```
