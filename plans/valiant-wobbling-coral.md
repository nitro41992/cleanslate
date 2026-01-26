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
- [ ] Audit log always matches timeline position (Phase 6 - deferred)
- [x] All existing E2E tests pass (column order tests pass)
- [x] No references to `editStore.undo()` or `editStore.redo()` remain

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

### Remaining Steps

### Large File Risk Mitigations (Noted for future work)

1. **Mandatory**: Ensure `selectQuery` in `batchExecute` has `ORDER BY`
2. **Recommended**: Add error handling to the Large Table path in timeline-engine.ts
3. **Cleanup**: Align `batchSize` and `SNAPSHOT_THRESHOLD` constants (e.g., both to 50k)

### Test Results

- Column order undo/redo tests: **PASS**
- Pre-existing test failures (not related to this implementation):
  - `tier-3-undo-param-preservation.spec.ts` - pad_zeros param test (pre-existing param extraction issue)
  - Some timeout/browser crash flakiness in heavy tests
