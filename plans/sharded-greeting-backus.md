# Fix: Autosave Not Triggering for Manual Cell Edits

## Problem

After commit `1f9827d`, rapid manual cell edits don't trigger autosave. Users get an "unsaved changes" warning when refreshing after making edits.

## Root Cause

**Design conflict** between two optimizations:

1. **Scroll preservation (1f9827d):** To prevent grid scroll reset during cell edits on large tables, `edit:cell` was added to `LOCAL_ONLY_COMMANDS` (line 140) which skips `dataVersion` increment (lines 596-607).

2. **Autosave trigger:** The `usePersistence` subscription (line 347) checks `hasDataChanged = currentVersion > lastVersion`. If `dataVersion` doesn't change, it exits early at line 370.

**Flow:**
```
Cell edit → executor.ts:181 markTableDirty() ✓
         → executor.ts:596-607 isLocalOnlyCommand → skip dataVersion ✗
         → usePersistence subscription fires but:
           line 347: hasDataChanged = false (no version change)
           line 370: tablesToSave.length === 0 → return early ✗
         → No debounce timer → No autosave
```

## Key Files

| File | Lines | Issue |
|------|-------|-------|
| `src/lib/commands/executor.ts` | 140 | `LOCAL_ONLY_COMMANDS` includes `edit:cell` |
| `src/lib/commands/executor.ts` | 596-607 | Skips `dataVersion` for cell edits |
| `src/hooks/usePersistence.ts` | 340-370 | Only triggers on `dataVersion` change |

## Fix

**Add UIStore subscription** in `usePersistence` to catch dirty tables that don't trigger `dataVersion` changes.

### `src/hooks/usePersistence.ts`

Add a secondary subscription after the existing TableStore subscription (around line 455):

```typescript
// 6b. WATCH DIRTY TABLES: Catch cell edits that don't change dataVersion
// Cell edits mark tables dirty via UIStore but skip dataVersion increment
// to preserve scroll position. This subscription ensures they still save.
useEffect(() => {
  if (isRestoring) return

  let cellEditTimeout: NodeJS.Timeout | null = null
  let cellEditMaxWaitTimeout: NodeJS.Timeout | null = null

  const { useUIStore } = await import('@/stores/uiStore')

  const unsubUIStore = useUIStore.subscribe(
    (state) => state.dirtyTableIds,
    (dirtyTableIds, prevDirtyTableIds) => {
      // Find newly dirty tables (weren't dirty before)
      const newlyDirty = [...dirtyTableIds].filter(id => !prevDirtyTableIds.has(id))
      if (newlyDirty.length === 0) return

      // Look up table info
      const tables = useTableStore.getState().tables
      const tablesToSave = newlyDirty
        .map(id => tables.find(t => t.id === id))
        .filter((t): t is NonNullable<typeof t> => t != null)
        .filter(t => {
          // Skip internal timeline tables
          if (t.name.startsWith('original_')) return false
          if (t.name.startsWith('snapshot_')) return false
          if (t.name.startsWith('_timeline_')) return false
          return true
        })

      if (tablesToSave.length === 0) return

      const maxRowCount = Math.max(...tablesToSave.map(t => t.rowCount))
      const debounceTime = getDebounceTime(maxRowCount)
      const maxWait = getMaxWaitTime(maxRowCount)

      // Track firstDirtyAt for maxWait
      const now = Date.now()
      for (const table of tablesToSave) {
        if (!firstDirtyAt.has(table.id)) {
          firstDirtyAt.set(table.id, now)
        }
      }

      // Debounce save
      if (cellEditTimeout) clearTimeout(cellEditTimeout)
      cellEditTimeout = setTimeout(() => {
        console.log('[Persistence] Cell edit debounce save:', tablesToSave.map(t => t.name))
        tablesToSave.forEach(t => {
          saveTable(t.name)
            .then(() => firstDirtyAt.delete(t.id))
            .catch(console.error)
        })
      }, debounceTime)

      // MaxWait safety net
      if (cellEditMaxWaitTimeout) clearTimeout(cellEditMaxWaitTimeout)
      const oldestDirtyTime = Math.min(...tablesToSave.map(t => firstDirtyAt.get(t.id) ?? now))
      const timeUntilMaxWait = Math.max(0, maxWait - (now - oldestDirtyTime))

      if (timeUntilMaxWait > 0 && timeUntilMaxWait < maxWait) {
        cellEditMaxWaitTimeout = setTimeout(() => {
          const stillDirty = tablesToSave.filter(t => firstDirtyAt.has(t.id))
          if (stillDirty.length > 0) {
            if (cellEditTimeout) clearTimeout(cellEditTimeout)
            console.log('[Persistence] Cell edit maxWait save:', stillDirty.map(t => t.name))
            stillDirty.forEach(t => {
              saveTable(t.name)
                .then(() => firstDirtyAt.delete(t.id))
                .catch(console.error)
            })
          }
        }, timeUntilMaxWait)
      }
    },
    { equalityFn: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) }
  )

  return () => {
    unsubUIStore()
    if (cellEditTimeout) clearTimeout(cellEditTimeout)
    if (cellEditMaxWaitTimeout) clearTimeout(cellEditMaxWaitTimeout)
  }
}, [isRestoring, saveTable])
```

### Why This Works

1. **Cell edits call `markTableDirty()`** at executor.ts:181 - this still happens
2. **UIStore.dirtyTableIds changes** - triggers the new subscription
3. **New subscription starts debounce** - independent of `dataVersion`
4. **Scroll preservation intact** - we didn't change the `dataVersion` skip logic

## Alignment with 2025 Best Practices

This approach follows established patterns from the React/Zustand ecosystem:

### 1. Zustand subscribeWithSelector Pattern
Using `subscribe(selector, callback)` to watch specific state slices is the [recommended Zustand pattern](https://zustand.docs.pmnd.rs/middlewares/subscribe-with-selector). It avoids unnecessary re-renders and allows fine-grained reactivity outside React components.

### 2. Debounced Autosave
[Debouncing onChange handlers](https://dev.to/mreigen/reactjs-auto-save-feature-for-any-input-field-1d37) is standard for autosave to prevent storage/network floods during rapid typing. Our adaptive debounce (2-10s based on row count) follows this pattern.

### 3. Dirty State Tracking
Tracking `dirtyFields` separately from data state is a [common pattern in form libraries](https://github.com/pmndrs/zustand/discussions/1179). We use `dirtyTableIds` in UIStore for the same purpose.

### 4. MaxWait Safety Net
The maxWait pattern ensures saves happen even during continuous editing - this prevents data loss if the user types continuously without pausing. This is similar to [lodash debounce's maxWait option](https://github.com/pmndrs/zustand/discussions/696).

### 5. Separation of Concerns
- **TableStore**: Data state (schema, rowCount, dataVersion)
- **UIStore**: UI state (dirty tracking, persistence status)
- **usePersistence**: Orchestrates saves based on both

This follows the [Zustand best practice](https://tkdodo.eu/blog/working-with-zustand) of keeping stores focused and using subscriptions to coordinate between them

## Verification

1. Make a cell edit, wait 2-3 seconds, refresh - no warning
2. Make rapid cell edits (5+ in 2 seconds), wait 2s, refresh - no warning
3. Edit cell in 2M+ row table - scroll position preserved
4. Run E2E tests: `npm run test`

## Files to Modify

1. `src/hooks/usePersistence.ts` - Add UIStore subscription (~30 lines)

## Status: ✅ Complete

### Implementation (commits b60b01a, 41751f7, 2475112)
- Added UIStore subscription in `usePersistence.ts` to catch cell edits that skip dataVersion
- Implemented singleton initialization to prevent 6x duplicate state restoration
- Skip batch mode for cell edits to prevent save cascades
- Added `waitForTimelinesRestored` helper for E2E tests to handle timeline restoration timing

---

# Part 2: Audit Log Batching for Rapid Cell Edits

## Problem

When users make rapid cell edits, each edit creates a separate audit log entry. 10 quick edits = 10 entries cluttering the audit sidebar.

## Goal

Batch rapid cell edits into a single audit entry with drill-down showing all changes:

**Before:** 10 separate "Edit Cell" entries

**After:** 1 entry "Batch edited 10 cells" with drill-down table:
| Cell ID | Column | Before | After |
|---------|--------|--------|-------|
| Row 42 | name | "John" | "Johnny" |
| Row 42 | email | null | "j@x.com" |
| ... | ... | ... | ... |

## Implementation Plan

### 1. Edit Batching Store (`src/stores/editBatchStore.ts`)
Create a new store to accumulate rapid edits before committing to timeline:

```typescript
interface PendingEdit {
  csId: string
  columnName: string
  previousValue: unknown
  newValue: unknown
  timestamp: number
}

interface EditBatchState {
  pendingEdits: Map<string, PendingEdit[]>  // tableId -> edits
  batchTimeout: NodeJS.Timeout | null

  addEdit: (tableId: string, edit: PendingEdit) => void
  flushBatch: (tableId: string) => void
  clearBatch: (tableId: string) => void
}
```

### 2. Modify DataGrid Cell Edit Flow
Instead of executing `edit:cell` immediately:
1. Add edit to `editBatchStore`
2. Apply change to local grid state (instant feedback)
3. Debounce flush (500ms window)
4. On flush: execute single `edit:batch` command

### 3. Implement `edit:batch` Command
Already defined in types (`CommandType = 'edit:batch'`), needs implementation:

```typescript
interface BatchEditParams {
  tableId: string
  tableName: string
  edits: Array<{
    csId: string
    columnName: string
    previousValue: unknown
    newValue: unknown
  }>
}
```

### 4. Update ManualEditDetailView
Currently hard-coded for single cell. Update to handle `cellChanges[]` array:

```typescript
// If multiple changes, render table
if (cellChanges && cellChanges.length > 1) {
  return <BatchEditTable changes={cellChanges} />
}
// Otherwise single cell view (existing)
```

## Files to Modify

1. `src/stores/editBatchStore.ts` - NEW: Accumulate rapid edits
2. `src/components/grid/DataGrid.tsx` - Use batch store instead of direct execute
3. `src/lib/commands/edit/batch.ts` - NEW: Implement batch edit command
4. `src/lib/commands/registry.ts` - Register batch command
5. `src/components/common/ManualEditDetailView.tsx` - Handle multi-cell display
6. `src/lib/audit-from-timeline.ts` - Generate "Batch edited N cells" label

## Verification

1. Make 5 rapid edits in <500ms - see single "Batch edited 5 cells" entry
2. Make edits with >500ms gaps - see individual entries
3. Drill-down shows all cell changes in table format
4. Undo reverts entire batch at once

## Status: ✅ Implemented

### Files Created
- `src/stores/editBatchStore.ts` - Zustand store for accumulating rapid edits with 500ms debounce
- `src/lib/commands/edit/batch.ts` - BatchEditCommand class for executing batched edits

### Files Modified
- `src/lib/commands/edit/index.ts` - Export BatchEditCommand
- `src/lib/commands/index.ts` - Import and register BatchEditCommand
- `src/components/grid/DataGrid.tsx` - Use batch store when batching enabled, direct `edit:cell` when disabled
- `src/components/common/ManualEditDetailView.tsx` - Support multiple cell changes in drill-down
- `src/main.tsx` - Expose editBatchStore and helpers for E2E tests
- `src/lib/audit-from-timeline.ts` - Already had batch_edit support in buildDetails()

### Test Support
- `e2e/helpers/store-inspector.ts` - Added `disableEditBatching()`, `flushEditBatch()`, `waitForEditBatchFlush()`
- Updated test files to disable batching for immediate audit log verification

### How Batching Works
1. User makes cell edit → Local state updated immediately (UI feedback)
2. Edit added to batch store → 500ms debounce timer starts
3. More edits within 500ms → Timer resets, edits accumulated
4. Timer fires → `edit:batch` command executed with all edits
5. Single audit log entry shows "Batch Edit (N cells)" with drill-down table

### Test Behavior
When `disableEditBatching()` is called:
- Batching is bypassed entirely
- Each cell edit executes `edit:cell` command immediately
- Audit log entries appear instantly (original behavior)
