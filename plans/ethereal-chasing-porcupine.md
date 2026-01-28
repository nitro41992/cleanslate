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

| File | Change |
|------|--------|
| `src/lib/commands/executor.ts` | Flush pending edits before non-cell-edit commands |
| `src/components/grid/DataGrid.tsx` | Apply pending edits in getCellContent, optional visual feedback |
| `src/hooks/usePersistence.ts` | Flush pending edits before Parquet export |

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

*Note: Phase 4 moved up because the visual indicator is key to user awareness of edit states*

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

### Test Results

All E2E tests pass:
- `dirty-cell-persistence.spec.ts` (3/3 passed)
- `manual-edit-undo-through-transform.spec.ts` (1/1 passed)
- `transformations.spec.ts` (17/17 passed)
- `opfs-persistence.spec.ts` (6/6 passed)
- `e2e-flow.spec.ts` (3/3 passed)

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
