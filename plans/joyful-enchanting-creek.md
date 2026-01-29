# Fix Combiner Unsaved State Race Condition + Add Force Save Button

## Problem
Combined tables created via join/stack get stuck in "unsaved" state due to a race condition in the dirty state management. The save/re-save cycle doesn't properly clear the dirty state.

**Root Cause:** JoinPanel and StackPanel call `addTable()` but don't call `markTableAsRecentlySaved()` afterward. Imported tables call this function, which prevents them from immediately entering the dirty/save cycle for 5 seconds. Combined tables don't, so they get caught in a race where multiple subscriptions fire during save, re-marking the table dirty.

---

## Part 1: Fix the Race Condition

### File: `src/features/combiner/components/JoinPanel.tsx`

**Location:** Lines 117-121 (inside `handleJoin`)

**Current code:**
```typescript
addTable(
  resultTableName.trim(),
  columns.map((c) => ({ ...c, nullable: true })),
  rowCount
)
```

**Fix:** Capture the returned table ID and mark it as recently saved:
```typescript
import { markTableAsRecentlySaved } from '@/hooks/usePersistence'

// In handleJoin:
const newTableId = addTable(
  resultTableName.trim(),
  columns.map((c) => ({ ...c, nullable: true })),
  rowCount
)

// Prevent race condition with auto-save subscription
markTableAsRecentlySaved(newTableId)
```

### File: `src/features/combiner/components/StackPanel.tsx`

**Location:** Lines 90-94 (inside `handleStack`)

**Same fix:** Capture the returned table ID and mark it as recently saved.

---

## Part 2: Add Force Save Button (Fallback)

### File: `src/components/common/PersistenceIndicator.tsx`

**Changes:**
1. Import `Save` icon from lucide-react
2. Import `Button` from `@/components/ui/button`
3. Add a clickable save button next to the indicator when status is `'dirty'` or `'error'`
4. On click: call `forceSaveAll()` from usePersistence

**UI Design:**
```
Before: [amber dot] Unsaved changes
After:  [amber dot] Unsaved changes [save icon button]
```

The button will:
- Only appear when `persistenceStatus === 'dirty'` or `'error'`
- Show a save icon (no text to keep it compact)
- Have tooltip: "Force save all pending changes"
- Be disabled while saving is in progress

### File: `src/hooks/usePersistence.ts`

**Add new exported function:**
```typescript
export async function forceSaveAll(): Promise<void> {
  const { useUIStore } = await import('@/stores/uiStore')
  const { useTableStore } = await import('@/stores/tableStore')

  const dirtyIds = Array.from(useUIStore.getState().dirtyTableIds)
  const tableState = useTableStore.getState()

  // Save each dirty table
  for (const tableId of dirtyIds) {
    const table = tableState.tables.find(t => t.id === tableId)
    if (table) {
      await saveTable(table.name)
    }
  }

  // Force compact changelog
  await compactChangelog(true)

  // Clear dirty states
  for (const tableId of dirtyIds) {
    useUIStore.getState().markTableClean(tableId)
  }
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/features/combiner/components/JoinPanel.tsx` | Import `markTableAsRecentlySaved`, call it after `addTable()` |
| `src/features/combiner/components/StackPanel.tsx` | Import `markTableAsRecentlySaved`, call it after `addTable()` |
| `src/components/common/PersistenceIndicator.tsx` | Add force save button with click handler |
| `src/hooks/usePersistence.ts` | Add `forceSaveAll()` function |

---

## Verification

### Test Race Condition Fix:
1. Open Combiner panel
2. Select two tables and perform a Join
3. Observe persistence indicator - should show "Saving..." then "All changes saved"
4. Repeat with Stack operation
5. Verify tables don't get stuck in "Unsaved changes" state

### Test Force Save Button:
1. If a table somehow gets stuck in "Unsaved changes" state
2. Click the force save button in the status bar
3. Verify status changes to "Saving..." then "All changes saved"
4. Verify Parquet file is written to OPFS
