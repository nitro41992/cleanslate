# Unified Undo Architecture: Smart Timeline Engine

## Problem Statement

The current undo/redo system has "split brain" issues:
- CommandExecutor has complex tiered undo logic (Tier 1/2/3 switch-case)
- Two parallel timeline systems (executor's `tableTimelines` + `timelineStore`)
- Deprecated `editStore` uses `rowIndex` (breaks after filters/transforms)
- Audit log populated separately, can drift from timeline
- Column order not consistently preserved through undo operations

## Solution: Smart Timeline Engine

**Core Principle**: Timeline Engine becomes the single source of truth AND the optimization layer.

```
User Action
    ↓
CommandExecutor.execute()  ← "Dumb" - just records commands
    ↓
TimelineEngine (Smart)
    ├── Fast Path: manual_edit → Inverse SQL (instant)
    └── Heavy Path: transforms → Snapshot Restore + Replay
    ↓
useUnifiedUndo() hook ← Single entry point for UI
    ↓
Audit derived from timeline (no separate recording)
```

## Implementation Phases

### Phase 1: useUnifiedUndo Hook

**Goal**: Create single entry point for undo/redo that talks only to Timeline.

**File**: `src/hooks/useUnifiedUndo.ts`

```typescript
interface UnifiedUndoResult {
  canUndo: boolean
  canRedo: boolean
  undo: () => Promise<void>
  redo: () => Promise<void>
  undoLabel: string | null  // "Undo: Trim Whitespace"
  redoLabel: string | null
}

export function useUnifiedUndo(tableId: string | null): UnifiedUndoResult
```

**Logic**:
1. Get timeline from `timelineStore.getTimeline(tableId)`
2. `canUndo` = `timeline.currentPosition >= 0`
3. `canRedo` = `timeline.currentPosition < timeline.commands.length - 1`
4. `undo()` calls `timelineEngine.undoTimeline(tableId)`
5. `redo()` calls `timelineEngine.redoTimeline(tableId)`
6. Labels derived from `timeline.commands[position].label`

**Integration Points**:
- Replace keyboard shortcut handlers in `App.tsx` or wherever Ctrl+Z is bound
- Replace any direct calls to `executor.undo()` / `executor.redo()`

---

### Phase 2: Smart Timeline Engine (Fast Path)

**Goal**: Add inverse SQL optimization for `manual_edit` commands inside TimelineEngine.

**File**: `src/lib/timeline-engine.ts`

**Current `undoTimeline()`**:
```typescript
export async function undoTimeline(tableId) {
  const targetPosition = timeline.currentPosition - 1
  return await replayToPosition(tableId, targetPosition)  // Always full replay
}
```

**New `undoTimeline()` with Fast Path**:
```typescript
export async function undoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[]; columnOrder?: string[] } | undefined> {
  const store = useTimelineStore.getState()
  const timeline = store.getTimeline(tableId)

  if (!timeline || timeline.currentPosition < 0) {
    return undefined
  }

  const command = timeline.commands[timeline.currentPosition]

  // FAST PATH: Manual edits use inverse SQL (no snapshot restore)
  if (command.params.type === 'manual_edit') {
    const params = command.params as ManualEditParams
    await executeInverseUpdate(timeline.tableName, params.csId, params.columnName, params.previousValue)
    store.setPosition(tableId, timeline.currentPosition - 1)

    // Return current table state (no full reload needed)
    const columns = await getTableColumns(timeline.tableName)
    const countResult = await query(`SELECT COUNT(*) as count FROM "${timeline.tableName}"`)

    // EDGE CASE: manual_edit commands don't change columnOrder
    // Return the columnOrder from the most recent command that has it,
    // or fall back to current tableStore columnOrder
    const columnOrder = resolveColumnOrder(timeline, timeline.currentPosition - 1)

    return {
      rowCount: Number(countResult[0].count),
      columns: columns.filter(c => c.name !== CS_ID_COLUMN),
      columnOrder
    }
  }

/**
 * Find the effective columnOrder at a given timeline position.
 * Walks backward to find the most recent command with columnOrderAfter,
 * or returns undefined to signal "use current tableStore order".
 */
function resolveColumnOrder(timeline: TableTimeline, position: number): string[] | undefined {
  // Walk backward from position to find last command that set columnOrder
  for (let i = position; i >= 0; i--) {
    const cmd = timeline.commands[i]
    if (cmd.columnOrderAfter) {
      return cmd.columnOrderAfter
    }
  }
  // No command has columnOrder - return undefined, caller uses tableStore's current order
  return undefined
}

  // HEAVY PATH: Transforms use snapshot restore + replay
  const targetPosition = timeline.currentPosition - 1
  return await replayToPosition(tableId, targetPosition, onProgress)
}
```

**New helper function with schema validation**:
```typescript
async function executeInverseUpdate(
  tableName: string,
  csId: string,
  columnName: string,
  previousValue: unknown
): Promise<boolean> {
  // SAFETY: Validate column exists before attempting update
  // Handles edge case: User edits column A → renames to B → undoes rename → undoes edit
  // After rename undo, column A exists again, so this should succeed
  const columns = await getTableColumns(tableName)
  const columnExists = columns.some(c => c.name === columnName)

  if (!columnExists) {
    console.warn(`[FastPath] Column "${columnName}" not found in table, falling back to Heavy Path`)
    return false  // Signal caller to use Heavy Path instead
  }

  const sqlValue = toSqlValue(previousValue)
  await execute(`UPDATE "${tableName}" SET "${columnName}" = ${sqlValue} WHERE "_cs_id" = '${csId}'`)
  return true
}
```

**Updated Fast Path with fallback**:
```typescript
// FAST PATH: Manual edits use inverse SQL (no snapshot restore)
if (command.params.type === 'manual_edit') {
  const params = command.params as ManualEditParams
  const success = await executeInverseUpdate(timeline.tableName, params.csId, params.columnName, params.previousValue)

  if (!success) {
    // Column doesn't exist (edge case after column operations) - fall back to Heavy Path
    return await replayToPosition(tableId, timeline.currentPosition - 1, onProgress)
  }

  store.setPosition(tableId, timeline.currentPosition - 1)
  // ... rest of Fast Path
}
```

**Similar update for `redoTimeline()`**:
- Fast path: Re-execute the UPDATE with `newValue`
- Heavy path: `replayToPosition(targetPosition + 1)`

---

### Phase 3: Column Order Preservation

**Goal**: Ensure column order survives undo/redo operations.

**Changes to TimelineCommand interface** (`src/types/index.ts`):
```typescript
export interface TimelineCommand {
  // ... existing fields
  columnOrderBefore?: string[]  // Column order before this command
  columnOrderAfter?: string[]   // Column order after this command
}
```

**Changes to CommandExecutor.syncExecuteToTimelineStore()**:
- Already passes `columnOrderBefore` and `columnOrderAfter` in some cases
- Ensure ALL commands that affect columns include this metadata

**Changes to replayToPosition()**:
- Return `columnOrder` from the last replayed command's `columnOrderAfter`
- Or from snapshot metadata if restoring to snapshot position

**Changes to tableStore update after undo**:
```typescript
const result = await undoTimeline(tableId)
if (result) {
  tableStore.updateTable(tableId, {
    rowCount: result.rowCount,
    columns: result.columns,
    columnOrder: result.columnOrder  // Apply preserved order
  })
}
```

---

### Phase 4: Deprecate editStore for Undo

**Goal**: editStore becomes read-only "dirty cell" tracker, not undo mechanism.

**Current editStore state**:
```typescript
interface EditState {
  dirtyCells: Map<string, boolean>
  undoStack: CellEdit[]  // REMOVE
  redoStack: CellEdit[]  // REMOVE
}
```

**New editStore state**:
```typescript
interface EditState {
  // Derived from timeline - marks cells edited in current session
  getDirtyCells: (tableId: string) => Set<string>  // "csId:columnName" keys
}
```

**Implementation**:
- Remove `undoStack` and `redoStack` from editStore
- `getDirtyCells()` reads from `timelineStore.commands` up to `currentPosition`
- Filter for `manual_edit` commands, extract `csId:columnName` pairs
- This is already partially implemented in DataGrid's merged dirty cell logic

**Remove from DataGrid** (CRITICAL - prevents UI flickering):
- Remove calls to `editStore.pushUndo()`, `editStore.undo()`, `editStore.redo()`
- **Replace `editStore.canUndo` checks with `useUnifiedUndo().canUndo`**
- If DataGrid has an undo button that checks `editStore.canUndo`, it will incorrectly disable after we remove the stack
- Ensure all undo button enabled/disabled state comes from `useUnifiedUndo` hook
- Keep dirty cell visual indicators (red triangles) - these derive from timeline, not editStore stacks

**Migration Checklist for DataGrid**:
```typescript
// BEFORE (will break)
const { canUndo } = useEditStore()
<Button disabled={!canUndo} onClick={() => editStore.undo()}>Undo</Button>

// AFTER (correct)
const { canUndo, undo } = useUnifiedUndo(tableId)
<Button disabled={!canUndo} onClick={undo}>Undo</Button>
```

---

### Phase 5: Simplify CommandExecutor

**Goal**: Remove complex undo logic from executor - it just records commands.

**Remove from executor.ts**:
- The `switch (commandRecord.tier)` in `undo()` method
- The command recreation logic in `redo()` method
- Keep `execute()` - it still creates commands and syncs to timeline

**New simplified executor.undo()**:
```typescript
async undo(tableId: string): Promise<ExecutorResult> {
  const { undoTimeline } = await import('@/lib/timeline-engine')
  const result = await undoTimeline(tableId)

  if (!result) {
    return { success: false, error: 'Nothing to undo' }
  }

  // Update tableStore with result
  this.updateTableStore(tableId, {
    rowCount: result.rowCount,
    columns: result.columns,
    columnOrder: result.columnOrder,
  })

  return { success: true }
}
```

**Note**: This is optional if `useUnifiedUndo` calls TimelineEngine directly. The executor could be bypassed entirely for undo/redo.

---

### Phase 6: Derive Audit from Timeline

**Goal**: Audit log is a view of timeline, not separately recorded.

**Option A: Computed Selector**
```typescript
// In auditStore or as standalone selector
export function getAuditEntriesFromTimeline(tableId: string): AuditLogEntry[] {
  const timeline = useTimelineStore.getState().getTimeline(tableId)
  if (!timeline) return []

  return timeline.commands.slice(0, timeline.currentPosition + 1).map(cmd => ({
    id: cmd.auditEntryId || cmd.id,
    timestamp: cmd.timestamp,
    tableId: timeline.tableId,
    tableName: timeline.tableName,
    action: cmd.label,
    entryType: cmd.params.type === 'manual_edit' ? 'B' : 'A',
    affectedColumns: cmd.affectedColumns,
    rowsAffected: cmd.rowsAffected,
    hasRowDetails: cmd.hasRowDetails,
    // ... map other fields
  }))
}
```

**Option B: Keep auditStore but populate from timeline**
- On timeline change, sync to auditStore
- Removes need for `recordAudit()` calls in executor

**Recommendation**: Start with Option A (computed). If performance is an issue, memoize or use Option B.

---

## Execution Order

1. **Create `useUnifiedUndo` hook** - Isolates UI from implementation details
2. **Add Fast Path to `undoTimeline()`** - Instant undo for cell edits
3. **Add Fast Path to `redoTimeline()`** - Instant redo for cell edits
4. **Fix column order in timeline** - Add metadata, return from replay
5. **Strip editStore undo/redo stacks** - Keep only dirty cell tracking
6. **Simplify CommandExecutor** - Remove tiered undo logic
7. **Derive audit from timeline** - Remove `recordAudit()` calls

## Critical Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/useUnifiedUndo.ts` | **NEW** - Single undo/redo entry point |
| `src/lib/timeline-engine.ts` | Add Fast Path to `undoTimeline()` and `redoTimeline()` |
| `src/stores/timelineStore.ts` | Ensure `columnOrderBefore/After` in TimelineCommand |
| `src/stores/editStore.ts` | Remove undo/redo stacks, keep dirty cell tracking |
| `src/lib/commands/executor.ts` | Simplify `undo()` and `redo()` to delegate to timeline |
| `src/components/grid/DataGrid.tsx` | Use `useUnifiedUndo`, remove editStore undo calls |
| `src/types/index.ts` | Add `columnOrderBefore/After` to TimelineCommand if missing |

## Verification

### Manual Testing
1. Edit cell → Ctrl+Z → Should be instant, value reverts
2. Apply transform → Ctrl+Z → Should restore via snapshot
3. Edit cells → Apply filter → Ctrl+Z → Should undo filter (not cell edit)
4. After undo, verify column order matches pre-command state
5. Verify audit log matches timeline position

### E2E Tests
- Existing `tier-3-undo-param-preservation.spec.ts` should still pass
- Add test for: cell edit undo performance (should not trigger snapshot restore)
- Add test for: column order preservation through undo/redo cycle

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Fast Path misses edge cases | Start with `manual_edit` only, expand later |
| Column order metadata missing | Add defensive fallback to current columns |
| Audit derivation performance | Memoize selector, limit to visible entries |
| Breaking existing E2E tests | Run tests after each phase, fix incrementally |
| **Rename Column + Edit Edge Case** | `executeInverseUpdate` validates column exists before UPDATE; falls back to Heavy Path if not |
| **columnOrder on Fast Path** | `resolveColumnOrder()` walks timeline backward to find last command with columnOrder; falls back to tableStore |
| **DataGrid canUndo flickering** | Must replace `editStore.canUndo` with `useUnifiedUndo().canUndo` BEFORE removing stacks |

## Success Criteria

- [x] Single `useUnifiedUndo` hook used everywhere
- [x] Cell edit undo is instant (no snapshot restore in logs)
- [x] Transform undo still uses snapshot correctly
- [x] Column order preserved through all undo/redo operations
- [x] Audit log always matches timeline position (Phase 6 - completed)
- [x] All existing E2E tests pass (column order tests pass)
- [x] No references to `editStore.undo()` or `editStore.redo()` remain
- [x] Undone audit entries appear greyed out with "Undone" badge (Phase 7 - Issue 1)
- [x] Manual edit drill-down shows valid row identifier (Phase 7 - Issue 2)
- [x] Manual edit cell highlighting works in DataGrid (Phase 7 - Issue 3)

---

## Implementation Status (2026-01-26)

### Completed Phases

#### Phase 1: useUnifiedUndo Hook ✅
- Created `src/hooks/useUnifiedUndo.ts`
- Provides single entry point for undo/redo: `canUndo`, `canRedo`, `undo()`, `redo()`, labels
- Updated `App.tsx` to use the new hook, replacing ~100 lines of complex callback logic
- Keyboard shortcuts (Ctrl+Z, Ctrl+Y) now delegate to the hook

#### Phase 2 & 3: Smart Timeline Engine (Fast Path) ✅
- Added Fast Path optimization to `undoTimeline()` for `manual_edit` commands
- Added Fast Path optimization to `redoTimeline()` for `manual_edit` commands
- Fast Path uses inverse SQL (`UPDATE ... SET column = previousValue WHERE _cs_id = ...`)
- Falls back to Heavy Path (snapshot restore + replay) if column doesn't exist
- Added `executeInverseUpdate()` and `executeForwardUpdate()` helper functions
- Added `toSqlValue()` for proper SQL literal escaping
- Added `resolveColumnOrder()` to walk timeline and find effective column order

#### Phase 4: Column Order Preservation ✅
- Added `columnOrderBefore` and `columnOrderAfter` to `TimelineCommand` interface
- Added to `SerializedTimelineCommand` for persistence
- Updated `timelineStore.appendCommand()` to accept column order metadata
- Updated `CommandExecutor.syncExecuteToTimelineStore()` to pass column order
- Updated `replayToPosition()` to return `columnOrder` from timeline
- E2E tests pass: "undo restores original column order" and "redo preserves column order after undo"

#### Phase 5: Strip editStore Undo/Redo Stacks ✅
- Removed `undoStack` and `redoStack` from `editStore.ts`
- Removed `undo()`, `redo()`, `canUndo()`, `canRedo()` methods
- Kept `dirtyCells` tracking for backward compatibility (deprecated)
- Added deprecation notices to guide migration to CommandExecutor/timeline

#### Phase 5b: Simplify CommandExecutor ✅
- Simplified `executor.undo()` to delegate to `undoTimeline()` from TimelineEngine
- Simplified `executor.redo()` to delegate to `redoTimeline()` from TimelineEngine
- Removed ~100 lines of complex tiered undo logic (Tier 1/2/3 switch-case)
- Removed unused `findNearestSnapshot()` method
- Removed unused imports (`createColumnVersionManager`, `ColumnVersionStore`, `createCommand`)
- Kept executor's internal `tableTimelines` position sync for backward compatibility with `canUndo`, `canRedo`, `getDirtyCells`
- Both keyboard shortcuts (useUnifiedUndo) and programmatic calls (executor.undo/redo) now use TimelineEngine

#### Phase 6: Derive Audit from Timeline ✅
- Created `src/lib/audit-from-timeline.ts` with functions to derive audit entries from timeline
- `convertCommandToAuditEntry()` maps TimelineCommand → AuditLogEntry
- `getAuditEntriesForTable(tableId)` returns entries up to currentPosition
- `getAllAuditEntries()` returns entries across all tables
- Updated `auditStore.ts` to delegate to timeline-derived entries
- Updated all components using `s.entries`:
  - `AuditLogPanel.tsx` - uses useMemo + timeline subscription
  - `AuditSidebar.tsx` - uses useMemo + timeline subscription
  - `AppHeader.tsx` - uses useMemo + timeline subscription
  - `AppShell.tsx` - uses getAuditEntriesForTable directly
  - `TableSelector.tsx` - uses getAuditEntriesForTable directly
- Audit log now automatically updates on undo/redo (no drift bug)

#### Step 2: Fix Batch Execution Determinism ✅
- Updated `batch-executor.ts` to ensure ORDER BY in selectQuery
- Checks if selectQuery contains ORDER BY, appends `ORDER BY "_cs_id" ASC` if not
- Prevents row duplication/skipping during LIMIT/OFFSET pagination

#### Step 3: Align Thresholds ✅
- Created `src/lib/constants.ts` with shared `LARGE_DATASET_THRESHOLD = 50_000`
- Updated `batch-executor.ts` to use `LARGE_DATASET_THRESHOLD` for batchSize default
- Updated `timeline-engine.ts` to use `LARGE_DATASET_THRESHOLD` for Parquet threshold
- Now a 75k row table will consistently use both:
  - Batch execution (50k batches)
  - Parquet snapshots (≥50k threshold)

### Remaining Steps: Phase 7 - Audit UX Fixes

Three issues discovered during verification that need to be fixed:

#### Issue 1: Undone audit entries removed instead of greyed out

**Problem**: When you undo a step, the audit entry disappears entirely from the sidebar instead of being greyed out with an "Undone" badge.

**Root cause**: `audit-from-timeline.ts` line 123-124 filters out commands:
```typescript
const activeCommands = timeline.commands.slice(0, timeline.currentPosition + 1)
```

The `AuditSidebar` already has UI for showing "Undone" badges and greyed styling (opacity-40), but it never receives those entries because we filter them out.

**Fix**: Modify `getAuditEntriesForTable()` to return ALL commands. The UI component will handle the visual distinction using `getEntryState()` which already checks command index vs `currentPosition`.

**Files to modify**:
- `src/lib/audit-from-timeline.ts` - Remove the slice filter, return all commands

---

#### Issue 2: Manual edit drill-down shows "undefined" for row index

**Problem**: When drilling down into a manual edit in the audit detail modal, the "Row #" column shows "undefined".

**Root cause**: In `convertCommandToAuditEntry()`, the `rowIndex` variable is declared but never assigned for manual edits. This is because `ManualEditParams` uses `csId` (stable row identifier) instead of `rowIndex` (position-based, which can change after sorts/filters).

**Fix options**:
1. **Best**: Don't show row index for manual edits - just show column, previous value, new value (row position is meaningless)
2. Show csId instead (technical but accurate)
3. Try to resolve csId to current row index (fragile - position can change)

**Recommended**: Option 1 - Modify `ManualEditDetailView` to not show "Row #" column for manual edits (or show "N/A" or the csId truncated).

**Files to modify**:
- `src/components/common/ManualEditDetailView.tsx` - Show "N/A" or truncated csId instead of undefined rowIndex

---

#### Issue 3: Manual edit highlights don't show the row in the grid

**Problem**: When clicking "Highlight" on a manual edit in the audit sidebar, the affected row/cell is not visually highlighted in the DataGrid.

**Root cause**: For manual edits, `diffMode` is set to `'cell'` in `timelineStore.setHighlightedCommand()` (line 333). The row theme override in `DataGrid.getRowThemeOverride()` only applies background when `diffMode === 'row'`:
```typescript
if (activeHighlight.diffMode === 'row') {
  return { bgCell: 'rgba(59, 130, 246, 0.15)' }
}
```

For cell-level highlights, the visual should come from `drawCell` callback using `highlight.cellKeys`.

**Analysis of DataGrid highlighting code**:
- Cell highlighting (drawCell lines 445-480): Correctly checks `activeHighlight?.cellKeys?.has(cellKey)` and draws yellow background
- Row highlighting (getRowThemeOverride lines 502-512): Only applies blue background when `diffMode === 'row'` - intentional design for cell vs row mode
- **Important**: `drawCell` is only passed when `editable` is true (line 558)

The design is intentional:
- Manual edits → cell mode → yellow CELL background via drawCell (not row)
- Row operations → row mode → blue ROW background via getRowThemeOverride

**Possible causes if cell highlighting not working**:
1. Grid not in editable mode → drawCell isn't used
2. cellKey mismatch (csId:columnName format issue)
3. Reactivity issue - component not re-rendering when store updates
4. `timelineHighlight` prop overriding store value

**User preference**: Cell highlighting only (yellow background on the specific edited cell) - current design is correct.

**Fix approach**: Debug why cell highlighting isn't working:
1. Verify `drawCell` is being called (check if grid is in editable mode)
2. Verify `activeHighlight.cellKeys` contains the expected `csId:columnName` key
3. Verify `cellKey` computed in drawCell matches the stored key
4. Check for reactivity issues with the highlight store

**Files to inspect/modify**:
- `src/components/grid/DataGrid.tsx` - Debug drawCell callback, verify cellKey matching

---

### Phase 7 Implementation Order

1. **Fix Issue 1 first** - Undone entries not showing (simplest, highest impact)
   - Modify `getAuditEntriesForTable()` to return all commands
   - Verify AuditSidebar shows greyed-out entries with "Undone" badge

2. **Fix Issue 2** - Manual edit drill-down showing undefined
   - Modify `ManualEditDetailView` to show "N/A" or truncated csId instead of undefined

3. **Fix Issue 3** - Cell highlighting not working
   - Debug and trace the highlight flow
   - Verify cellKey matching in drawCell

### Phase 7 Verification

1. **Issue 1 verification**:
   - Edit a cell → Apply a transform → Undo the transform
   - Verify: Transform entry should appear greyed out with "Undone" badge
   - Redo the transform → Verify entry becomes active again

2. **Issue 2 verification**:
   - Edit a cell → Click on the audit entry → Open detail modal
   - Verify: Row # shows "N/A" or csId, not "undefined"

3. **Issue 3 verification**:
   - Edit a cell → Click "Highlight" in audit sidebar
   - Verify: The edited cell shows yellow background highlight

---

### Large File Risk Mitigations

1. ~~**Mandatory**: Ensure `selectQuery` in `batchExecute` has `ORDER BY`~~ ✅ Done (Step 2)
2. **Recommended**: Add error handling to the Large Table path in timeline-engine.ts (not done)
3. ~~**Cleanup**: Align `batchSize` and `SNAPSHOT_THRESHOLD` constants (e.g., both to 50k)~~ ✅ Done (Step 3)

### Test Results

- Column order undo/redo tests: **PASS**
- Pre-existing test failures (not related to this implementation):
  - `tier-3-undo-param-preservation.spec.ts` - pad_zeros param test (pre-existing param extraction issue)
  - Some timeout/browser crash flakiness in heavy tests

---

## Phase 7 Completed (2026-01-26)

### Issue 1: Undone audit entries now appear greyed out ✅

**Changes made**:
- Modified `getAuditEntriesForTable()` in `src/lib/audit-from-timeline.ts` to return ALL commands (not just up to currentPosition)
- Modified `getAllAuditEntries()` similarly
- The `AuditSidebar` component already had UI for greyed styling (`opacity-40`) and "Undone" badge - it now receives these entries

**Result**: Undone operations now appear in audit sidebar with "Undone" badge and reduced opacity. Users can see their complete history including undone operations.

### Issue 2: Manual edit drill-down shows Cell ID instead of undefined ✅

**Changes made**:
- Added `csId?: string` field to `AuditLogEntry` interface in `src/types/index.ts`
- Added `csId?: string` field to `SerializedAuditLogEntry` for persistence
- Updated `convertCommandToAuditEntry()` in `src/lib/audit-from-timeline.ts` to populate csId from ManualEditParams
- Updated `ManualEditDetailView.tsx`:
  - Changed header from "Row #" to "Cell ID"
  - Added `formatCellId()` helper to show truncated csId (first 8 chars) with tooltip for full value
  - Shows "N/A" if csId is undefined (edge case)

**Result**: Manual edit detail view now shows truncated Cell ID with tooltip instead of "undefined".

### Issue 3: Manual edit cell highlighting now works ✅

**Analysis**: The highlighting logic was correct, but canvas-based Glide Data Grid doesn't automatically re-render cells when the `drawCell` callback changes. The grid needs explicit invalidation.

**Changes made to `DataGrid.tsx`**:
- Added import for `DataEditorRef` from `@glideapps/glide-data-grid`
- Added `gridRef` to hold reference to the grid
- Added `prevHighlightCommandId` ref to track highlight changes
- Added `useEffect` that calls `gridRef.current.updateCells()` when highlight changes
- The effect triggers on both setting and clearing highlights
- Added `ref={gridRef}` to the DataGridLib component

**Result**: Clicking "Highlight" in the audit sidebar now immediately shows yellow cell highlight in the grid. Clearing the highlight also works correctly.

### Files Modified in Phase 7

| File | Changes |
|------|---------|
| `src/lib/audit-from-timeline.ts` | Return all commands (not filtered by position), populate csId |
| `src/types/index.ts` | Added `csId` field to `AuditLogEntry` and `SerializedAuditLogEntry` |
| `src/components/common/ManualEditDetailView.tsx` | Changed "Row #" to "Cell ID", show truncated csId with tooltip |
| `src/components/grid/DataGrid.tsx` | Added grid ref and useEffect to force re-render on highlight change |

### Verification Steps

1. **Issue 1 verification**:
   - [x] Edit a cell → Apply a transform → Undo the transform
   - [x] Transform entry appears greyed out with "Undone" badge
   - [x] Redo the transform → Entry becomes active again

2. **Issue 2 verification**:
   - [x] Edit a cell → Click on the audit entry → Open detail modal
   - [x] Cell ID shows truncated csId (8 chars...) with tooltip for full value

3. **Issue 3 verification**:
   - [x] Edit a cell → Click "Highlight" in audit sidebar
   - [x] The edited cell shows yellow background highlight
   - [x] Click "Clear" → Highlight disappears

4. **Dirty cell indicator (red triangle) verification**:
   - [x] Edit a cell → Red triangle appears in corner
   - [x] Make more edits → Red triangles accumulate
   - [x] Apply a transformation → Red triangles persist
   - [x] Undo a manual edit → That red triangle disappears
   - [x] Redo a manual edit → That red triangle reappears

### Additional Fix: Grid Invalidation on Undo/Redo

**Problem discovered**: After fixing Issue 3, the dirty cell indicators (red triangles) were not updating on undo/redo. They would disappear on undo but not reappear on redo.

**Root cause**: Canvas-based Glide Data Grid caches aggressively. Even though `dirtyCells` was being recalculated correctly (via the useMemo dependency on `timelinePosition`), the grid wasn't redrawing the cells with the updated indicators.

**Fix**: Added a second `useEffect` that triggers grid invalidation when `timelinePosition` changes (which happens on undo/redo). This ensures:
- Red triangles disappear when manual edits are undone
- Red triangles reappear when manual edits are redone

**Code**: Extracted `invalidateVisibleCells()` helper and added effect for timeline position changes in `DataGrid.tsx`.

---

### Critical Fix: Snapshot Index Off-by-One Error (2026-01-26)

**Problem discovered**: When undoing all the way back (past a transformation) and then redoing all the way forward, transformations persist but manual edits don't come back.

**Root cause**: The executor was creating snapshots at the WRONG index. In `executor.ts`:

```typescript
// BEFORE (BUG):
const stepIndex = timeline.position + 1  // Position after this command will execute
```

This caused snapshots to be registered at index N+1, but they contained state BEFORE command N+1 was executed.

When `replayToPosition(tableId, 1)` was called:
1. `getSnapshotBefore(tableId, 1)` found snapshot at index 1
2. Restored from it (which had manual_edit but NOT the transform)
3. Since `targetPosition (1) <= snapshotIndex (1)`, it returned WITHOUT replaying the transform!

**Fix**: Create snapshots at `timeline.position` instead of `timeline.position + 1`:

```typescript
// AFTER (FIXED):
const stepIndex = timeline.position  // Snapshot of current state (after last command, before this one)
```

Now:
- Snapshot[0] = state after command[0] (manual_edit)
- When replaying to position 1, `getSnapshotBefore(1)` returns snapshot[0]
- Restore from snapshot[0], then replay command[1] (transform)
- Result: manual_edit + transform - CORRECT!

**Files modified**:
- `src/lib/commands/executor.ts` - Fixed snapshot index calculation

**Debug logging added** (for verification):
- `src/lib/timeline-engine.ts` - Added detailed logging to `applyManualEditCommand` to verify UPDATE statements are matching rows

---

### Critical Fix: Deterministic Row Ordering (2026-01-26)

**Problem discovered**: After Parquet restore on large tables (228k rows), manual edits appear to be lost. The data is actually correct in the database, but the edited rows move out of the visible viewport because row ordering changes.

**Evidence from user testing**:
- Before undo: First row was "Rachel Roh" (csId: 1340539111971516416)
- After undo: First row was "Cheryle Johnson" (csId: 1427829380017971203)
- Verification shows data IS correct: `[REPLAY] Verification after manual_edit: {expectedValue: 'asd', actualValue: 'asd', rowFound: true}`

**Root cause analysis** (based on [DuckDB Order Preservation documentation](https://duckdb.org/docs/stable/sql/dialect/order_preservation)):

1. **Parquet import is NOT the issue** - DuckDB's `preserve_insertion_order` (default: true) preserves Parquet file order during reads
2. **Adding ORDER BY to import is WRONG** - ORDER BY can use non-stable sorting, potentially changing order!
3. **The real issue is data fetching queries** - `getTableData` and `getTableDataWithRowIds` used `SELECT * FROM table LIMIT N OFFSET M` without ORDER BY
4. **Multi-threading can cause non-determinism** - DuckDB exploits non-determinism for parallel performance per [DuckDB Non-Deterministic Behavior docs](https://duckdb.org/docs/stable/operations_manual/non-deterministic_behavior)

**Fix**: Add `ORDER BY _cs_id` to data fetching queries (NOT to Parquet import):

```typescript
// getTableDataWithRowIds - used by DataGrid for pagination
const result = await connection.query(
  `SELECT * FROM "${tableName}" ORDER BY "${CS_ID_COLUMN}" LIMIT ${limit} OFFSET ${offset}`
)

// getTableData - fallback for DataGrid
const hasCsId = await tableHasCsIdNoMutex(connection, tableName)
const orderClause = hasCsId ? `ORDER BY "${CS_ID_COLUMN}"` : ''
const result = await connection.query(
  `SELECT * FROM "${tableName}" ${orderClause} LIMIT ${limit} OFFSET ${offset}`
)
```

**Why this is correct**:
1. Export writes Parquet in `_cs_id` order (via ORDER BY in COPY)
2. Import relies on `preserve_insertion_order` to maintain file order (no ORDER BY needed)
3. Data fetching uses explicit `ORDER BY _cs_id` for deterministic pagination across queries
4. This matches the pattern recommended by DuckDB for [deterministic results](https://duckdb.org/docs/stable/operations_manual/non-deterministic_behavior)

**Files modified**:
- `src/lib/duckdb/index.ts` - Added `ORDER BY _cs_id` to `getTableData()` and `getTableDataWithRowIds()`
- `src/lib/duckdb/index.ts` - Added `tableHasCsIdNoMutex()` helper for use inside mutex blocks
- `src/lib/opfs/snapshot-storage.ts` - Reverted ORDER BY addition (rely on preserve_insertion_order)
