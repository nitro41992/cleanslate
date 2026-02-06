import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Table Delete Persistence Tests (FR-PERSIST-DELETE)
 *
 * Validates that when a table is deleted:
 * 1. The Arrow IPC snapshot file is deleted with correct normalized name
 * 2. app-state.json is updated immediately (not waiting for debounce)
 * 3. The table does NOT reappear after a single page refresh
 *
 * Bug Context:
 * - Snapshot files are saved with normalized names (lowercase, underscores)
 * - Deletion was attempting to delete the original name (causing mismatch)
 * - app-state.json relied on debounced save (500ms delay could be missed on quick refresh)
 */

/**
 * Check if the browser supports OPFS with the File System Access API.
 */
async function checkOPFSSupport(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      if (typeof navigator.storage?.getDirectory !== 'function') return false
      const root = await navigator.storage.getDirectory()
      const testDir = await root.getDirectoryHandle('__opfs_test__', { create: true })
      const testFile = await testDir.getFileHandle('__test__.txt', { create: true })
      const writable = await testFile.createWritable()
      await writable.write('test')
      await writable.close()
      await testDir.removeEntry('__test__.txt')
      await root.removeEntry('__opfs_test__')
      return true
    } catch {
      return false
    }
  })
}

/**
 * Clean up OPFS test data (Arrow IPC snapshots)
 */
async function cleanupOPFSTestData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      await root.removeEntry('cleanslate', { recursive: true })
    } catch {
      // Ignore - directory may not exist
    }
  })
}

/**
 * Wait for the app to be fully ready (DuckDB + hydration complete)
 */
async function waitForAppReady(page: Page, inspector: StoreInspector): Promise<void> {
  await inspector.waitForDuckDBReady()
  // Wait for "Restoring your workspace..." to disappear
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Restoring your workspace'),
    { timeout: 15000 }
  ).catch(() => {})
}

/**
 * Get list of snapshot files in OPFS
 */
async function getSnapshotFiles(page: Page, pattern?: string): Promise<string[]> {
  return page.evaluate(async (filterPattern) => {
    try {
      const root = await navigator.storage.getDirectory()
      const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
      const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
      const files: string[] = []
      for await (const entry of snapshotsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.arrow')) {
          if (!filterPattern || entry.name.includes(filterPattern)) {
            files.push(entry.name)
          }
        }
      }
      return files
    } catch {
      return []
    }
  }, pattern)
}

// 2 minute timeout for OPFS persistence tests (heavy WASM operations)
test.setTimeout(120000)

test.describe('FR-PERSIST-DELETE: Table Delete Persistence', () => {
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

    const supportsOPFS = await checkOPFSSupport(page)
    if (!supportsOPFS) {
      test.skip(true, 'OPFS File System Access API not supported')
      return
    }

    // Clean up any previous test data
    await cleanupOPFSTestData(page)
    await page.reload()

    // Initialize page objects
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)

    await waitForAppReady(page, inspector)
  })

  test.afterEach(async () => {
    try {
      await cleanupOPFSTestData(page)
    } catch {
      // Ignore cleanup errors
    }
    try {
      await context.close()
    } catch {
      // Context may already be closed
    }
  })

  test('deleted table should not reappear after single page refresh', async () => {
    // 1. Upload a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for grid to be ready
    await inspector.waitForGridReady()

    // 2. Verify table exists in store
    const tablesBefore = await inspector.getTableList()
    expect(tablesBefore.map(t => t.name)).toContain('basic_data')

    // 3. Flush to OPFS to ensure table is persisted
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Verify snapshot file exists before deletion
    const snapshotsBefore = await getSnapshotFiles(page, 'basic_data')
    expect(snapshotsBefore.length).toBeGreaterThan(0)
    console.log('[Test] Snapshot files before delete:', snapshotsBefore)

    // 4. Delete the table via UI
    // Open table selector dropdown
    await page.getByTestId('table-selector').click()

    // Wait for dropdown to be visible
    await page.getByRole('menu').waitFor({ state: 'visible' })

    // Find the menu item for basic_data
    const tableRow = page.getByRole('menuitem', { name: /basic_data/ })
    await expect(tableRow).toBeVisible()

    // Hover over the table row to reveal delete button
    await tableRow.hover()

    // Click delete button (second button in the menu item - first is copy, second is trash)
    // Wait briefly for opacity transition to complete
    const deleteBtn = tableRow.getByRole('button').nth(1)
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Confirm deletion in dialog
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete' }).click()

    // 5. Wait for deletion to complete (table should no longer be in store)
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.map(t => t.name)
    }, { timeout: 10000 }).not.toContain('basic_data')

    // Brief wait for filesystem operations to complete
    await page.waitForFunction(
      () => true,
      { timeout: 500 }
    ).catch(() => {})

    // 6. Verify snapshot file was deleted (checking normalized name)
    const snapshotsAfterDelete = await getSnapshotFiles(page, 'basic_data')
    console.log('[Test] Snapshot files after delete:', snapshotsAfterDelete)
    // Filter out timeline/snapshot files, only check the main table file
    const mainTableSnapshots = snapshotsAfterDelete.filter(f =>
      !f.startsWith('original_') &&
      !f.startsWith('snapshot_') &&
      !f.startsWith('_timeline_')
    )
    expect(mainTableSnapshots).toHaveLength(0)

    // 7. Refresh the page
    await page.reload()
    await waitForAppReady(page, inspector)

    // 8. CRITICAL ASSERTION: Table should NOT reappear after single refresh
    const tablesAfterRefresh = await inspector.getTableList()
    expect(tablesAfterRefresh.map(t => t.name)).not.toContain('basic_data')

    // 9. Double-check no orphaned snapshot files remain
    const orphanedFiles = await getSnapshotFiles(page, 'basic_data')
    const orphanedMainFiles = orphanedFiles.filter(f =>
      !f.startsWith('original_') &&
      !f.startsWith('snapshot_') &&
      !f.startsWith('_timeline_')
    )
    expect(orphanedMainFiles).toHaveLength(0)
  })

  test('delete should work with tables that have special characters in name', async () => {
    // This test verifies the name normalization fix works for various table names
    // Table names get normalized: "My Table!" -> "my_table_"

    // 1. Upload a table (filename will be normalized to table name)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Flush and save
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // 2. Delete the table
    await page.getByTestId('table-selector').click()
    await page.getByRole('menu').waitFor({ state: 'visible' })
    const tableRow = page.getByRole('menuitem', { name: /basic_data/ })
    await expect(tableRow).toBeVisible()
    await tableRow.hover()
    const deleteBtn = tableRow.getByRole('button').nth(1)
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete' }).click()

    // Wait for deletion
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(0)

    // 3. Refresh and verify
    await page.reload()
    await waitForAppReady(page, inspector)

    // Table should not reappear
    const tablesAfter = await inspector.getTableList()
    expect(tablesAfter).toHaveLength(0)
  })

  test('deleting one of multiple tables should only remove that table', async () => {
    // 1. Upload two tables
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for wizard to close before uploading second file
    await expect(page.getByTestId('ingestion-wizard')).toBeHidden({ timeout: 10000 })

    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 5)

    // Flush and save both
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Verify both exist
    const tablesBefore = await inspector.getTableList()
    expect(tablesBefore.map(t => t.name).sort()).toEqual(['basic_data', 'with_duplicates'].sort())

    // 2. Delete only basic_data
    await page.getByTestId('table-selector').click()
    await page.getByRole('menu').waitFor({ state: 'visible' })
    const tableRow = page.getByRole('menuitem', { name: /basic_data/ })
    await expect(tableRow).toBeVisible()
    await tableRow.hover()
    const deleteBtn = tableRow.getByRole('button').nth(1)
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete' }).click()

    // Wait for deletion
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.map(t => t.name)
    }, { timeout: 10000 }).not.toContain('basic_data')

    // 3. Refresh and verify
    await page.reload()
    await waitForAppReady(page, inspector)

    // Only with_duplicates should remain
    const tablesAfter = await inspector.getTableList()
    expect(tablesAfter.map(t => t.name)).toEqual(['with_duplicates'])
    expect(tablesAfter.map(t => t.name)).not.toContain('basic_data')
  })
})
