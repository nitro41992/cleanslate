# Fix Excessive Snapshots and Arrow Cache Invalidation

## Problem Summary

Two critical issues after Phase 1-4 of disk-backed architecture:

1. **Import "Double Tax"**: Writing same data twice - Timeline snapshot + Persistence export
2. **Transform "Save Storm"**: 3 separate saves for one transform
3. **Stale Arrow Cache**: Cell edits succeed but grid shows old values
4. **Spinning Persistence Loop**: pendingSave blindly re-saves without dirty check

---

## Implementation Plan

### Phase 1: Eliminate Import Double-Export (File Copy)

**Problem**: Import exports data twice - once for timeline snapshot, again for persistence.

**Solution**: Use OPFS file copy (instant) instead of second export (slow).

**File: `src/lib/opfs/opfs-helpers.ts`**

Add `copyFile` function:
```typescript
/**
 * Copy a file within the same directory.
 * Much faster than re-exporting from DuckDB.
 */
export async function copyFile(
  dir: FileSystemDirectoryHandle,
  sourceName: string,
  destName: string
): Promise<void> {
  const sourceHandle = await dir.getFileHandle(sourceName, { create: false })
  const sourceFile = await sourceHandle.getFile()
  const content = await sourceFile.arrayBuffer()

  const destHandle = await dir.getFileHandle(destName, { create: true })
  const writable = await destHandle.createWritable()
  await writable.write(content)
  await writable.close()

  console.log(`[OPFS] Copied ${sourceName} → ${destName}`)
}
```

**File: `src/lib/timeline-engine.ts`**

Modify `createTimelineOriginalSnapshot()` to also create persistence copy:

After Parquet export (around line 147 and 165):
```typescript
// After: await exportTableToParquet(db, conn, tableName, `original_${safeTableName}`)

// Create persistence copy via file copy (instant, no re-export)
const { getSnapshotDir } = await import('@/lib/opfs/snapshot-storage')
const { copyFile } = await import('@/lib/opfs/opfs-helpers')
const dir = await getSnapshotDir()

// Copy chunked files if they exist, otherwise copy single file
const sourcePrefix = `original_${safeTableName}`
const destPrefix = safeTableName
// ... handle both chunked and single file cases
await copyFile(dir, `${sourcePrefix}.parquet`, `${destPrefix}.parquet`)

// Mark as recently saved to suppress auto-save
const { markTableAsRecentlySaved } = await import('@/hooks/usePersistence')
markTableAsRecentlySaved(tableId, 10_000) // 10 second window
console.log(`[Timeline] Created persistence copy via file copy`)
```

**File: `src/hooks/useDuckDB.ts`**

**DELETE lines 264-297** (the redundant persistence export block):
```typescript
// REMOVE THIS ENTIRE BLOCK:
// setLoadingMessage('Saving to storage...')
// try {
//   const { exportTableToParquet } = await import('@/lib/opfs/snapshot-storage')
//   ... 30 lines of redundant persistence code
// }

// Replace with:
console.log('[Import] Timeline snapshot serves as persistence (via file copy)')
```

**Impact**: Import I/O reduced by 50% (70MB → 35MB for 1M rows)

---

### Phase 2: Suppress Auto-Save After Step Snapshot

**Problem**: Step snapshot triggers auto-save because it marks table dirty.

**Solution**: Call `markTableAsRecentlySaved()` immediately after step snapshot.

**File: `src/lib/timeline-engine.ts`**

In `createStepSnapshot()`, after Parquet export (around line 326 and 357):
```typescript
// After: await exportTableToParquet(db, conn, tableName, snapshotId)

// Suppress auto-save - the snapshot IS the save
const { markTableAsRecentlySaved } = await import('@/hooks/usePersistence')
if (tableId) {
  markTableAsRecentlySaved(tableId, 10_000) // 10 second window
  console.log(`[Snapshot] Suppressing auto-save for ${tableId}`)
}
```

**Impact**: Transform saves reduced from 3 to 1

---

### Phase 3: Arrow Cache Surgical Invalidation

**Problem**: `getCellContent` reads stale Arrow buffer, ignores updated React state.

**Solution**: Invalidate specific Arrow page(s) after cell edit.

**File: `src/components/grid/DataGrid.tsx`**

Add invalidation helper (after line ~420):
```typescript
/**
 * Invalidate Arrow pages containing the specified rows.
 * Forces getCellContent to read from React state on next access.
 */
const invalidateArrowPagesForRows = useCallback((affectedRows: number[]) => {
  if (affectedRows.length === 0) return

  const minRow = Math.min(...affectedRows)
  const maxRow = Math.max(...affectedRows)

  // Clear affected pages from cache ref
  for (const [pageStart, page] of arrowPageCacheRef.current) {
    const pageEnd = pageStart + page.rowCount
    if (!(maxRow < pageStart || minRow >= pageEnd)) {
      arrowPageCacheRef.current.delete(pageStart)
    }
  }

  // Clear from loaded pages array
  loadedArrowPagesRef.current = loadedArrowPagesRef.current.filter(page => {
    const pageEnd = page.startRow + page.rowCount
    return maxRow < page.startRow || minRow >= pageEnd
  })

  console.log(`[DataGrid] Invalidated Arrow cache for rows ${minRow}-${maxRow}`)
}, [])
```

Call after batch flush success (line ~553):
```typescript
if (result.success) {
  console.log(`[DATAGRID] Batch edit successful: ${edits.length} cells`)

  // Invalidate Arrow cache for edited rows
  const editedRowIndices: number[] = []
  for (const edit of edits) {
    for (const [csId, rowIdx] of csIdToRowIndex) {
      if (csId === edit.csId) {
        editedRowIndices.push(rowIdx)
        break
      }
    }
  }
  invalidateArrowPagesForRows(editedRowIndices)

  // ... rest of success handling
}
```

Call after immediate edit success (line ~1452):
```typescript
if (result?.success) {
  invalidateArrowPagesForRows([row])
  // ... rest of success handling
}
```

**Impact**: Cell edits immediately visible without full reload

---

### Phase 4: Dirty Check Guard for Pending Saves

**Problem**: `pendingSave` loop blindly re-saves without checking if table is actually dirty.

**Solution**: Check `dirtyTableIds.has(tableId)` before re-triggering save.

**File: `src/hooks/usePersistence.ts`**

Fix the pending save handler (lines 970-976):
```typescript
if (pendingSave.get(tableName)) {
  pendingSave.delete(tableName)

  // CRITICAL: Only re-save if table is actually dirty
  const table = useTableStore.getState().tables.find(t => t.name === tableName)
  const tableId = table?.id

  if (tableId && useUIStore.getState().dirtyTableIds.has(tableId)) {
    console.log(`[Persistence] ${tableName} still dirty, re-saving...`)
    saveTable(tableName).catch(console.error)
  } else {
    console.log(`[Persistence] ${tableName} is clean, dropping pending save`)
  }
}
```

**Impact**: Eliminates spurious re-save loops

---

## Files Modified Summary

| File | Change | Lines |
|------|--------|-------|
| `src/lib/opfs/opfs-helpers.ts` | Add `copyFile()` function | +15 |
| `src/lib/timeline-engine.ts` | File copy after snapshot, markTableAsRecentlySaved | +20 |
| `src/hooks/useDuckDB.ts` | Remove redundant persistence block | -30 |
| `src/hooks/usePersistence.ts` | Add dirty check guard | +10 |
| `src/components/grid/DataGrid.tsx` | Add Arrow cache invalidation | +35 |

---

## Expected Results

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| Import I/O (1M rows) | ~140MB | ~70MB | 50% |
| Transform saves | 3 | 1 | 67% |
| Cell edit visibility | Stale | Immediate | Fixed |
| Spurious re-saves | Yes | No | Fixed |

---

## Verification

1. **Import test**:
   - Load 1M row CSV
   - Count "[Snapshot] Exported chunk" logs
   - Should see ~5 chunks (not 10)
   - Should see "[OPFS] Copied original_* → *" log

2. **Cell edit test**:
   - Edit a cell
   - Verify grid shows new value immediately
   - Check for "[DataGrid] Invalidated Arrow cache" log

3. **Transform test**:
   - Apply uppercase to 1M rows
   - Count save operations in console
   - Should see only step snapshot, no auto-save

4. **E2E tests**:
   - Run existing persistence tests
   - Ensure no regressions

---

## Alignment with Disk-Backed Architecture

Preserves Phases 1-4:
- **Phase 1** (Single Active Table): Freeze/thaw unchanged
- **Phase 2** (Arrow Transport): O(1) access preserved, selective invalidation added
- **Phase 3** (LRU Undo Cache): Step snapshots work correctly, suppresses redundant saves
- **Phase 4** (Lazy Hydration): Compatible with file copy optimization
