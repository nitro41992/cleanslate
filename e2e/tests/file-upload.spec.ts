import { test, expect } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('File Upload', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()

    // Wait for DuckDB to initialize
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test('should show dropzone on initial load', async () => {
    await expect(laundromat.dropzone).toBeVisible()
  })

  test('should open ingestion wizard when CSV is uploaded', async () => {
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))

    await wizard.waitForOpen()
    expect(await wizard.getDetectedColumnCount()).toBe(4)
  })

  test('should load file with default settings', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()

    // Wait for table to be loaded in the store
    await inspector.waitForTableLoaded('basic_data', 5)

    // Verify via store
    const tables = await inspector.getTables()
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('basic_data')
    expect(tables[0].rowCount).toBe(5)
  })

  test('should show data grid after file is loaded', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()

    await inspector.waitForTableLoaded('basic_data', 5)
    await expect(laundromat.gridContainer).toBeVisible()
  })

  test('should detect pipe delimiter', async ({ page }) => {
    await laundromat.uploadFile(getFixturePath('pipe-delimited.csv'))
    await wizard.waitForOpen()

    // Verify auto-detected delimiter shows in UI
    await expect(page.locator('text=/Auto.*Pipe/')).toBeVisible()
  })

  test('should allow custom header row selection', async ({ page }) => {
    const inspector = createStoreInspector(page)

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
    expect(tables).toHaveLength(1)
  })
})
