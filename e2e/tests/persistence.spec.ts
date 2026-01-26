/**
 * E2E Tests: Application State Persistence
 *
 * Verifies that tables, timelines, and UI preferences persist across page refreshes
 */

import { test, expect, type Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Application State Persistence', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    inspector = createStoreInspector(page)

    await laundromat.goto()
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await page.close()
  })

  test('FR-PERSIST-1: Tables persist across page refresh', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 3)

    // Verify table exists
    let tables = await inspector.getTableList()
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('basic_data')
    expect(tables[0].rowCount).toBe(3)

    // Refresh page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Wait for restoration to complete
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(1)

    // Verify table is still visible
    tables = await inspector.getTableList()
    expect(tables[0].name).toBe('basic_data')
    expect(tables[0].rowCount).toBe(3)

    // Verify data is intact
    const rows = await inspector.runQuery('SELECT * FROM basic_data ORDER BY id')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ id: 1, name: 'Alice' })
  })

  test('FR-PERSIST-2: Timeline persists with undo/redo state', async () => {
    // Load table and apply transform
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Apply trim transform
    await laundromat.openTransformationPicker()
    await picker.selectTransform('Trim Whitespace')
    await picker.selectColumn('name')
    await picker.apply()

    // Wait for transform to complete
    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM whitespace_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('Alice')

    // Verify transform applied
    const beforeRefresh = await inspector.runQuery('SELECT name FROM whitespace_data')
    expect(beforeRefresh[0].name).toBe('Alice')

    // Get table ID before refresh
    const tablesBefore = await inspector.getTableList()
    const tableId = tablesBefore[0].id

    // Refresh page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Wait for restoration
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(1)

    // Verify can still undo
    const canUndo = await inspector.canUndo(tableId)
    expect(canUndo).toBe(true)

    // Perform undo
    await laundromat.clickUndo()

    // Wait for undo to complete
    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM whitespace_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('  Alice  ')

    // Verify undo restored original whitespace
    const afterUndo = await inspector.runQuery('SELECT name FROM whitespace_data')
    expect(afterUndo[0].name).toBe('  Alice  ')
  })

  test('FR-PERSIST-3: Multiple tables persist correctly', async () => {
    // Load first table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 3)

    // Load second table
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Verify both tables exist
    let tables = await inspector.getTableList()
    expect(tables).toHaveLength(2)
    const tableNames = tables.map(t => t.name).sort()
    expect(tableNames).toEqual(['basic_data', 'whitespace_data'])

    // Refresh page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Wait for restoration
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(2)

    // Verify both tables still exist
    tables = await inspector.getTableList()
    const tableNamesAfter = tables.map(t => t.name).sort()
    expect(tableNamesAfter).toEqual(['basic_data', 'whitespace_data'])
  })

  test('FR-PERSIST-4: Active table selection persists', async () => {
    // Load two tables
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 3)

    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Get active table ID (should be whitespace_data as it was loaded last)
    const activeTableBefore = await inspector.getActiveTableId()
    const tablesBefore = await inspector.getTableList()
    const activeTableName = tablesBefore.find(t => t.id === activeTableBefore)?.name
    expect(activeTableName).toBe('whitespace_data')

    // Refresh page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Wait for restoration
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(2)

    // Verify active table is still whitespace_data
    const activeTableAfter = await inspector.getActiveTableId()
    const tablesAfter = await inspector.getTableList()
    const activeTableNameAfter = tablesAfter.find(t => t.id === activeTableAfter)?.name
    expect(activeTableNameAfter).toBe('whitespace_data')
  })

  test('FR-PERSIST-5: Sidebar collapsed state persists', async () => {
    // Load a table first (sidebar controls only visible when table exists)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 3)

    // Find and click sidebar toggle button (ChevronLeft icon button)
    const toggleButton = page.locator('button').filter({ has: page.locator('svg') }).first()
    await toggleButton.click()

    // Verify sidebar is collapsed via store
    await expect.poll(async () => {
      return await inspector.getUIState('sidebarCollapsed')
    }, { timeout: 5000 }).toBe(true)

    // Refresh page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Wait for restoration
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(1)

    // Verify sidebar is still collapsed
    const sidebarCollapsedAfter = await inspector.getUIState('sidebarCollapsed')
    expect(sidebarCollapsedAfter).toBe(true)
  })

  test('FR-PERSIST-6: Timeline position persists after undo', async () => {
    // Load table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 3)

    const tableId = (await inspector.getTableList())[0].id

    // Apply two transforms
    await laundromat.openTransformationPicker()
    await picker.selectTransform('Uppercase')
    await picker.selectColumn('name')
    await picker.apply()

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('ALICE')

    await laundromat.openTransformationPicker()
    await picker.selectTransform('Lowercase')
    await picker.selectColumn('name')
    await picker.apply()

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('alice')

    // Undo once (back to uppercase)
    await laundromat.clickUndo()

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('ALICE')

    // Refresh page
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Wait for restoration
    await expect.poll(async () => {
      const tables = await inspector.getTableList()
      return tables.length
    }, { timeout: 10000 }).toBe(1)

    // Verify we're still at uppercase state
    const rows = await inspector.runQuery('SELECT name FROM basic_data')
    expect(rows[0].name).toBe('ALICE')

    // Verify we can redo to lowercase
    const canRedo = await inspector.canRedo(tableId)
    expect(canRedo).toBe(true)

    await laundromat.clickRedo()

    await expect.poll(async () => {
      const rows = await inspector.runQuery('SELECT name FROM basic_data LIMIT 1')
      return rows[0].name
    }, { timeout: 10000 }).toBe('alice')
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
    await inspector.waitForDuckDBReady()

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
