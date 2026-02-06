# Fix: Duplicate Table Name Conflict on Re-Upload

## Problem

When a user re-uploads a file whose sanitized name matches an existing table (frozen or active), `CREATE OR REPLACE TABLE` silently overwrites the DuckDB table while `addTable()` creates a **second** store entry with the same name. This leaves orphaned metadata, broken matcher state, and data loss.

**User's scenario:** Had two tables (A active, B frozen). Deleted A → home view. Re-uploaded B's file → DuckDB and store now have conflicting state.

## Solution

Add a conflict detection dialog before `loadFile` runs. When the derived table name matches any existing table, show a dialog:
- **Replace** — delete the old table (full cleanup), import as same name
- **Import as [name]_2** — keep both, new table gets suffixed name
- **Cancel** — abort the upload

Applies uniformly to frozen and active tables.

---

## Architecture

Uses the same state-machine pattern as the existing CSV ingestion wizard (`pendingFile` → show dialog → resolve → `loadFile`).

### Flow

```
File drop/select
  → deriveTableName(filename)
  → check tableStore for name collision
  → IF collision:
      set pendingConflict state → show ConflictDialog
      → user picks Replace / Rename / Cancel
      → Replace: await deleteTable(oldId) → loadFile(file, settings)
      → Rename:  loadFile(file, settings, suffixedName)
      → Cancel:  clear state
  → IF no collision:
      proceed to loadFile as today
```

For CSV files, the conflict check happens in `handleWizardConfirm` (after wizard, before loadFile).
For non-CSV files, the conflict check happens in `handleFileDrop`.

---

## Changes

### 1. `src/hooks/useDuckDB.ts` — Add `overrideTableName` parameter (~5 lines)

`loadFile` currently derives the table name internally (line 270). Add an optional 3rd parameter so the caller can override the name for the "Rename" path.

```typescript
// Before (line 245-246):
const loadFile = useCallback(
  async (file: File, csvSettings?: CSVIngestionSettings) => {

// After:
const loadFile = useCallback(
  async (file: File, csvSettings?: CSVIngestionSettings, overrideTableName?: string) => {
```

```typescript
// Before (line 270):
const tableName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')

// After:
const tableName = overrideTableName || file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
```

### 2. `src/App.tsx` — Conflict detection + dialog state (~80 lines)

**a) Add state for pending conflict:**

```typescript
const [pendingConflict, setPendingConflict] = useState<{
  file: File
  buffer?: ArrayBuffer       // for CSV (pre-read)
  csvSettings?: CSVIngestionSettings
  tableName: string           // derived name that conflicts
  existingTableId: string     // old table's ID
  suggestedName: string       // e.g. "customers_2"
} | null>(null)
```

**b) Extract helper: `deriveTableName(filename)`**

```typescript
function deriveTableName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
}
```

**c) Extract helper: `getUniqueTableName(baseName, tables)`**

```typescript
function getUniqueTableName(baseName: string, tables: { name: string }[]): string {
  const names = new Set(tables.map(t => t.name.toLowerCase()))
  let suffix = 2
  while (names.has(`${baseName}_${suffix}`.toLowerCase())) suffix++
  return `${baseName}_${suffix}`
}
```

**d) Update `handleFileDrop` (non-CSV path):**

Before calling `loadFile(file)`, check for conflict:
```typescript
const derived = deriveTableName(file.name)
const existing = tables.find(t => t.name.toLowerCase() === derived.toLowerCase())
if (existing) {
  setPendingConflict({
    file,
    tableName: derived,
    existingTableId: existing.id,
    suggestedName: getUniqueTableName(derived, tables),
  })
  return  // don't call loadFile yet
}
await loadFile(file)
```

**e) Update `handleWizardConfirm` (CSV path):**

Same conflict check after wizard confirms but before loadFile:
```typescript
const handleWizardConfirm = async (settings: CSVIngestionSettings) => {
  if (!pendingFile) return
  const derived = deriveTableName(pendingFile.file.name)
  const existing = tables.find(t => t.name.toLowerCase() === derived.toLowerCase())
  if (existing) {
    setPendingConflict({
      file: pendingFile.file,
      buffer: pendingFile.buffer,
      csvSettings: settings,
      tableName: derived,
      existingTableId: existing.id,
      suggestedName: getUniqueTableName(derived, tables),
    })
    setPendingFile(null)
    setShowWizard(false)
    return
  }
  await loadFile(pendingFile.file, settings)
  setPendingFile(null)
}
```

**f) Conflict resolution handlers:**

```typescript
const handleConflictReplace = async () => {
  if (!pendingConflict) return
  const { file, csvSettings, existingTableId } = pendingConflict
  setPendingConflict(null)
  // Full cleanup of old table (DuckDB DROP + OPFS + store + timeline)
  await deleteTable(existingTableId)
  await loadFile(file, csvSettings)
}

const handleConflictRename = async () => {
  if (!pendingConflict) return
  const { file, csvSettings, suggestedName } = pendingConflict
  setPendingConflict(null)
  await loadFile(file, csvSettings, suggestedName)
}

const handleConflictCancel = () => {
  setPendingConflict(null)
}
```

**g) Render the conflict dialog (using existing AlertDialog):**

```tsx
<AlertDialog open={!!pendingConflict} onOpenChange={(open) => { if (!open) handleConflictCancel() }}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Table already exists</AlertDialogTitle>
      <AlertDialogDescription>
        A table named "{pendingConflict?.tableName}" already exists.
        What would you like to do?
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <Button variant="outline" onClick={handleConflictRename}>
        Import as "{pendingConflict?.suggestedName}"
      </Button>
      <AlertDialogAction onClick={handleConflictReplace}>
        Replace existing
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

### 3. No changes to `loadCSV`/`loadJSON`/etc.

`CREATE OR REPLACE TABLE` is fine — by the time these run, either the old table was deleted (Replace path) or the name was changed (Rename path).

### 4. No changes to `tableStore`, `matcherStore`, persistence

`deleteTable` in useDuckDB already handles full cleanup (DuckDB DROP, OPFS Parquet, store removal, timeline, audit). Reusing it means all downstream effects (Effect 7 in usePersistence, matcher state clearing, etc.) work automatically.

---

## Files Modified

| File | Change |
|------|--------|
| `src/hooks/useDuckDB.ts` | Add `overrideTableName` param to `loadFile` (~5 lines) |
| `src/App.tsx` | Conflict state, helpers, handlers, dialog (~80 lines) |

---

## Edge Cases

1. **Frozen table conflict:** Works — `deleteTable` handles frozen tables (skips DuckDB DROP since table isn't in memory, cleans up OPFS Parquet).
2. **Active table conflict:** Works — `deleteTable` drops from DuckDB, cleans OPFS, removes from store.
3. **Matcher state referencing old table:** Works — after `deleteTable` removes the old table, matcher queries will fail gracefully (table not in store). The matcher state persistence already has staleness detection.
4. **CSV wizard → conflict:** The wizard closes, conflict dialog opens. CSV settings are preserved in `pendingConflict.csvSettings`.
5. **Multiple uploads of same file:** Each time the dialog appears. If user keeps picking "Rename", they get `name_2`, `name_3`, etc.

## Verification

1. Upload `customers.csv` → table "customers" created
2. Upload `customers.csv` again → conflict dialog appears
3. Click "Replace" → old table removed, new table created with fresh timeline/audit
4. Upload `customers.csv` again → conflict dialog appears
5. Click "Import as customers_2" → both tables coexist
6. Freeze a table by switching to another, then re-upload same file → conflict dialog appears for frozen table too
7. Click "Cancel" → nothing happens, no table created
