# Plan: Unify Column/Table Selectors with Searchable Pickers

## Summary

Replace all `Select` dropdowns for tables and columns across the app with searchable cmdk-style pickers, matching the `ColumnCombobox` pattern already used in CleanPanel.

## Approach

Create a generic `SearchableCombobox` base component, then provide specialized wrappers:
- `TableCombobox` - for table selection (shows row counts)
- `ColumnCombobox` - already exists, will refactor to use base
- `AlgorithmCombobox` - for clustering algorithm selection (optional, only 3 items)

## Files to Modify

### Core Component
- `src/components/ui/combobox.tsx` - Add `SearchableCombobox` base and `TableCombobox`

### Consumer Components (12 selectors across 6 files)

| File | Selectors to Replace |
|------|---------------------|
| `src/features/matcher/components/MatchConfigPanel.tsx` | Table (1), Column (1) |
| `src/features/combiner/components/JoinPanel.tsx` | Left Table (1), Right Table (1), Key Column (1) |
| `src/features/combiner/components/StackPanel.tsx` | Table (1) |
| `src/components/panels/ScrubPanel.tsx` | Table (1) |
| `src/components/diff/DiffConfigPanel.tsx` | Table A (1), Table B (1) |
| `src/features/standardizer/components/StandardizeConfigPanel.tsx` | Table (1), Column (1), Algorithm (1) |

### Lower Priority (grouped options, deferred)
- `src/features/scrubber/components/ColumnRuleTable.tsx` - Obfuscation method selector

## Implementation Steps

### 1. Create SearchableCombobox Base
Add to `combobox.tsx`:
```typescript
interface SearchableComboboxProps {
  items: { value: string; label: string; description?: string }[]
  value: string | null
  onValueChange: (value: string | null) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  disabled?: boolean
  testId?: string
}
```

### 2. Create TableCombobox
```typescript
interface TableComboboxProps {
  tables: TableInfo[]
  value: string | null
  onValueChange: (tableId: string | null) => void
  placeholder?: string
  disabled?: boolean
  excludeIds?: string[]  // For filtering already-selected tables
  testId?: string
}
```
Display format: `{table.name} ({rowCount.toLocaleString()} rows)`

### 3. Refactor Existing ColumnCombobox
Make it use `SearchableCombobox` internally for consistency.

### 4. Update Consumer Files
For each file, replace `Select` components with appropriate combobox:
- Import `TableCombobox` and/or `ColumnCombobox`
- Remove `Select` imports
- Replace JSX, preserving existing handlers

Example transformation in MatchConfigPanel:
```diff
-<Select value={tableId || ''} onValueChange={handleTableSelect}>
-  <SelectTrigger>
-    <SelectValue placeholder="Select table" />
-  </SelectTrigger>
-  <SelectContent>
-    {tables.map((t) => (
-      <SelectItem key={t.id} value={t.id}>
-        {t.name} ({t.rowCount.toLocaleString()} rows)
-      </SelectItem>
-    ))}
-  </SelectContent>
-</Select>
+<TableCombobox
+  tables={tables}
+  value={tableId}
+  onValueChange={handleTableSelect}
+  placeholder="Select table"
+  testId="match-table-selector"
+/>
```

## Verification

1. **Visual**: Each selector opens as popover with search input
2. **Search**: Type to filter items in real-time
3. **Keyboard**: Arrow keys navigate, Enter selects, Escape closes
4. **Selection**: Selected item shows checkmark, closes popover on select
5. **E2E Tests**: Run existing tests to catch regressions

```bash
npm run dev          # Manual verification
npm run test         # E2E test suite
```

## Test IDs to Add

| Component | testId |
|-----------|--------|
| Match table | `match-table-selector` |
| Match column | `match-column-selector` |
| Join left table | `join-left-table-selector` |
| Join right table | `join-right-table-selector` |
| Join key column | `join-key-column-selector` |
| Stack table | `stack-table-selector` |
| Scrub table | `scrub-table-selector` |
| Diff table A | `diff-table-a-selector` |
| Diff table B | `diff-table-b-selector` |
| Standardize table | `standardize-table-selector` |
| Standardize column | `standardize-column-selector` |
| Standardize algorithm | `standardize-algorithm-selector` |
