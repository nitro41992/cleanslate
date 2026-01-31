# Phase 3: LRU Undo Cache - Implementation Plan

## Goal
Instant undo for the most recent snapshot (RAM), disk-backed for older snapshots (OPFS Parquet).

## Current Architecture

The codebase already supports both hot (in-memory DuckDB table) and cold (OPFS Parquet) storage:
- `restoreFromSnapshot()` in `timeline-engine.ts` checks `parquet:` prefix
- If parquet: imports from OPFS (~2-5s for large tables)
- If not parquet: uses `duplicateTable()` for instant restore

**Problem:** All snapshots currently go to Parquet (cold), even though the architecture supports in-memory.

## Simplified Approach

Instead of a complex LRU cache with separate store, we'll:

1. **Keep the most recent snapshot in RAM** as a "hot" in-memory table
2. **Track hot status** via existing `snapshotTimestamps` map in executor
3. **Evict on new snapshot** - When creating new snapshot, drop previous hot table
4. **Visual feedback** - Show hot (instant) vs cold (~2s) in AuditLog

### Why 1-slot instead of 2-slot?

- Simpler implementation
- Most users undo the last action, not last 2
- Reduces RAM usage (150MB per hot snapshot per 1M rows)
- Can expand to 2-slot later if needed

---

## Files to Modify

### 1. `src/lib/timeline-engine.ts`

**Changes to `createStepSnapshot()`:**
```typescript
export async function createStepSnapshot(
  tableName: string,
  timelineId: string,
  stepIndex: number
): Promise<string> {
  // 1. Export to Parquet (cold backup) - existing code
  const snapshotId = `snapshot_${timelineId}_${stepIndex}`
  await exportTableToParquet(db, conn, tableName, snapshotId)

  // 2. NEW: Also create in-memory hot copy
  const hotTableName = `_hot_${timelineId}_${stepIndex}`
  await duplicateTable(tableName, hotTableName, true)

  // 3. NEW: Evict previous hot snapshot (if any)
  const tableId = findTableIdByTimeline(timelineId)
  if (tableId) {
    await evictPreviousHotSnapshot(tableId, stepIndex)
  }

  // 4. Register with hot flag in store
  useTimelineStore.getState().createSnapshot(tableId, stepIndex, `parquet:${snapshotId}`, {
    hotTableName: hotTableName  // NEW: track in-memory copy
  })

  return `parquet:${snapshotId}`
}
```

**New function `evictPreviousHotSnapshot()`:**
```typescript
async function evictPreviousHotSnapshot(tableId: string, currentStepIndex: number): Promise<void> {
  const timeline = useTimelineStore.getState().getTimeline(tableId)
  if (!timeline) return

  // Find and drop previous hot tables
  for (const [position, snapshotInfo] of timeline.snapshots) {
    if (position !== currentStepIndex && snapshotInfo.hotTableName) {
      await dropTable(snapshotInfo.hotTableName).catch(() => {})
      // Clear hot flag in store
      useTimelineStore.getState().clearHotSnapshot(tableId, position)
    }
  }
}
```

**Changes to `replayToPosition()` (undo fast path):**
```typescript
// After finding snapshot via getSnapshotBefore()
const snapshotInfo = store.getSnapshotInfo(tableId, snapshotIndex)

if (snapshotInfo?.hotTableName) {
  // HOT PATH: Instant restore from in-memory table
  console.log('[REPLAY] Hot path: instant restore from', snapshotInfo.hotTableName)
  await restoreFromHotSnapshot(tableName, snapshotInfo.hotTableName)
} else {
  // COLD PATH: Load from Parquet
  console.log('[REPLAY] Cold path: loading from Parquet')
  await restoreFromSnapshot(tableName, snapshotTableName)
}
```

**New function `restoreFromHotSnapshot()`:**
```typescript
async function restoreFromHotSnapshot(targetTable: string, hotTable: string): Promise<void> {
  const hotExists = await tableExists(hotTable)
  if (!hotExists) {
    throw new Error(`Hot snapshot table not found: ${hotTable}`)
  }
  await dropTable(targetTable)
  await duplicateTable(hotTable, targetTable, true)
}
```

### 2. `src/stores/timelineStore.ts`

**Extend snapshot tracking:**
```typescript
// Change snapshots type from Map<number, string> to Map<number, SnapshotInfo>
interface SnapshotInfo {
  parquetId: string      // e.g., "parquet:snapshot_abc_1"
  hotTableName?: string  // e.g., "_hot_abc_1" (only for most recent)
}

// In TableTimeline interface:
snapshots: Map<number, SnapshotInfo>
```

**New actions:**
```typescript
// Mark a snapshot as hot (has in-memory copy)
setHotSnapshot: (tableId: string, stepIndex: number, hotTableName: string) => void

// Clear hot flag (after eviction)
clearHotSnapshot: (tableId: string, stepIndex: number) => void

// Get snapshot info with hot status
getSnapshotInfo: (tableId: string, stepIndex: number) => SnapshotInfo | null

// Check if a position has hot snapshot
isSnapshotHot: (tableId: string, stepIndex: number) => boolean
```

### 3. `src/components/common/AuditLogPanel.tsx`

**Add visual indicator for hot/cold:**
```tsx
import { Zap, HardDrive } from 'lucide-react'

// In the entry rendering:
{entry.hasSnapshot && (
  <Badge
    variant={entry.isHotSnapshot ? 'default' : 'outline'}
    className={entry.isHotSnapshot ? 'bg-amber-500/20 text-amber-400' : 'text-muted-foreground'}
  >
    {entry.isHotSnapshot ? (
      <>
        <Zap className="w-3 h-3 mr-1" />
        Instant
      </>
    ) : (
      <>
        <HardDrive className="w-3 h-3 mr-1" />
        ~2s
      </>
    )}
  </Badge>
)}
```

**Derive hot status from timeline:**
```typescript
const entries = useMemo(() => {
  const rawEntries = tableId ? getAuditEntriesForTable(tableId) : getAllAuditEntries()

  // Enhance with hot/cold status
  const timeline = tableId ? useTimelineStore.getState().getTimeline(tableId) : null
  return rawEntries.map((entry, index) => ({
    ...entry,
    isHotSnapshot: timeline?.snapshots.get(index)?.hotTableName ? true : false
  }))
}, [tableId, timelines])
```

### 4. `src/components/grid/TimelineScrubber.tsx`

**Visual distinction for hot/cold snapshots:**
- Hot snapshots: Filled diamond with amber glow
- Cold snapshots: Outlined diamond (gray)
- Tooltip: "Instant undo" vs "~2s undo"

---

## Edge Cases

### Page Refresh
- Hot snapshots are lost on refresh (in-memory tables cleared)
- First undo after refresh is cold (slow)
- After cold undo, that snapshot becomes hot (promoted to RAM)

### Table Deletion
- `clearCommandTimeline()` in executor already drops all snapshots
- Add cleanup for hot tables: `dropTable(hotTableName)` for all hot snapshots

### Rapid Undo/Redo
- Each undo to cold promotes that snapshot to hot
- Previous hot is evicted
- No thrashing issue with 1-slot cache

### Multiple Tables
- Each table has its own hot snapshot (max 1 per table)
- 10 tables = max ~1.5GB hot cache (acceptable)

---

## Testing

### Manual Testing
1. Apply expensive transform (creates snapshot)
2. Verify snapshot indicator shows "Instant"
3. Undo → should be <100ms (hot)
4. Apply another expensive transform
5. First snapshot now shows "~2s" (cold)
6. Undo to first snapshot → should show loading (~2-5s)

### E2E Test
```typescript
test('hot snapshot undo is instant', async () => {
  // Upload file, apply remove_duplicates (creates snapshot)
  await picker.apply('Remove Duplicates')
  await inspector.waitForTransformComplete(tableId)

  // Verify hot indicator in audit log
  const hotBadge = page.getByTestId('audit-entry-0').getByText('Instant')
  await expect(hotBadge).toBeVisible()

  // Time the undo
  const start = Date.now()
  await laundromat.undo()
  await inspector.waitForTransformComplete(tableId)
  const elapsed = Date.now() - start

  // Hot undo should be <500ms (generous margin)
  expect(elapsed).toBeLessThan(500)
})
```

---

## Verification Checklist

- [ ] Hot snapshot created in RAM after expensive transform
- [ ] Previous hot evicted when new snapshot created
- [ ] Undo to hot snapshot is instant (<100ms for small tables)
- [ ] Undo to cold snapshot shows loading and takes ~2-5s
- [ ] AuditLog shows "Instant" vs "~2s" badges
- [ ] TimelineScrubber shows filled vs outlined diamonds
- [ ] Page refresh clears hot cache (first undo is cold)
- [ ] Table deletion cleans up hot snapshots
- [ ] All existing E2E tests pass
