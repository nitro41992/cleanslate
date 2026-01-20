import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * File Upload Tests
 *
 * All tests share a single page context to minimize DuckDB-WASM cold start overhead.
 * Tests are ordered to run read-only tests first, then tests that modify data.
 */
test.describe.serial('File Upload', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()

    // Wait for DuckDB to initialize
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  // Read-only test - just checks initial state
  test('should show dropzone on initial load', async () => {
    await expect(laundromat.dropzone).toBeVisible()
  })

  // Read-only test - opens wizard but cancels
  test('should open ingestion wizard when CSV is uploaded', async () => {
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))

    await wizard.waitForOpen()
    expect(await wizard.getDetectedColumnCount()).toBe(4)

    await wizard.cancel() // Cancel to reset state
  })

  // Read-only test - checks delimiter detection then cancels
  test('should detect pipe delimiter', async () => {
    await laundromat.uploadFile(getFixturePath('pipe-delimited.csv'))
    await wizard.waitForOpen()

    // Verify auto-detected delimiter shows in UI
    await expect(page.locator('text=/Auto.*Pipe/')).toBeVisible()

    await wizard.cancel() // Cancel to reset state
  })

  // Loads data - tests that need loaded data come after this
  test('should load file with default settings', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()

    // Wait for table to be loaded in the store
    await inspector.waitForTableLoaded('basic_data', 5)

    // Verify via store
    const tables = await inspector.getTables()
    expect(tables.length).toBeGreaterThanOrEqual(1)
    const basicDataTable = tables.find((t) => t.name === 'basic_data')
    expect(basicDataTable).toBeDefined()
    expect(basicDataTable?.rowCount).toBe(5)
  })

  // Uses loaded data from previous test
  test('should show data grid after file is loaded', async () => {
    await expect(laundromat.gridContainer).toBeVisible()
  })

  // Loads different data with custom settings
  test('should allow custom header row selection', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()

    // Verify we can select a different header row
    await wizard.selectHeaderRow(2)

    // Import with row 2 as header
    await wizard.import()

    // Wait for table to be loaded
    await inspector.waitForTableLoaded('basic_data')

    // The data should be loaded (though with wrong headers in this case)
    const tables = await inspector.getTables()
    const basicDataTable = tables.find((t) => t.name === 'basic_data')
    expect(basicDataTable).toBeDefined()
  })
})
