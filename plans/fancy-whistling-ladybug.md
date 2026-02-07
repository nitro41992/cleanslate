# Zero-Resident Architecture: Completion Plan (UI Indicator + E2E Tests)

## Context

The zero-resident architecture (Sprints 1-3, Phases 2-4) is fully implemented across 8 commits on `feat/arrow-ipc-coi-threading`. All engines (diff, transform, combine) work shard-by-shard, instant table switching is operational, and dematerialization is wired into heavy operations.

Two gaps remain:
1. **No visual indicator during background materialization** — When a user switches tables, data appears instantly via shard-backed rendering, but there's no UI feedback that the table is still loading into the engine (1-3s). The edit gating toast only fires if the user *tries* to edit.
2. **Zero E2E test coverage** — The entire shard/manifest/chunk-manager layer is untested at integration level.

---

## Part 1: MaterializationIndicator Component

### What & Why

A small status bar indicator showing "Loading [table_name]..." with a spinner while `tableStore.materializingTables` is non-empty. Disappears when materialization completes (~1-3s).

### Files

| File | Action |
|------|--------|
| `src/components/common/MaterializationIndicator.tsx` | **Create** |
| `src/components/layout/StatusBar.tsx` | **Modify** — add indicator |

### Design

**MaterializationIndicator.tsx:**
- Reads `materializingTables` and `tables` from `useTableStore` (existing: `src/stores/tableStore.ts:599-620`)
- Returns `null` when `materializingTables.size === 0`
- Shows: `<Loader2 spin /> Loading {tableName}...` (or `Loading N tables...` if multiple)
- Color: `text-blue-500 dark:text-blue-400` — blue differentiates from amber (user operations) and green (persistence)
- Add `data-testid="materialization-indicator"` for E2E testability
- No click handler (unlike `OperationIndicator`, materialization has no panel to navigate to)

**StatusBar.tsx** — center section:
```
Before: <PersistenceIndicator />
After:  <MaterializationIndicator /> <PersistenceIndicator />
```

Materialization indicator goes left of persistence indicator since it's transient (1-3s).

### Why not extend OperationIndicator?

`OperationIndicator` reads from `operationStore` which tracks user-initiated operations (clean, recipe, combine, match, standardize). Materialization is a system-level background concern — mixing them conflates two semantic categories and complicates the `OperationSource` type.

---

## Part 2: E2E Test Coverage

### New Helpers in `e2e/helpers/store-inspector.ts`

Three new methods:

**1. `getOPFSSnapshotFiles(snapshotId: string)`**
- Enumerates OPFS files in `cleanslate/snapshots/` matching the snapshot ID prefix
- Returns `Array<{ name: string; size: number }>`
- Implementation: `page.evaluate()` using File System Access API

**2. `getOPFSManifest(snapshotId: string)`**
- Reads and parses `{snapshotId}_manifest.json` from OPFS
- Returns `{ totalRows, shardSize, columns, shards[] } | null`
- Implementation: `page.evaluate()` reading file + `JSON.parse()`

**3. `waitForMaterializationComplete(tableId?: string, timeout?: number)`**
- Polls `tableStore.materializingTables` until empty (or specific table removed)
- Implementation: `page.waitForFunction()` on `__CLEANSLATE_STORES__`
- Default timeout: 30s

### New Test File: `e2e/tests/zero-resident-architecture.spec.ts`

**Test infrastructure**: Tier 3 (fresh browser context per test, 120s timeout).

#### Test 1: Manifest and Shard File Verification

Upload `basic-data.csv` (5 rows) → wait for persistence → enumerate OPFS files.

**Assertions:**
- `basic_data_shard_0.arrow` exists with `size > 8`
- `basic_data_manifest.json` exists with `size > 10`
- No `.tmp` files remain

#### Test 2: Manifest Metadata Integrity

Upload `basic-data.csv` → wait for persistence → read manifest JSON.

**Assertions:**
- `totalRows === 5`
- `shardSize === 50000`
- `columns` contains `id`, `name`, `email`, `city`
- `shards` array has length 1
- `shards[0].rowCount === 5`
- `shards[0].fileName === 'basic_data_shard_0.arrow'`
- `shards[0].byteSize > 0`

#### Test 3: Multi-Table Switching Data Correctness

Upload `fr_e1_jan_sales.csv` (4 rows) and `basic-data.csv` (5 rows). Switch back to jan_sales via table selector dropdown.

**Interaction pattern** (from existing tests):
```typescript
await page.getByTestId('table-selector').click()
await page.getByRole('menuitem', { name: /fr_e1_jan_sales/ }).click()
await inspector.waitForMaterializationComplete()
```

**Assertions:**
- After switching to jan_sales: `SELECT sale_id FROM fr_e1_jan_sales ORDER BY sale_id` returns `['J001', 'J002', 'J003', 'J004']`
- Switch back to basic_data: `SELECT name FROM basic_data ORDER BY _cs_id` returns expected names

#### Test 4: Transform After Table Switch

Upload 2 CSVs → switch to basic_data → apply uppercase on `city` column.

**Assertions:**
- Cities are uppercased: `['NEW YORK', 'LOS ANGELES', 'CHICAGO', 'HOUSTON', 'PHOENIX']`
- Verifies that materialization completes correctly and transforms execute against the correct table

#### Test 5: Diff With Shard-Backed Snapshots

Upload `fr_b2_base.csv` → apply uppercase transform on `name` → open diff view → verify diff summary.

**Assertions:**
- `diffState.summary.modified > 0` (uppercase changed all names)
- This validates the diff engine reads from shard-backed OPFS snapshots correctly

### Existing test helpers reused
- `waitForDuckDBReady()` — `store-inspector.ts:128`
- `waitForTableLoaded()` — `store-inspector.ts:149`
- `waitForPersistenceComplete()` — `store-inspector.ts:847`
- `waitForTransformComplete()` — `store-inspector.ts:182`
- `runQuery()` — `store-inspector.ts:263`
- `LaundromatPage` — `page-objects/laundromat.page.ts`
- `IngestionWizardPage` — `page-objects/ingestion-wizard.page.ts`
- `TransformationPickerPage` — `page-objects/transformation-picker.page.ts`
- `getFixturePath()` — `helpers/file-upload.ts`
- `coolHeap()` — `helpers/cleanup-helpers.ts`

---

## Implementation Sequence

1. **Store inspector helpers** — prerequisite for all tests
2. **MaterializationIndicator component** — `MaterializationIndicator.tsx` + `StatusBar.tsx`
3. **E2E test file** — `zero-resident-architecture.spec.ts` with 5 tests
4. **Verify** — run tests, build, lint

## Verification

```bash
# Run the new E2E tests
npx playwright test "zero-resident-architecture.spec.ts" --timeout=120000 --retries=0 --reporter=line

# TypeScript compilation
npm run build

# Lint
npm run lint

# Visual verification: start dev server, upload CSV, switch tables — observe indicator in status bar
npm run dev
```

## Files Summary

| File | Action |
|------|--------|
| `src/components/common/MaterializationIndicator.tsx` | Create |
| `src/components/layout/StatusBar.tsx` | Modify (add indicator) |
| `e2e/helpers/store-inspector.ts` | Modify (add 3 helpers) |
| `e2e/tests/zero-resident-architecture.spec.ts` | Create |
