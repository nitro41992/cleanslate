# Fix: Table Deletion Not Persisting After Refresh

## Problem Statement
When a user deletes a table, confirms, and refreshes the page, the table reappears. It takes two delete-confirm-refresh cycles for the table to actually be removed.

## Root Cause Analysis

**Primary Bug: Name Normalization Mismatch**

When saving tables to Parquet, the snapshot name is **normalized** (lowercase, special chars → underscores):
```typescript
// src/hooks/usePersistence.ts:524
const normalizedSnapshotId = table.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
await exportTableToParquet(db, conn, table.name, normalizedSnapshotId, ...)
```

But when deleting, the original table name is passed **without normalization**:
```typescript
// src/hooks/useDuckDB.ts:448
await deleteParquetSnapshot(tableName)  // No normalization!

// src/hooks/usePersistence.ts:1090
await deleteParquetSnapshot(tableName)  // No normalization!
```

**Example:**
- Table "My_Table" saved as → `my_table.parquet`
- Delete attempt → tries to delete `My_Table.parquet` (doesn't exist)
- Refresh → table restored from `my_table.parquet`

**Secondary Bug: No Immediate Save on Delete**

`addTable` triggers immediate `saveAppStateNow()` (line 115), but `removeTable` relies on debounced save (500ms delay). If user refreshes quickly, `app-state.json` still contains the deleted table.

## Fix Implementation

### Files to Modify

1. **`src/hooks/useDuckDB.ts`** (line ~448)
   - Normalize table name before calling `deleteParquetSnapshot()`

2. **`src/hooks/usePersistence.ts`** (line ~1090)
   - Normalize table name before calling `deleteParquetSnapshot()`

3. **`src/stores/tableStore.ts`** (line ~125)
   - Add immediate `saveAppStateNow()` call after delete (matching `addTable` pattern)

### Code Changes

#### 1. `src/hooks/useDuckDB.ts` (~line 445-453)
```typescript
// Before:
await deleteParquetSnapshot(tableName)

// After:
// Normalize table name to match how snapshots are saved (lowercase, underscores)
const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
await deleteParquetSnapshot(normalizedSnapshotId)
```

#### 2. `src/hooks/usePersistence.ts` (~line 1088-1091)
```typescript
const deleteTableSnapshot = useCallback(async (tableName: string) => {
  try {
    // Normalize to match how snapshots are saved
    const normalizedSnapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    await deleteParquetSnapshot(normalizedSnapshotId)
    console.log(`[Persistence] Deleted snapshot for ${tableName}`)
  } catch (err) {
    console.error(`[Persistence] Failed to delete snapshot for ${tableName}:`, err)
  }
}, [])
```

#### 3. `src/stores/tableStore.ts` (~line 125-136)
```typescript
removeTable: (id) => {
  // Clean up timeline snapshots (fire-and-forget)
  cleanupTimelineSnapshots(id).catch((err) => {
    console.warn(`Failed to cleanup timeline snapshots for table ${id}:`, err)
  })

  set((state) => ({
    tables: state.tables.filter((t) => t.id !== id),
    activeTableId: state.activeTableId === id ? null : state.activeTableId,
  }))

  // Immediately trigger save for table deletions (critical operation)
  // Matches addTable pattern - ensures app-state.json is updated before potential refresh
  if (typeof window !== 'undefined' && !isRestoringState) {
    import('@/lib/persistence/state-persistence').then(({ saveAppStateNow }) => {
      saveAppStateNow().catch(err => {
        console.error('[TableStore] Failed to save after removeTable:', err)
      })
    })
  }
},
```

## Test Plan

### Playwright E2E Test
Create `e2e/tests/table-delete-persistence.spec.ts` (Tier 3 - heavy test with fresh browser context):

```typescript
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

// 2 minute timeout for persistence tests (WASM + OPFS operations)
test.setTimeout(120000)

test.describe('FR-PERSIST: Table Delete Persistence', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Fresh context per test for WASM isolation
    context = await browser.newContext()
    page = await context.newPage()
    await page.goto('/')

    // Clean up any previous test data from OPFS
    await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry('cleanslate', { recursive: true })
      } catch { /* Ignore - directory may not exist */ }
    })
    await page.reload()

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try { await context.close() } catch { /* Ignore */ }
  })

  test('deleted table should not reappear after single page refresh', async () => {
    // 1. Upload a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5) // Adjust row count

    // 2. Verify table exists
    const tablesBefore = await inspector.getTableList()
    expect(tablesBefore.map(t => t.name)).toContain('basic_data')

    // 3. Delete the table via UI
    // Find and click the delete button for the table
    await page.getByRole('button', { name: /delete/i }).click()
    await page.getByRole('dialog').getByRole('button', { name: /confirm|delete/i }).click()

    // 4. Wait for deletion to complete
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.map(t => t.name)
    }, { timeout: 10000 }).not.toContain('basic_data')

    // 5. Refresh the page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // 6. CRITICAL ASSERTION: Table should NOT reappear
    const tablesAfterRefresh = await inspector.getTableList()
    expect(tablesAfterRefresh.map(t => t.name)).not.toContain('basic_data')

    // 7. Verify no Parquet file remains in OPFS
    const orphanedFiles = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
        const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
        const files: string[] = []
        for await (const entry of snapshotsDir.values()) {
          if (entry.kind === 'file' && entry.name.includes('basic_data')) {
            files.push(entry.name)
          }
        }
        return files
      } catch { return [] }
    })
    expect(orphanedFiles).toHaveLength(0)
  })
})
```

### Manual Verification
1. Upload a CSV file (creates table)
2. Delete the table via UI (click delete, confirm)
3. Refresh the page
4. Verify table does NOT reappear

## Verification Checklist
- [x] Parquet file is deleted with normalized name
- [x] app-state.json is updated immediately (not waiting for debounce)
- [x] Table does not reappear after single refresh
- [x] Works for table names with special characters and mixed case
- [x] Existing persistence tests still pass

## Implementation Status: COMPLETE

### Changes Made

1. **`src/hooks/useDuckDB.ts`** (lines 446-453)
   - Added name normalization before calling `deleteParquetSnapshot()`
   - Logs both original and normalized names for debugging

2. **`src/hooks/usePersistence.ts`** (lines 1087-1095)
   - Added name normalization in `deleteTableSnapshot` callback
   - Logs both original and normalized names for debugging

3. **`src/stores/tableStore.ts`** (lines 125-144)
   - Added immediate `saveAppStateNow()` call after `removeTable`
   - Matches the pattern used by `addTable` for critical operations

4. **`e2e/tests/table-delete-persistence.spec.ts`** (new file)
   - 3 test cases covering:
     - Single table delete + refresh
     - Delete with normalized names
     - Multi-table scenario (delete one, keep other)
   - All tests pass (16.8s total)

### Test Results

```
Running 3 tests using 1 worker
  3 passed (16.8s)
```

Existing persistence tests also pass:
```
Running 6 tests using 1 worker
  6 passed (41.8s)
```
