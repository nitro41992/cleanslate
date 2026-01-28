/**
 * E2E Tests: Application State Persistence
 *
 * Verifies that tables, timelines, and UI preferences persist across page refreshes.
 * Uses OPFS (Origin Private File System) for persistence.
 *
 * Note: These tests use fresh browser contexts and proper OPFS flushing
 * to ensure reliable persistence testing.
 */

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

// 2 minute timeout for persistence tests (WASM + OPFS operations)
test.setTimeout(120000)

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
 * Clean up OPFS test data (Parquet snapshots)
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

test.describe('Application State Persistence', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
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
    picker = new TransformationPickerPage(page)
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

  test('FR-PERSIST-1: Tables persist across page refresh', async () => {
    // Load a table (basic-data.csv has 5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Verify table exists
    let tables = await inspector.getTableList()
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('basic_data')
    expect(tables[0].rowCount).toBe(5)

    // Flush to OPFS before reload (simple wait pattern from opfs-persistence.spec.ts)
    await inspector.flushToOPFS()

    // Wait for flush to complete with simple poll
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.some(t => t.name === 'basic_data')
    }, { timeout: 10000 }).toBeTruthy()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify table is still visible
    tables = await inspector.getTableList()
    expect(tables[0].name).toBe('basic_data')
    expect(tables[0].rowCount).toBe(5)

    // Verify data is intact (first row is John Doe)
    const rows = await inspector.runQuery('SELECT name FROM basic_data ORDER BY id')
    expect(rows).toHaveLength(5)
    expect(rows[0].name).toBe('John Doe')
  })

  test('FR-PERSIST-2: Timeline persists with undo/redo state', async () => {
    // Load table and apply transform (whitespace-data.csv has 3 rows)
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Apply trim transform using proper API
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Wait for transform to complete (first row becomes 'John Doe' after trim)
    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM whitespace_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('John Doe')

    // Get table ID before refresh
    const tablesBefore = await inspector.getTableList()
    const tableId = tablesBefore[0].id

    // Flush to OPFS before reload
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Wait for flush with simple poll
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.some(t => t.name === 'whitespace_data')
    }, { timeout: 10000 }).toBeTruthy()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT COUNT(*) as cnt FROM whitespace_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(3)

    // Verify can still undo
    const canUndo = await inspector.canUndo(tableId)
    expect(canUndo).toBe(true)

    // Perform undo
    await laundromat.clickUndo()

    // Wait for undo to complete (restores original whitespace)
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT name FROM whitespace_data LIMIT 1')
        return rows[0].name
      } catch {
        return null
      }
    }, { timeout: 10000 }).toBe('  John Doe  ')
  })

  test('FR-PERSIST-3: Multiple tables persist correctly', async () => {
    // Load first table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for wizard to close before loading second file
    await expect(page.getByTestId('ingestion-wizard')).toBeHidden({ timeout: 10000 })

    // Load second table
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Verify both tables exist
    let tables = await inspector.getTableList()
    expect(tables).toHaveLength(2)
    const tableNames = tables.map(t => t.name).sort()
    expect(tableNames).toEqual(['basic_data', 'whitespace_data'])

    // Flush to OPFS before reload
    await inspector.flushToOPFS()

    // Wait for flush with simple poll
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for tables to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify both tables still exist
    tables = await inspector.getTableList()
    const tableNamesAfter = tables.map(t => t.name).sort()
    expect(tableNamesAfter).toEqual(['basic_data', 'whitespace_data'])
  })

  test('FR-PERSIST-4: Active table selection persists', async () => {
    // Load two tables
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await expect(page.getByTestId('ingestion-wizard')).toBeHidden({ timeout: 10000 })

    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Get active table ID (should be whitespace_data as it was loaded last)
    const activeTableBefore = await inspector.getActiveTableId()
    const tablesBefore = await inspector.getTableList()
    const activeTableName = tablesBefore.find(t => t.id === activeTableBefore)?.name
    expect(activeTableName).toBe('whitespace_data')

    // Flush to OPFS before reload
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Wait for flush with simple poll
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for tables to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT COUNT(*) as cnt FROM whitespace_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(3)

    // Verify active table is still whitespace_data
    const activeTableAfter = await inspector.getActiveTableId()
    const tablesAfter = await inspector.getTableList()
    const activeTableNameAfter = tablesAfter.find(t => t.id === activeTableAfter)?.name
    expect(activeTableNameAfter).toBe('whitespace_data')
  })

  // Skip: No UI control to toggle sidebar collapse in current implementation
  test.skip('FR-PERSIST-5: Sidebar collapsed state persists', async () => {
    // Load a table first (sidebar controls only visible when table exists)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Find and click sidebar toggle button (ChevronLeft icon button)
    const toggleButton = page.locator('button').filter({ has: page.locator('svg') }).first()
    await toggleButton.click()

    // Verify sidebar is collapsed via store
    await expect.poll(async () => {
      return await inspector.getUIState('sidebarCollapsed')
    }, { timeout: 5000 }).toBe(true)

    // Flush to OPFS and save app state before reload
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Wait for flush with simple poll
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.some(t => t.name === 'basic_data')
    }, { timeout: 10000 }).toBeTruthy()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify sidebar is still collapsed
    const sidebarCollapsedAfter = await inspector.getUIState('sidebarCollapsed')
    expect(sidebarCollapsedAfter).toBe(true)
  })

  test('FR-PERSIST-6: Timeline position persists after undo', async () => {
    // Load table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const tableId = (await inspector.getTableList())[0].id

    // Apply two transforms using proper API
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('JOHN DOE')

    await picker.addTransformation('Lowercase', { column: 'name' })

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('john doe')

    // Close the Clean panel before clicking undo (panel intercepts button clicks)
    await laundromat.closePanel()
    await expect(page.getByTestId('panel-clean')).toBeHidden({ timeout: 5000 })

    // Undo once (back to uppercase)
    await laundromat.clickUndo()

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('JOHN DOE')

    // Wait for the debounced Parquet save to complete after undo
    // The executor's updateTableStore increments dataVersion, triggering auto-save
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return 'unknown'
        const state = (stores.uiStore as { getState: () => { persistenceStatus: string } }).getState()
        return state.persistenceStatus
      })
    }, { timeout: 15000, message: 'Waiting for persistence to complete after undo' }).toBe('idle')

    // Save app state (timelines, UI prefs)
    await inspector.saveAppState()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify we're still at uppercase state
    const rows = await inspector.runQuery('SELECT name FROM basic_data')
    expect(rows[0].name).toBe('JOHN DOE')

    // Verify we can redo to lowercase
    const canRedo = await inspector.canRedo(tableId)
    expect(canRedo).toBe(true)

    await laundromat.clickRedo()

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('john doe')
  })

  test('FR-PERSIST-7: Fresh start when no saved state', async () => {
    // On a fresh browser context, there should be no tables
    const tables = await inspector.getTableList()
    expect(tables).toHaveLength(0)

    // No errors should be thrown
    const errorLogs: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errorLogs.push(msg.text())
      }
    })

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Should still have no tables
    const tablesAfter = await inspector.getTableList()
    expect(tablesAfter).toHaveLength(0)

    // No critical errors (warnings about "no saved state" are OK)
    const criticalErrors = errorLogs.filter(
      log => !log.includes('No saved state') && !log.includes('NotFoundError')
    )
    expect(criticalErrors).toHaveLength(0)
  })
})
