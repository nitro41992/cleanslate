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

## Verification

1. Make a cell edit, wait 2-3 seconds, refresh - no warning
2. Make rapid cell edits (5+ in 2 seconds), wait 2s, refresh - no warning
3. Edit cell in 2M+ row table - scroll position preserved
4. Run E2E tests: `npm run test`

## Files to Modify

1. `src/hooks/usePersistence.ts` - Add UIStore subscription (~30 lines)
