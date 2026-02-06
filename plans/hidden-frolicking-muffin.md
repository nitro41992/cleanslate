# Plan: Import Progress Indicator for Active Table View

## Context

When a table is already loaded and the user imports a new file, there is **zero visual feedback** during the import process. The `loadFile()` function in `useDuckDB.ts` progresses through stages ("Reading file...", "Creating table...", "Creating snapshot...", "Rendering grid...") tracked via `loadingMessage` in `uiStore`. However, `loadingMessage` is only consumed by `EmptyStateLanding` — which is NOT rendered when a table is active. For large files (e.g., 1M rows), this means several seconds of silence.

## Approach: Grid Overlay + StatusBar Indicator

Two-pronged visual feedback:

1. **Grid overlay** — Semi-transparent overlay on the data grid showing file name + stage message. Uses existing context-switching overlay pattern but with transparency to communicate "your data is safe, new table loading."

2. **StatusBar indicator** — Small spinner + file name in the StatusBar's right section (next to `OperationIndicator`), visible even when a feature panel covers the grid.

### State Change: `importingFileName` in uiStore

Track the file being imported in global state so both the grid overlay and StatusBar can consume it without prop drilling.

## Files to Modify

### 1. `src/stores/uiStore.ts` — Add `importingFileName` state
- Add `importingFileName: string | null` to `UIState` interface (line ~68)
- Add `setImportingFileName` action to `UIActions` interface (line ~114)
- Add initial value `importingFileName: null` (line ~175)
- Add action implementation (line ~351)

### 2. `src/hooks/useDuckDB.ts` — Set/clear importing state in `loadFile()`
- Get `setImportingFileName` from `useUIStore` (near existing `setLoadingMessage` reference)
- At start of `loadFile()`, after `setIsLoading(true)` (line 247): `setImportingFileName(file.name)`
- In `finally` block (line 364): `setImportingFileName(null)`
- Add to `useCallback` dependency array (line 369)

### 3. `src/App.tsx` — Grid import overlay
- Add `useUIStore` selectors for `importingFileName` and `loadingMessage`
- Inside `CardContent` (line 543), after the context-switching overlay (line 556-564), add:

```tsx
{importingFileName && (
  <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-40">
    <div className="flex flex-col items-center gap-3">
      <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      <div className="text-center">
        <p className="text-sm font-medium">Importing {importingFileName}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {loadingMessage || 'Processing...'}
        </p>
      </div>
    </div>
  </div>
)}
```

### 4. `src/components/layout/StatusBar.tsx` — Import indicator in footer
- Import `useUIStore` and `Loader2`
- In the right section (line 30-32), before `<OperationIndicator />`, conditionally render:

```tsx
{importingFileName && (
  <div className="flex items-center gap-1.5 text-xs text-primary">
    <Loader2 className="w-3 h-3 animate-spin" />
    <span className="truncate max-w-[180px]">Importing {importingFileName}</span>
  </div>
)}
```

## Design Notes

- **Semi-transparent overlay** (`bg-background/80 backdrop-blur-sm`): The existing table grid remains faintly visible, communicating "your data is safe." Different from the context-switching overlay which is fully opaque (because data is being swapped).
- **z-40 for import overlay** vs z-50 for context-switching overlay: These are mutually exclusive states, but z-40 gives safe layering.
- **`importingFileName` vs `isLoading`**: Using `importingFileName` as the trigger is more explicit than `isLoading` (which is local hook state). `importingFileName !== null` clearly means "an import is in progress."
- **No changes to `AppShell.tsx`**: It is dead code (never imported). The table list lives in `TableSelector` dropdown.

## Verification

1. Load a table, then import a second file (CSV, Parquet, or JSON)
2. Verify the grid shows a semi-transparent overlay with "Importing {filename}" and stage messages
3. Verify the StatusBar shows a spinner with the filename
4. Verify both indicators disappear when import completes
5. Verify error case: if import fails, indicators still clear (via `finally` block)
6. Verify IngestionWizard (CSV) still works — the overlay appears after wizard closes, not during wizard configuration
7. Run `npm run build` to ensure no TypeScript errors
