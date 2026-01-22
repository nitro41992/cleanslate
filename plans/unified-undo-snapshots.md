# Unified Undo for Heavy Transformations

## Overview

Add undo/redo support for **heavy transformations** (Clean, Match, Standardize, Combine, Scrub) using a "Stack of Snapshots" pattern, with **hybrid Ctrl+Z** that respects both cell edits and table snapshots.

## Scope

| Operation Type | Undo Strategy | Ctrl+Z Priority |
|----------------|---------------|-----------------|
| Manual Cell Edits | **Cell-level undo stack** (editStore) | **First** |
| Heavy Ops (Filter, Dedupe, Join, Merge, Scrub) | **Table Snapshots** (historyStore) | **Fallback** |

## Architecture: Pointer-Based Snapshots

```typescript
interface HistoryStack {
  snapshots: string[]    // ["_snap_1", "_snap_2", "_snap_3"]
  currentIndex: number   // 1 (pointing to _snap_2)
  tableName: string      // The "live" table name
}
```

**Undo/Redo = move pointer + copy table** (not VIEW - see critical fix below).

## Critical Fixes Addressed

### 1. Views are Read-Only (Technical Flaw)

**Problem**: `CREATE OR REPLACE VIEW` makes the table immutable - `UPDATE` commands fail.

**Fix**: Use `DROP TABLE + CREATE TABLE` instead of VIEW.

```typescript
// WRONG (Views are read-only)
await execute(`CREATE OR REPLACE VIEW "${tableName}" AS SELECT * FROM "${targetSnapshot}"`)

// CORRECT (Mutable table)
await execute(`DROP TABLE IF EXISTS "${tableName}"`)
await execute(`CREATE TABLE "${tableName}" AS SELECT * FROM "${targetSnapshot}"`)
```

**Performance**: ~100-300ms for 500k rows. Acceptable for "Undo" (users expect a beat).

### 2. Hybrid Ctrl+Z (UX Trap Prevention)

**Problem**: If Ctrl+Z only undoes heavy ops, user loses manual edits unexpectedly.

**Scenario**:
1. User runs Filter
2. User corrects 10 typos
3. User hits Ctrl+Z expecting to undo last typo
4. **Result**: System undoes Filter, user loses ALL 10 typo corrections

**Fix**: Hybrid undo - check cell stack first, then table stack.

```typescript
// App.tsx
const handleUndo = async () => {
  // 1. Try Cell Undo first (fast, granular)
  if (editStore.canUndo()) {
    await editStore.undo()  // Reverts last cell edit
    return
  }

  // 2. Fallback to Table Undo (heavy)
  if (historyStore.canUndo(activeTableId)) {
    await historyStore.undo(activeTableId)  // Reverts last Filter/Join
  }
}
```

### 3. Stack Coordination (Edge Case)

**Rule**: When table state changes (snapshot created, undo, redo), **clear cell undo stack**.

**Why**: Cell edits reference row indices that may no longer exist after a table-level change.

```typescript
// historyStore.ts
pushSnapshot: async (tableId) => {
  // ... create snapshot ...

  // Clear cell stack - edits are now "baked in" to the snapshot
  useUiDecorationStore.getState().clearHistory()
}

undo: async (tableId) => {
  // ... restore from snapshot ...

  // Clear cell stack - old edits don't apply to restored state
  useUiDecorationStore.getState().clearHistory()
}
```

### 4. Keystroke Lag Prevention

**Problem**: Snapshotting 500k rows on every cell edit = 200-800ms freeze.

**Fix**: Manual edits do NOT trigger table snapshots.

```typescript
// DataGrid.tsx - Cell Edit
const handleCellEdit = async (row, col, val) => {
  // 1. Push to cell undo stack (instant)
  editStore.recordEdit({ row, col, previousValue, newValue })

  // 2. Perform UPDATE on current table
  await updateCell(tableName, row, col, val)

  // 3. NO TABLE SNAPSHOT - relies on snapshot taken before editing
}
```

### 5. Storage Explosion Prevention

**Problem**: 20 transforms × 100MB = 2GB → QuotaExceededError.

**Fix**: Hard limit with FIFO eviction.

```typescript
const MAX_SNAPSHOTS = 5

pushSnapshot: async (tableId) => {
  const stack = get().stacks.get(tableId)

  // Evict oldest if at limit
  if (stack.snapshots.length >= MAX_SNAPSHOTS) {
    const oldest = stack.snapshots[0]
    await execute(`DROP TABLE IF EXISTS "${oldest}"`)
    stack.snapshots.shift()
  }

  // Create new snapshot
  const snapName = `_snap_${tableId}_${Date.now()}`
  await execute(`CREATE TABLE "${snapName}" AS SELECT * FROM "${tableName}"`)
  stack.snapshots.push(snapName)
  stack.currentIndex = stack.snapshots.length - 1
}
```

## Implementation

### Phase 1: History Store

**New file: `src/stores/historyStore.ts`**

```typescript
import { create } from 'zustand'
import { execute } from '@/lib/duckdb'
import { useUiDecorationStore } from './editStore'

const MAX_SNAPSHOTS = 5

interface HistoryStack {
  snapshots: string[]
  currentIndex: number
  tableName: string
}

interface HistoryState {
  stacks: Map<string, HistoryStack>
}

interface HistoryActions {
  initStack: (tableId: string, tableName: string) => void
  pushSnapshot: (tableId: string) => Promise<void>
  undo: (tableId: string) => Promise<boolean>
  redo: (tableId: string) => Promise<boolean>
  canUndo: (tableId: string) => boolean
  canRedo: (tableId: string) => boolean
  clearHistory: (tableId: string) => Promise<void>
}

export const useHistoryStore = create<HistoryState & HistoryActions>((set, get) => ({
  stacks: new Map(),

  initStack: (tableId, tableName) => {
    const stacks = new Map(get().stacks)
    stacks.set(tableId, { snapshots: [], currentIndex: -1, tableName })
    set({ stacks })
  },

  pushSnapshot: async (tableId) => {
    const stack = get().stacks.get(tableId)
    if (!stack) return

    // Truncate redo history (standard undo behavior)
    if (stack.currentIndex < stack.snapshots.length - 1) {
      const toDelete = stack.snapshots.slice(stack.currentIndex + 1)
      for (const snap of toDelete) {
        await execute(`DROP TABLE IF EXISTS "${snap}"`)
      }
      stack.snapshots = stack.snapshots.slice(0, stack.currentIndex + 1)
    }

    // Evict oldest if at limit
    if (stack.snapshots.length >= MAX_SNAPSHOTS) {
      const oldest = stack.snapshots.shift()
      await execute(`DROP TABLE IF EXISTS "${oldest}"`)
    }

    // Create snapshot
    const snapName = `_snap_${tableId}_${Date.now()}`
    await execute(`CREATE TABLE "${snapName}" AS SELECT * FROM "${stack.tableName}"`)
    stack.snapshots.push(snapName)
    stack.currentIndex = stack.snapshots.length - 1

    // Clear cell undo stack - edits now baked in
    useUiDecorationStore.getState().clearHistory()

    set({ stacks: new Map(get().stacks) })
  },

  undo: async (tableId) => {
    const stack = get().stacks.get(tableId)
    if (!stack || stack.currentIndex < 0) return false

    const targetSnapshot = stack.snapshots[stack.currentIndex]
    stack.currentIndex--

    // Restore mutable copy (not VIEW!)
    await execute(`DROP TABLE IF EXISTS "${stack.tableName}"`)
    await execute(`CREATE TABLE "${stack.tableName}" AS SELECT * FROM "${targetSnapshot}"`)

    // Clear cell stack - old edits don't apply
    useUiDecorationStore.getState().clearHistory()

    set({ stacks: new Map(get().stacks) })
    return true
  },

  redo: async (tableId) => {
    const stack = get().stacks.get(tableId)
    if (!stack || stack.currentIndex >= stack.snapshots.length - 1) return false

    stack.currentIndex++
    const targetSnapshot = stack.snapshots[stack.currentIndex]

    // Restore mutable copy
    await execute(`DROP TABLE IF EXISTS "${stack.tableName}"`)
    await execute(`CREATE TABLE "${stack.tableName}" AS SELECT * FROM "${targetSnapshot}"`)

    // Clear cell stack
    useUiDecorationStore.getState().clearHistory()

    set({ stacks: new Map(get().stacks) })
    return true
  },

  canUndo: (tableId) => {
    const stack = get().stacks.get(tableId)
    return stack ? stack.currentIndex >= 0 : false
  },

  canRedo: (tableId) => {
    const stack = get().stacks.get(tableId)
    return stack ? stack.currentIndex < stack.snapshots.length - 1 : false
  },

  clearHistory: async (tableId) => {
    const stack = get().stacks.get(tableId)
    if (!stack) return
    for (const snap of stack.snapshots) {
      await execute(`DROP TABLE IF EXISTS "${snap}"`)
    }
    stack.snapshots = []
    stack.currentIndex = -1
    set({ stacks: new Map(get().stacks) })
  },
}))
```

### Phase 2: Add clearEdits to editStore

**Modify: `src/stores/editStore.ts`**

Keep existing functionality as-is (no rename needed):
- `dirtyCells` Map for red triangle UI
- `undoStack` / `redoStack` for cell-level undo
- `recordEdit()`, `undo()`, `redo()`, `canUndo()`, `canRedo()`

**Add one new action:**
```typescript
clearEdits: (tableId?: string) => {
  set({
    dirtyCells: new Map(),
    undoStack: [],
    redoStack: [],
  })
}
```

Called by `historyStore` when table state changes (snapshot/undo/redo).

### Phase 3: Unified Undo Hook

**New hook: `src/hooks/useUnifiedUndo.ts`**

Extract undo/redo logic into a reusable hook so both keyboard (App.tsx) and buttons (AppHeader.tsx) behave identically.

```typescript
import { useCallback } from 'react'
import { useUiDecorationStore } from '@/stores/editStore'
import { useHistoryStore } from '@/stores/historyStore'
import { useTableStore } from '@/stores/tableStore'
import { useAuditStore } from '@/stores/auditStore'
import { updateCell } from '@/lib/duckdb'

export function useUnifiedUndo() {
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = useTableStore((s) => s.tables.find((t) => t.id === s.activeTableId))
  const addEntry = useAuditStore((s) => s.addEntry)

  // Cell-level undo
  const canUndoCell = useUiDecorationStore((s) => s.canUndo)
  const undoCell = useUiDecorationStore((s) => s.undo)
  const canRedoCell = useUiDecorationStore((s) => s.canRedo)
  const redoCell = useUiDecorationStore((s) => s.redo)

  // Table-level undo
  const canUndoTable = useHistoryStore((s) => activeTableId ? s.canUndo(activeTableId) : false)
  const undoTable = useHistoryStore((s) => s.undo)
  const canRedoTable = useHistoryStore((s) => activeTableId ? s.canRedo(activeTableId) : false)
  const redoTable = useHistoryStore((s) => s.redo)

  const handleUndo = useCallback(async () => {
    // 1. Try cell undo first (granular)
    if (canUndoCell()) {
      const edit = undoCell()
      if (edit && activeTable) {
        await updateCell(activeTable.name, edit.rowIndex, edit.columnName, edit.previousValue)
      }
      return true
    }

    // 2. Fallback to table undo (heavy)
    if (activeTableId && canUndoTable) {
      const success = await undoTable(activeTableId)
      if (success && activeTable) {
        addEntry(activeTableId, activeTable.name, 'Undo', 'Restored previous table state')
      }
      return success
    }

    return false
  }, [activeTableId, activeTable, canUndoCell, undoCell, canUndoTable, undoTable, addEntry])

  const handleRedo = useCallback(async () => {
    // 1. Try cell redo first
    if (canRedoCell()) {
      const edit = redoCell()
      if (edit && activeTable) {
        await updateCell(activeTable.name, edit.rowIndex, edit.columnName, edit.newValue)
      }
      return true
    }

    // 2. Fallback to table redo
    if (activeTableId && canRedoTable) {
      return await redoTable(activeTableId)
    }

    return false
  }, [activeTableId, activeTable, canRedoCell, redoCell, canRedoTable, redoTable])

  // Combined state for button disable logic
  const canUndo = canUndoCell() || canUndoTable
  const canRedo = canRedoCell() || canRedoTable

  return { handleUndo, handleRedo, canUndo, canRedo }
}
```

**Modify: `src/App.tsx`**

Use the unified hook for keyboard shortcuts:

```typescript
import { useUnifiedUndo } from '@/hooks/useUnifiedUndo'

// In component:
const { handleUndo, handleRedo } = useUnifiedUndo()

// Keyboard handler
useEffect(() => {
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) {
        handleRedo()
      } else {
        handleUndo()
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault()
      handleRedo()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}, [handleUndo, handleRedo])
```

**Modify: `src/components/layout/AppHeader.tsx`**

Use the SAME unified hook for toolbar buttons:

```tsx
import { useUnifiedUndo } from '@/hooks/useUnifiedUndo'

// In component:
const { handleUndo, handleRedo, canUndo, canRedo } = useUnifiedUndo()

// Buttons:
<Button
  onClick={handleUndo}
  disabled={!canUndo}
  title="Undo (Ctrl+Z)"
>
  <Undo2 className="w-4 h-4" />
</Button>

<Button
  onClick={handleRedo}
  disabled={!canRedo}
  title="Redo (Ctrl+Y)"
>
  <Redo2 className="w-4 h-4" />
</Button>
```

**Critical**: Both keyboard and button use the SAME `useUnifiedUndo` hook, ensuring identical behavior.

### Phase 4: Integrate with Heavy Operations

**Modify these files to call `pushSnapshot()` BEFORE operation:**

```typescript
// CleanPanel.tsx
const handleApply = async () => {
  // 1. Snapshot current state (before changes)
  await historyStore.pushSnapshot(activeTable.id)

  // 2. Run transform (cell edits now baked into snapshot)
  const result = await applyTransformation(activeTable.name, step)

  // 3. Log to audit
  addTransformationEntry({ ... })
}
```

Apply same pattern to:
- `src/features/matcher/components/MatchView.tsx`
- `src/features/laundromat/components/StandardizeView.tsx`
- `src/features/combiner/CombinePanel.tsx`
- `src/features/scrubber/ScrubPanel.tsx`

## Critical Files

| File | Status | Change |
|------|--------|--------|
| `src/stores/historyStore.ts` | **NEW** | Pointer-based snapshots, MAX_SNAPSHOTS=5, clears cell stack |
| `src/stores/editStore.ts` | **MODIFY** | Add `clearEdits()` action (no rename) |
| `src/hooks/useUnifiedUndo.ts` | **NEW** | Shared hook for keyboard + button undo/redo |
| `src/App.tsx` | **MODIFY** | Use `useUnifiedUndo` for Ctrl+Z/Y |
| `src/components/layout/AppHeader.tsx` | **MODIFY** | Use `useUnifiedUndo` for toolbar buttons |
| `src/components/panels/CleanPanel.tsx` | MODIFY | `pushSnapshot()` before transform |
| `src/features/matcher/components/MatchView.tsx` | MODIFY | `pushSnapshot()` before merge |
| `src/features/laundromat/components/StandardizeView.tsx` | MODIFY | `pushSnapshot()` before standardize |
| `src/features/combiner/CombinePanel.tsx` | MODIFY | `pushSnapshot()` before stack/join |
| `src/features/scrubber/ScrubPanel.tsx` | MODIFY | `pushSnapshot()` before scrub |

## Behavior Summary

| Action | What Happens |
|--------|--------------|
| Cell edit | Pushed to cell undo stack, no table snapshot |
| Ctrl+Z after cell edit | Reverts cell edit (granular) |
| Heavy op (Filter/Join/etc.) | Creates table snapshot, clears cell stack |
| Ctrl+Z after heavy op | Restores previous table state |
| Cell edit after heavy op | New cell stack starts, edits are "baked in" on next heavy op |

## Verification

1. **E2E tests**:
   - Edit cell → Ctrl+Z → Cell reverts (not table)
   - Run Filter → Ctrl+Z → Filter reverts
   - Edit 3 cells → Run Filter → Ctrl+Z → Filter reverts (cells stay)
   - Edit cell → Ctrl+Z → Ctrl+Z → Table undo (cell stack empty)
   - Apply 6 transforms → Verify MAX_SNAPSHOTS=5 eviction
2. **Performance tests**:
   - Cell edit: <10ms (no snapshot)
   - Table undo on 500k rows: <300ms
3. **Visual tests**:
   - Red triangles appear on edited cells
   - Red triangles clear after table undo

## Notes

- Linear undo only (can't skip steps)
- Cell edits "baked in" when next heavy op runs
- MAX_SNAPSHOTS = 5 (conservative for OPFS quota safety)
- Snapshots cleaned up when table is deleted
- editStore.ts kept as-is (no rename), just adds `clearEdits()` action
