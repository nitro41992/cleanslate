# Plan: Complete Parquet-based OPFS Persistence

## Problem Summary
DuckDB-WASM bug #2096 prevents native OPFS persistence (DataCloneError with COI headers, read-only without). Workaround: in-memory DuckDB + Parquet files in OPFS.

## Already Completed
- `src/hooks/usePersistence.ts` - Parquet-based hydration hook
- `src/lib/duckdb/browser-detection.ts` - Disabled native OPFS
- `vite.config.ts` - Removed COI headers

---

## Tasks

### 1. Fix App.tsx Build Errors
**File:** `src/App.tsx`

Remove the "Restore Data Dialog" (lines 357-380) that references undefined variables:
- `showRestoreDialog` - never defined in App.tsx
- `setShowRestoreDialog` - never defined
- `loadFromStorage()` - doesn't exist in new API

Keep: `const { isRestoring } = usePersistence()` (line 91 - already correct)

### 2. Fix AppShell.tsx Build Errors
**File:** `src/components/layout/AppShell.tsx`

**A. Replace old API (lines 96-102):**
```typescript
// DELETE this:
const {
  isAvailable: isStorageAvailable,
  isLoading: isStorageLoading,
  saveToStorage,
  loadFromStorage,
  autoRestore,
} = usePersistence()

// REPLACE with:
const { saveAllTables, isRestoring } = usePersistence()
```

**B. Remove `showRestoreDialog` state (line 104):**
```typescript
// DELETE:
const [showRestoreDialog, setShowRestoreDialog] = useState(false)
```

**C. Remove `autoRestore` useEffect (lines 155-163):**
```typescript
// DELETE entire block - hydration is automatic now
useEffect(() => {
  const checkForSavedData = async () => {
    const hasSavedData = await autoRestore()
    ...
  }
  checkForSavedData()
}, [autoRestore])
```

**D. Update Storage Actions section (lines 338-380):**
- Change `isStorageAvailable` → `true` (OPFS always available)
- Change `isStorageLoading` → `isRestoring`
- Change `saveToStorage` → `saveAllTables`
- Remove the "Load" button (loading is automatic on mount)

**E. Remove Restore Dialog (lines 415-436):**
```typescript
// DELETE entire AlertDialog block - not needed with auto-hydration
<AlertDialog open={showRestoreDialog} ...>
```

### 3. Add Auto-Save and saveAllTables to usePersistence Hook
**File:** `src/hooks/usePersistence.ts`

**A. Add `saveAllTables` function (before the return statement):**
```typescript
// Save all tables (for manual "Save All" button in sidebar)
const saveAllTables = useCallback(async () => {
  const currentTables = useTableStore.getState().tables
  console.log(`[Persistence] Saving all ${currentTables.length} tables...`)

  for (const table of currentTables) {
    await saveTable(table.name)
  }

  toast.success(`Saved ${currentTables.length} table(s)`)
}, [saveTable])
```

**B. Add auto-save useEffect (after hydration useEffect):**

⚠️ **CRITICAL**: Do NOT include `tables` in dependency array — this causes the timer to reset on every edit, preventing saves while user is active.

```typescript
// Auto-save every 30 seconds
// NOTE: Read tables from store inside interval to avoid dependency on tables array
useEffect(() => {
  if (isRestoring) return

  const interval = setInterval(() => {
    const currentTables = useTableStore.getState().tables
    if (currentTables.length === 0) return

    currentTables.forEach(table => {
      saveTable(table.name).catch(console.error)
    })
  }, 30000)

  return () => clearInterval(interval)
}, [isRestoring, saveTable])  // NO tables in deps!
```

**C. Update return statement:**
```typescript
return {
  isRestoring,
  saveTable,
  saveAllTables,        // ADD THIS
  deleteTableSnapshot,
  clearStorage,
}
```

### 4. Add Loading Screen to App.tsx
**File:** `src/App.tsx`

Add early return after usePersistence call:
```typescript
const { isRestoring } = usePersistence()

if (isRestoring) {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        <p className="text-muted-foreground">Restoring your workspace...</p>
      </div>
    </div>
  )
}
```

⚠️ **FAIL-SAFE VERIFICATION**: Confirm that `hydrate()` in usePersistence.ts has `finally { setIsRestoring(false) }` — this prevents users from being trapped on the loading screen if hydration errors out. (Already present in current implementation.)

---

## Files to Modify

| File | Lines | Action |
|------|-------|--------|
| `src/App.tsx` | 357-380 | Remove Restore Dialog |
| `src/App.tsx` | after line 91 | Add loading screen |
| `src/components/layout/AppShell.tsx` | 96-102 | Replace old API destructuring |
| `src/components/layout/AppShell.tsx` | 104 | Remove showRestoreDialog state |
| `src/components/layout/AppShell.tsx` | 155-163 | Remove autoRestore useEffect |
| `src/components/layout/AppShell.tsx` | 338-380 | Update storage buttons |
| `src/components/layout/AppShell.tsx` | 415-436 | Remove AlertDialog |
| `src/hooks/usePersistence.ts` | after hydration | Add saveAllTables + auto-save useEffect |

---

## Verification

1. **Build Check:** `npm run build` - should complete with no errors
2. **Manual Test:**
   - `npm run dev`
   - Upload a CSV file
   - Make edits (e.g., delete a row, edit a cell)
   - Wait 30 seconds (watch console for "[Persistence] Saving...")
   - Refresh browser
   - Verify data restored with edits intact
3. **Console Logs to Watch:**
   - `[Persistence] Starting hydration...`
   - `[Persistence] Found X tables to restore`
   - `[Persistence] Restored tableName (N rows)`
   - `[Persistence] Saving tableName...`
