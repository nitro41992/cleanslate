# Plan: Memory Compaction Feature [IMPLEMENTED]

## Problem
WASM linear memory pages grow but never shrink (browser limitation). With 228k rows using ~200MB, actual RAM is 3.1GB due to WASM heap fragmentation. This is a [known DuckDB-WASM issue](https://github.com/duckdb/duckdb-wasm/issues/1904).

## Industry Best Practice
Per [WebAssembly/design discussions](https://github.com/WebAssembly/design/issues/1300) and DuckDB community: **terminate and reinitialize the WASM worker** is the only reliable way to reclaim memory.

## Solution
Add a "Compact Memory" button to the MemoryIndicator tooltip that:
1. Saves current state to OPFS
2. Terminates the WASM worker (releases all linear memory)
3. Reinitializes DuckDB
4. Reloads tables from Parquet snapshots

---

## Files to Modify

| File | Change |
|------|--------|
| `src/hooks/useDuckDB.ts` | Add `compactMemory()` function (extract from existing `deleteTable` logic) |
| `src/components/common/MemoryIndicator.tsx` | Add "Compact Memory" button in tooltip with confirmation |

---

## Implementation Details

### 1. `src/hooks/useDuckDB.ts`

Extract the memory reclaim logic from `deleteTable()` (lines 386-435) into a standalone function:

```typescript
const compactMemory = useCallback(async () => {
  // 1. Save current app state first
  const { saveAppState } = await import('@/lib/persistence/state-persistence')
  await saveAppState()

  // 2. Set not ready to block UI queries
  setIsReady(false)

  // 3. Terminate worker (releases WASM memory)
  await terminateAndReinitialize()

  // 4. Reinitialize DuckDB
  await initDuckDB()

  // 5. Re-hydrate tables from Parquet
  const { performHydration } = await import('@/hooks/usePersistence')
  await performHydration(true)

  // 6. Ready again
  setIsReady(true)
  refreshMemory()
}, [refreshMemory])

// Return it from hook
return {
  // ... existing returns
  compactMemory,
}
```

### 2. `src/components/common/MemoryIndicator.tsx`

**Changes:**
- Remove `runDiagnostics()` function and onClick console logging
- Click opens a popover/dialog (not hover tooltip)
- Show memory breakdown + "Compact Memory" button in the popover

```typescript
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

// Inside component:
const { isReady, compactMemory } = useDuckDB()
const [isCompacting, setIsCompacting] = useState(false)

const handleCompact = async () => {
  setIsCompacting(true)
  try {
    await compactMemory()
    toast({ title: 'Memory compacted', description: 'Database restarted successfully.' })
  } catch (error) {
    toast({ title: 'Compaction failed', description: error.message, variant: 'destructive' })
  } finally {
    setIsCompacting(false)
  }
}

// Replace Tooltip with Popover, remove onClick={runDiagnostics}
<Popover>
  <PopoverTrigger asChild>
    <div className="...cursor-pointer...">
      {/* memory bar UI */}
    </div>
  </PopoverTrigger>
  <PopoverContent>
    {/* Memory breakdown bars */}
    ...
    {/* Compact button with confirmation */}
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full mt-3" disabled={isCompacting}>
          {isCompacting ? 'Compacting...' : 'Compact Memory'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Compact Memory?</AlertDialogTitle>
          <AlertDialogDescription>
            This will restart the database engine to release unused memory.
            Your data is saved and will reload automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleCompact}>Compact</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </PopoverContent>
</Popover>
```

### 3. Auto-Compact (in `useDuckDB.ts`)

Add automatic compaction when memory exceeds 70% threshold:

```typescript
// Add to refreshMemory callback or create new useEffect in useDuckDB
useEffect(() => {
  if (!isReady) return

  const checkAndAutoCompact = async () => {
    const status = await getMemoryStatus()
    const tables = useTableStore.getState().tables

    // Auto-compact when:
    // - Memory > 70% AND
    // - At least one table exists AND
    // - Not already compacting
    if (status.percentage > 70 && tables.length > 0 && !isCompacting) {
      console.log(`[DuckDB] Memory at ${status.percentage.toFixed(0)}% - auto-compacting`)
      toast({
        title: 'Memory pressure detected',
        description: 'Auto-compacting to free memory...',
      })
      await compactMemory()
    }
  }

  // Check every 30 seconds
  const interval = setInterval(checkAndAutoCompact, 30000)
  return () => clearInterval(interval)
}, [isReady, compactMemory])
```

**Auto-compact triggers:**
- Memory usage > 70%
- At least one table loaded
- Runs check every 30 seconds
- Shows toast notification when triggered

---

## Verification

1. **Manual Compact Test:**
   - Load large CSV (100k+ rows)
   - Perform several transforms to grow WASM heap
   - Check browser Task Manager (~3GB)
   - Click MemoryIndicator → click "Compact Memory" → confirm
   - Verify memory drops in Task Manager
   - Verify data preserved

2. **Auto-Compact Test:**
   - Load multiple large files to push memory > 70%
   - Wait up to 30 seconds
   - Observe toast notification "Memory pressure detected"
   - Verify compaction runs automatically

3. **Console Verification:**
   ```javascript
   // Before: ~2400 MB
   // After:  ~200-400 MB
   performance.memory.usedJSHeapSize / 1024 / 1024
   ```

---

## Implementation Summary

**Completed:**
1. ✅ Added `compactMemory()` function to `useDuckDB.ts` that:
   - Saves current app state to OPFS
   - Sets `isReady` to false to block UI queries
   - Terminates the WASM worker (releases linear memory)
   - Reinitializes DuckDB with fresh worker
   - Re-hydrates tables from Parquet snapshots
   - Refreshes memory indicator

2. ✅ Updated `MemoryIndicator.tsx`:
   - Replaced Tooltip with Dialog (click to open, not hover)
   - Shows memory breakdown with visual bars
   - Added "Compact Memory" button with AlertDialog confirmation
   - Shows compacting state with pulsing animation and "..." text
   - Provides explanatory text about WASM memory behavior

**Deferred (Auto-Compact):**
The auto-compact feature was not implemented to avoid surprising users with unexpected database restarts. The manual compact button provides user control.

---

## Out of Scope (Future)

- Show estimated memory savings before compacting
- Keyboard shortcut for power users
- User preference to enable auto-compact
- Auto-compact with user notification/confirmation
