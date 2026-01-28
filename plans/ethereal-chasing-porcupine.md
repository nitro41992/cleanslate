# Plan: Fix Cell Edit Autosave and Non-Blocking Persistence

## Problem Statement

Two issues when users make cell edits while transformations are running:

1. **Manual edits not persisting properly**: User makes cell edits, queued transformations run, dirty indicator shows but values revert to original after transformations complete
2. **UI doesn't reflect changes until queue completes**: Users see stale state during queued operations

## Root Cause Analysis

When cell edits are made with batching enabled:
1. Edit updates local React `data` state immediately (line 721-730 in DataGrid.tsx)
2. Edit is added to `editBatchStore.pendingEdits` (line 748-754)
3. Batch flush is scheduled for 500ms later

**The Problem**: If a transformation runs before the batch flushes:
1. Transform increments `dataVersion` in executor (line ~600 in executor.ts)
2. DataGrid's useEffect triggers (line 248-356), clearing `data` state
3. Fresh data is fetched from DuckDB
4. **Pending edits in `editBatchStore` are NEVER consulted** in `getCellContent`
5. Cell values revert to pre-edit state from DuckDB

## Solution: Optimistic Edit Overlay

Apply pending batch edits on top of DuckDB data during cell rendering, and flush edits before transforms.

## Implementation Plan

### Phase 1: Flush Pending Edits Before Transforms (Critical Fix)

**File: `src/lib/commands/executor.ts`**

In `execute()` method, before executing non-cell-edit commands, flush any pending batch edits:

```typescript
// Around line 168, after extracting tableId
const tableId = (command.params as Record<string, unknown>)?.tableId as string

// NEW: Flush pending batch edits before transforms (not for cell edits)
if (!LOCAL_ONLY_COMMANDS.has(command.type)) {
  const { useEditBatchStore } = await import('@/stores/editBatchStore')
  const hasPendingEdits = useEditBatchStore.getState().hasPendingEdits(tableId)
  if (hasPendingEdits) {
    console.log('[Executor] Flushing pending batch edits before transform')
    await useEditBatchStore.getState().flushAll()
  }
}
```

This ensures edits are committed to DuckDB before any transform runs.

### Phase 2: Apply Pending Edits in Cell Rendering (Optimistic UI)

**File: `src/components/grid/DataGrid.tsx`**

Modify `getCellContent` to overlay pending edits on top of DuckDB data:

```typescript
// In getCellContent callback (around line 609)
const getCellContent = useCallback(
  ([col, row]: Item) => {
    const adjustedRow = row - loadedRange.start
    const rowData = data[adjustedRow]
    const colName = columns[col]

    if (!rowData) {
      return { kind: GridCellKind.Loading as const, allowOverlay: false }
    }

    // Get base value from DuckDB data
    let value = rowData[colName]

    // NEW: Check for pending batch edit that should overlay
    const csId = rowIndexToCsId.get(row)
    if (csId && tableId) {
      const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId)
      const pendingEdit = pendingEdits.find(
        e => e.csId === csId && e.columnName === colName
      )
      if (pendingEdit) {
        value = pendingEdit.newValue
      }
    }

    return {
      kind: GridCellKind.Text as const,
      data: value === null || value === undefined ? '' : String(value),
      displayData: value === null || value === undefined ? '' : String(value),
      allowOverlay: true,
      readonly: !editable,
    }
  },
  [data, columns, loadedRange.start, editable, rowIndexToCsId, tableId]
)
```

### Phase 3: Flush Before Parquet Export (Persistence Safety)

**File: `src/hooks/usePersistence.ts`**

In `saveTable`, flush pending edits before exporting:

```typescript
// In saveTable function (around line 246)
const saveTable = useCallback(async (tableName: string): Promise<void> => {
  // NEW: Flush any pending batch edits for this table
  const table = useTableStore.getState().tables.find(t => t.name === tableName)
  if (table) {
    const { useEditBatchStore } = await import('@/stores/editBatchStore')
    const hasPendingEdits = useEditBatchStore.getState().hasPendingEdits(table.id)
    if (hasPendingEdits) {
      console.log(`[Persistence] Flushing pending edits before saving ${tableName}`)
      await useEditBatchStore.getState().flushAll()
    }
  }

  // ... existing save logic
}, [])
```

### Phase 4: VS Code-Style Left Gutter Bar Indicator (UX Enhancement)

**Design**: Replace the small corner triangle with a highly visible left gutter bar spanning the full row height, following VS Code's git diff indicator pattern.

**Color Scheme**:
- **Orange bar** (`#f97316`) = Pending edit (in batch store, not yet in DuckDB)
- **Green bar** (`#22c55e`) = Committed edit (in DuckDB, dirty state)
- **No bar** = Clean (no unsaved changes)

**File: `src/components/grid/DataGrid.tsx`**

In `drawCell`, draw a left gutter bar instead of corner triangle:

```typescript
// In drawCell callback (around line 812)
const csId = rowIndexToCsId.get(row)
const cellKey = csId ? `${csId}:${colName}` : null

// Check for pending batch edit (not yet committed to DuckDB)
const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId || '')
const hasPendingEdit = pendingEdits.some(
  e => e.csId === csId && e.columnName === colName
)

// Check for committed edit (in DuckDB timeline, shown as dirty)
const isCellDirty = cellKey && dirtyCells.has(cellKey)

// Draw left gutter bar indicator (VS Code style)
// Only draw on first column (col === 0) to avoid duplicate bars
if (editable && col === 0 && (hasPendingEdit || isCellDirty)) {
  ctx.save()

  // Draw full-height bar on left edge of row
  const barWidth = 3
  ctx.fillStyle = hasPendingEdit ? '#f97316' : '#22c55e' // orange pending, green committed
  ctx.fillRect(rect.x, rect.y, barWidth, rect.height)

  ctx.restore()
}

// Also draw cell-level indicator for specific edited cells (not just first column)
if (editable && col > 0 && hasPendingEdit) {
  ctx.save()
  // Small dot in top-left corner for edited cells beyond first column
  ctx.beginPath()
  ctx.arc(rect.x + 6, rect.y + 6, 3, 0, Math.PI * 2)
  ctx.fillStyle = '#f97316' // orange
  ctx.fill()
  ctx.restore()
}
```

**Why Left Gutter Bar?**
- Highly visible during scroll (spans full row height)
- Follows familiar VS Code pattern for git diff indicators
- Clear color distinction: orange = uncommitted batch, green = committed to DuckDB
- Doesn't require scanning individual cells to spot changes

## Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `src/lib/commands/executor.ts` | 1, 5 | Flush pending edits before transforms; Set/clear transform lock |
| `src/components/grid/DataGrid.tsx` | 2, 4, 5 | Apply pending edits in getCellContent; Fix gutter bar to show for ANY edited cell in row (bug fix) |
| `src/hooks/usePersistence.ts` | 3 | Flush pending edits before Parquet export |
| `src/stores/uiStore.ts` | 5 | Add `transformingTables` Set and accessor methods |
| `src/stores/editBatchStore.ts` | 5 | Add `flushIfSafe()` that checks transform lock before flushing |

## Industry Best Practices Applied

Based on research (sources below):

1. **Optimistic UI** ([React docs](https://react.dev/reference/react/useOptimistic)): Show changes immediately, update actual state in background
2. **Queue Coalescing** ([TkDodo's blog](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query)): Cancel/flush pending operations before conflicting operations
3. **Save Queue Pattern** ([PowerSync blog](https://www.powersync.com/blog/sqlite-persistence-on-the-web)): Coalesce rapid changes, flush before critical operations
4. **Operation-Based Updates** ([CRDT.tech](https://crdt.tech/)): Track operations locally, apply in order

## Verification Plan

1. **Manual Test**:
   - Edit a cell
   - Immediately trigger a transformation (e.g., uppercase on different column)
   - Verify edited cell retains its value after transform completes

2. **E2E Test** (new test file: `e2e/tests/cell-edit-during-transform.spec.ts`):
   ```typescript
   test('cell edit persists during concurrent transform', async () => {
     // 1. Upload CSV, edit cell A
     // 2. Trigger transform on column B
     // 3. Verify cell A still has edited value
     // 4. Verify cell A value persists after page refresh
   })
   ```

3. **Existing Tests**: Run full E2E suite to ensure no regressions

## Implementation Order

1. **Phase 1** (Critical): Flush before transforms - fixes data loss ✅ COMPLETED
2. **Phase 2** (Important): Optimistic overlay - fixes UI staleness ✅ COMPLETED
3. **Phase 4** (UX): Left gutter bar indicator - highly visible edit state ✅ COMPLETED
4. **Phase 3** (Safety): Flush before Parquet - ensures persistence ✅ COMPLETED
5. **Phase 5** (Critical): Defer edits during long transforms - fixes edits made DURING transforms ✅ COMPLETED

*Note: Phase 4 moved up because the visual indicator is key to user awareness of edit states*
*Phase 5 addresses a remaining issue discovered after initial implementation*

## Implementation Status

All phases completed on 2025-01-28.

### Changes Made

1. **`src/lib/commands/executor.ts`** (Phase 1)
   - Added flush of pending batch edits before non-cell-edit commands
   - Location: After tableId extraction, before marking table dirty

2. **`src/components/grid/DataGrid.tsx`** (Phase 2 + Phase 4)
   - Modified `getCellContent` to overlay pending edits from `editBatchStore`
   - Added VS Code-style left gutter bar indicator in `drawCell`:
     - Orange bar (#f97316) = Pending edit (in batch store, not yet in DuckDB)
     - Green bar (#22c55e) = Committed edit (in DuckDB timeline)
   - Added per-cell indicators (orange dot for pending, green triangle for committed)

3. **`src/hooks/usePersistence.ts`** (Phase 3)
   - Added flush of pending batch edits before Parquet export in `saveTable`

### Bug: Gutter Bar Only Shows for First Column Edits

**Issue:** The gutter bar logic has a bug - it only shows when the **first column** has edits, not when ANY cell in the row is edited.

**Current Code (line 876):**
```typescript
// BUG: This only triggers if column 0 cell itself has pending edit or is dirty
if (editable && col === 0 && (hasPendingEdit || isCellDirty)) {
  // Then recalculate row-level status inside... but we never get here if col 0 isn't edited
```

**Fix:** Check row-level status BEFORE the condition:

```typescript
// Check row-level pending/dirty status for gutter bar (only needed on col 0)
let rowHasPendingEdit = false
let rowIsDirty = false

if (col === 0 && csId && tableId) {
  const pendingEdits = useEditBatchStore.getState().getPendingEdits(tableId)
  rowHasPendingEdit = pendingEdits.some(e => e.csId === csId)

  // Check all columns for dirty state
  for (const colName of columns) {
    const key = `${csId}:${colName}`
    if (dirtyCells.has(key)) {
      rowIsDirty = true
      break
    }
  }
}

// VS Code-style left gutter bar - show if ANY cell in row has edits
if (editable && col === 0 && (rowHasPendingEdit || rowIsDirty)) {
  ctx.save()
  const barWidth = 3
  ctx.fillStyle = rowHasPendingEdit ? '#f97316' : '#22c55e'
  ctx.fillRect(rect.x, rect.y, barWidth, rect.height)
  ctx.restore()
}
```

This fix will be implemented as part of Phase 5 since it's related to the visual feedback during transforms.

### Test Results

All E2E tests pass:
- `dirty-cell-persistence.spec.ts` (3/3 passed)
- `manual-edit-undo-through-transform.spec.ts` (1/1 passed)
- `transformations.spec.ts` (17/17 passed)
- `opfs-persistence.spec.ts` (6/6 passed)
- `e2e-flow.spec.ts` (3/3 passed)

### Phase 5 Implementation (2025-01-28)

Added transform lock mechanism to prevent edit flushes during long-running transforms:

1. **`src/stores/uiStore.ts`**
   - Added `transformingTables: Set<string>` state
   - Added `setTableTransforming(tableId, isTransforming)` action
   - Added `isTableTransforming(tableId)` accessor

2. **`src/stores/editBatchStore.ts`**
   - Modified debounce timeout to check transform lock before flushing
   - Added `flushIfSafe(tableId)` method that respects transform lock

3. **`src/lib/commands/executor.ts`**
   - Set transform lock at start of non-cell-edit commands
   - Clear transform lock after command completes (both success and error paths)
   - Flush deferred edits after clearing transform lock

**How it works:**
- When a transform starts, the executor acquires a transform lock for that table
- Pending edit flushes check the lock and defer if table is transforming
- When transform completes, lock is released and deferred edits are flushed
- Optimistic UI (Phase 2) keeps edited values visible during the entire process

---

## Phase 5: Defer Edits During Long-Running Transforms (NEW)

### Problem Discovered

After implementing phases 1-4, a critical issue remains: **edits made DURING long-running transforms fail**.

**User Report:**
> "The transformation is still blocking manual edits and I see the orange indicator but it just transitions to nothing (no green). This happened until the entire transformation was complete and the entire datagrid refreshed and then I saw the green indicators."

**Error in Logs:**
```
Error: Catalog Error: Table with name Raw_Data_HF_V6 does not exist!
Did you mean "_staging_Raw_Data_HF_V6"?
```

### Root Cause

For large tables (>500k rows), the batch executor uses a **staging table pattern**:

1. `batchExecute()` creates `_staging_${tableName}` and writes to it in batches
2. During batching, the original table still exists but is read-only
3. After all batches complete, `swapStagingTable()` **drops the original table** and renames staging

**The problem:**
- Edits made BEFORE transform starts are flushed correctly (Phase 1 fix)
- But the batch execution takes time (yields to browser between batches)
- Users can make MORE edits while batches are running
- When these edits try to flush, the original table may be DROPPED
- Error: Table doesn't exist

**Timeline:**
```
T0: Transform starts, flushes existing edits (Phase 1 works)
T1: Batch 1 runs, yields to browser
T2: User makes cell edit during yield → edit added to editBatchStore
T3: Batch 2 runs, yields to browser
T4: Edit batch timeout fires, tries to flush → TABLE DOESN'T EXIST
T5: ... more batches ...
TN: Transform completes, swapStagingTable()
TN+1: Grid refreshes, edit is lost (was never committed)
```

### Solution: Transform Lock Pattern

Track when a table is being transformed. Defer edit flushes until transform completes.

**Key Insight:** The `_cs_id` column is preserved through batch transforms (see `batch-utils.ts:68-69`), so edits can be applied to the new table after transform completes.

### Implementation

#### 5.1 Add Transform Lock to uiStore

**File: `src/stores/uiStore.ts`**

```typescript
interface UIState {
  // ... existing state
  transformingTables: Set<string>  // tableIds currently being transformed

  // Actions
  setTableTransforming: (tableId: string, isTransforming: boolean) => void
  isTableTransforming: (tableId: string) => boolean
}

// In store definition:
transformingTables: new Set(),

setTableTransforming: (tableId, isTransforming) => {
  set((state) => {
    const newSet = new Set(state.transformingTables)
    if (isTransforming) {
      newSet.add(tableId)
    } else {
      newSet.delete(tableId)
    }
    return { transformingTables: newSet }
  })
},

isTableTransforming: (tableId) => {
  return get().transformingTables.has(tableId)
},
```

#### 5.2 Set Lock in Executor

**File: `src/lib/commands/executor.ts`**

Around line 230 (before batch execution starts):

```typescript
// Set transform lock for non-cell-edit commands
if (!LOCAL_ONLY_COMMANDS.has(command.type)) {
  uiStoreModule.useUIStore.getState().setTableTransforming(tableId, true)
}

try {
  // ... existing execution logic (build context, execute, etc.)

} finally {
  // Always clear transform lock, even on error
  if (!LOCAL_ONLY_COMMANDS.has(command.type)) {
    uiStoreModule.useUIStore.getState().setTableTransforming(tableId, false)
  }
}
```

#### 5.3 Defer Flush in editBatchStore

**File: `src/stores/editBatchStore.ts`**

Modify the flush logic to check transform lock:

```typescript
// In addEdit, before scheduling flush:
const timeout = setTimeout(async () => {
  const currentEdits = get().pendingEdits.get(tableId) || []
  if (currentEdits.length === 0 || !flushCallback) return

  // NEW: Check if table is being transformed
  const { useUIStore } = await import('@/stores/uiStore')
  if (useUIStore.getState().isTableTransforming(tableId)) {
    // Defer flush - reschedule for later
    console.log('[EditBatch] Deferring flush - table is being transformed')
    // Re-add the timeout to try again after BATCH_WINDOW
    const deferredTimeout = setTimeout(() => {
      // Recursive call - will check lock again
      const edits = get().pendingEdits.get(tableId) || []
      if (edits.length > 0 && flushCallback) {
        // This will schedule another check via addEdit logic
        // For now, just trigger the callback when safe
        if (!useUIStore.getState().isTableTransforming(tableId)) {
          flushCallback(tableId, edits)
          get().clearBatch(tableId)
        }
      }
    }, BATCH_WINDOW)

    // Update timeout map
    const newTimeouts = new Map(get().batchTimeouts)
    newTimeouts.set(tableId, deferredTimeout)
    set({ batchTimeouts: newTimeouts })
    return
  }

  // Table not being transformed - flush normally
  flushCallback(tableId, currentEdits)
  get().clearBatch(tableId)
}, BATCH_WINDOW)
```

#### 5.4 Trigger Deferred Flush After Transform

**File: `src/lib/commands/executor.ts`**

After clearing transform lock, trigger deferred flush:

```typescript
} finally {
  if (!LOCAL_ONLY_COMMANDS.has(command.type)) {
    uiStoreModule.useUIStore.getState().setTableTransforming(tableId, false)

    // Trigger deferred flush of any pending edits
    const { useEditBatchStore } = await import('@/stores/editBatchStore')
    const hasPendingEdits = useEditBatchStore.getState().hasPendingEdits(tableId)
    if (hasPendingEdits) {
      console.log('[Executor] Flushing deferred edits after transform')
      await useEditBatchStore.getState().flushAll()
    }
  }
}
```

### Alternative Simpler Approach: Polling-Based Deferred Flush

Instead of complex retry logic in editBatchStore, use a simpler approach:

**File: `src/stores/editBatchStore.ts`**

```typescript
// Add a function to check and flush if safe
export async function flushIfSafe(tableId: string): Promise<boolean> {
  const { useUIStore } = await import('@/stores/uiStore')
  if (useUIStore.getState().isTableTransforming(tableId)) {
    return false // Table is being transformed, can't flush
  }

  const store = useEditBatchStore.getState()
  const edits = store.getPendingEdits(tableId)
  if (edits.length === 0) return true // Nothing to flush

  if (flushCallback) {
    await flushCallback(tableId, edits)
    store.clearBatch(tableId)
    return true
  }
  return false
}

// In addEdit, modify the timeout:
const timeout = setTimeout(async () => {
  const flushed = await flushIfSafe(tableId)
  if (!flushed) {
    console.log('[EditBatch] Flush deferred - table transforming')
    // Don't clear timeout - will be retried when transform completes
  }
}, BATCH_WINDOW)
```

Then in executor.ts, after transform completes:
```typescript
// After clearing transform lock
await flushIfSafe(tableId)
```

### Visual Feedback During Transforms

The existing optimistic UI (Phase 2) already handles this:
- `getCellContent` overlays pending edits from `editBatchStore`
- Orange indicator shows edits are pending
- After transform completes and flush succeeds, indicator turns green

**No additional UI changes needed** - the existing optimistic overlay keeps user edits visible during the transform.

### Files to Modify (Phase 5)

| File | Change |
|------|--------|
| `src/stores/uiStore.ts` | Add `transformingTables` Set and accessor methods |
| `src/lib/commands/executor.ts` | Set/clear transform lock around execution, flush deferred edits after |
| `src/stores/editBatchStore.ts` | Add `flushIfSafe()` that checks transform lock before flushing |

### Verification

1. **Manual Test:**
   - Load a large dataset (500k+ rows)
   - Start a long-running transform (e.g., standardize_date on all rows)
   - While transform is running, make cell edits
   - Verify orange indicator appears and persists during transform
   - Verify edits transition to green after transform completes
   - Verify edited values are preserved

2. **E2E Test Enhancement:**
   ```typescript
   test('cell edit during long transform persists', async () => {
     // 1. Upload large CSV (or mock large table)
     // 2. Start transform that takes multiple seconds
     // 3. Make cell edit during transform execution
     // 4. Wait for transform to complete
     // 5. Verify cell edit value is preserved
   })
   ```

---

## Sources

### Optimistic Updates & Persistence
- [React useOptimistic Hook](https://react.dev/reference/react/useOptimistic)
- [TkDodo: Concurrent Optimistic Updates in React Query](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query)
- [PowerSync: SQLite Persistence on the Web (2025)](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- [CRDT.tech: Conflict-free Replicated Data Types](https://crdt.tech/)
- [RxDB: OPFS Storage](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html)

### Visual Indicator Design Research
- [VS Code Git Gutter Indicators](https://vscode-docs.readthedocs.io/en/latest/editor/versioncontrol/) - Left margin color bars (green/blue/red)
- [AG Grid: Highlighting Changes](https://www.ag-grid.com/javascript-data-grid/change-cell-renderers/) - Cell flash animations, CSS classes
- [Retool Edit Table](https://www.retoolers.io/blog-posts/retool-edit-table-effortless-inline-editing) - Per-row save/discard pattern
- [Appsmith Inline Editing](https://docs.appsmith.com/reference/widgets/table/inline-editing) - Table-level save actions
- [VS Code Unsaved File Affordance](https://www.waveguide.io/examples/entry/unsaved-file-affordance/) - Dot indicator pattern
- [Data Table Design UX Patterns](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables) - Enterprise table best practices
