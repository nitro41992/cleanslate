# Plan: Memory Compaction Feature

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

Add button to tooltip content (after the "Click for diagnostics" hint):

```typescript
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

// In tooltipContent, add after "Click for diagnostics":
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="outline" size="sm" className="w-full mt-2" disabled={isCompacting}>
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
```

---

## Verification

1. **Manual Test:**
   - Load large CSV (100k+ rows)
   - Perform several transforms to grow WASM heap
   - Check browser Task Manager for memory usage (note: ~3GB)
   - Hover MemoryIndicator → click "Compact Memory" → confirm
   - Verify memory drops significantly in Task Manager
   - Verify all data is preserved and editable

2. **Console Verification:**
   ```javascript
   // Before compact:
   performance.memory.usedJSHeapSize / 1024 / 1024  // ~2400 MB

   // After compact:
   performance.memory.usedJSHeapSize / 1024 / 1024  // Should drop to ~200-400 MB
   ```

---

## Out of Scope (Future)

- Auto-compact when memory exceeds 70%
- Show estimated memory savings before compacting
- Keyboard shortcut for power users
