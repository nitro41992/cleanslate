# Undo/Redo Visual Feedback UI Improvements

## Problem Statement

1. **Audit log doesn't show timeline position** - All entries look the same regardless of whether they've been "undone"
2. **Dirty cell indicator persists** - Red triangle stays even when edit is undone via timeline (editStore and timelineStore are separate systems)

---

## Solution Overview

### 1. Audit Sidebar: Show Timeline Position

**Visual Treatment:**
- **Future/Undone entries**: 40% opacity + "Undone" badge
- **Current entry**: Left border accent + subtle background highlight
- **Past entries**: Normal appearance (100% opacity)
- **Visual separator**: Line with "Current State" label between current and future entries

```
┌─────────────────────────────────────┐
│ Manual Edit [row 5]      [Undone]  │  ← 40% opacity
│ Edit · 1 row              2m ago   │
└─────────────────────────────────────┘
        ─────── Current State ───────
┌─────────────────────────────────────┐
│▎Standardize Values                 │  ← Left accent, bg highlight
│ Transform · 7 rows        3m ago   │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ Trim Whitespace                    │  ← Normal
│ Transform · 20 rows       5m ago   │
└─────────────────────────────────────┘
```

### 2. Dirty Cell Indicator: Timeline-Based Tracking

**Current Problem:** `editStore.dirtyCells` uses row index keys, and timeline undo doesn't sync with it.

**Solution:** Derive dirty state from timeline commands (single source of truth):
- A cell is "dirty" if there's a manual_edit command that modified it AND we're at/past that command's position
- Use `_cs_id:columnName` keys (consistent with timeline's `cellChanges`)
- When position changes, dirty indicators automatically update

---

## Files to Modify

### 1. `src/stores/timelineStore.ts`
Add helper to compute dirty cells from timeline:
```typescript
getDirtyCellsAtPosition: (tableId: string): Set<string> => {
  const timeline = get().timelines.get(tableId)
  if (!timeline) return new Set()

  const dirtyCells = new Set<string>()
  // Only consider commands up to currentPosition
  for (let i = 0; i <= timeline.currentPosition && i < timeline.commands.length; i++) {
    const cmd = timeline.commands[i]
    if (cmd.cellChanges) {
      for (const change of cmd.cellChanges) {
        dirtyCells.add(`${change.csId}:${change.columnName}`)
      }
    }
  }
  return dirtyCells
}
```

### 2. `src/components/grid/DataGrid.tsx`
Replace editStore-based dirty check with timeline-based:
```typescript
// Get dirty cells from timeline instead of editStore
const getDirtyCells = useTimelineStore((s) => s.getDirtyCellsAtPosition)
const dirtyCells = useMemo(() =>
  tableId ? getDirtyCells(tableId) : new Set<string>(),
  [tableId, getDirtyCells, /* trigger on position change */]
)

// In drawCell:
const cellKey = csId ? `${csId}:${colName}` : null
const isCellDirty = cellKey && dirtyCells.has(cellKey)
```

### 3. `src/components/layout/AuditSidebar.tsx`
Add timeline position awareness:

```typescript
// Add imports and hooks
const timeline = useTimelineStore((s) =>
  activeTableId ? s.getTimeline(activeTableId) : null
)
const currentPosition = timeline?.currentPosition ?? -1

// Create lookup: auditEntryId -> command index
const auditEntryToCommandIndex = useMemo(() => {
  const map = new Map<string, number>()
  timeline?.commands.forEach((cmd, idx) => {
    if (cmd.auditEntryId) map.set(cmd.auditEntryId, idx)
  })
  return map
}, [timeline?.commands])

// Helper function
function getEntryState(entry: AuditLogEntry): 'past' | 'current' | 'future' | 'untracked' {
  const cmdIndex = auditEntryToCommandIndex.get(entry.auditEntryId ?? '')
  if (cmdIndex === undefined) return 'untracked'
  if (cmdIndex === currentPosition) return 'current'
  if (cmdIndex < currentPosition) return 'past'
  return 'future'
}

// In render - apply conditional styling:
const state = getEntryState(entry)
const isFuture = state === 'future'
const isCurrent = state === 'current'

<div className={cn(
  'p-2 rounded-lg transition-colors cursor-pointer',
  isFuture && 'opacity-40',
  isCurrent && 'border-l-2 border-primary bg-primary/5',
  !isFuture && 'hover:bg-muted/50'
)}>
  {/* Show "Undone" badge for future entries */}
  {isFuture && (
    <Badge variant="outline" className="text-[10px] opacity-80">Undone</Badge>
  )}
</div>

// Insert separator after current entry (before future entries)
```

### 4. `src/components/layout/AuditSidebar.tsx` (Header Enhancement)
Add position indicator in header:
```typescript
{timeline && timeline.commands.length > 0 && (
  <Badge variant="secondary" className="text-[10px] h-5">
    {timeline.currentPosition + 1}/{timeline.commands.length}
  </Badge>
)}
```

---

## Implementation Sequence

### Phase 1: Audit Sidebar Visual States
1. Add timeline position hooks to AuditSidebar
2. Create `getEntryState()` helper with memoized command index lookup
3. Apply opacity/border styling based on state
4. Add "Undone" badge for future entries
5. Add position badge to header
6. Add "Current State" separator line

### Phase 2: Timeline-Based Dirty Cell Tracking
1. Add `getDirtyCellsAtPosition()` to timelineStore
2. Update DataGrid to use timeline-based dirty state
3. Ensure dirty state recomputes when position changes
4. Remove/deprecate editStore.isDirty() usage for dirty indicators

---

## Verification

1. **Audit Sidebar States:**
   - Load CSV, apply 2-3 transformations
   - Press Ctrl+Z → Latest entry should gray out with "Undone" badge
   - Separator line appears below current entry
   - Press Ctrl+Y → Entry becomes active again
   - Position badge in header updates (e.g., "2/3" → "1/3" → "2/3")

2. **Dirty Cell Indicator:**
   - Edit a cell → Red triangle appears
   - Press Ctrl+Z → Red triangle disappears
   - Press Ctrl+Y → Red triangle reappears
   - Verify works with mixed operations (edit → transform → undo both)

3. **Performance:**
   - Test with 50+ audit entries - no lag on undo/redo
   - Verify grid scrolling still smooth with many dirty cells
