import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { downloadAndVerifyCSV } from '../helpers/download-helpers'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Export Tests
 *
 * All tests share a single page context to minimize DuckDB-WASM cold start overhead.
 */
test.describe.serial('Export', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('should export CSV with correct filename', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const result = await downloadAndVerifyCSV(page)
    expect(result.filename).toBe('basic_data_cleaned.csv')
  })

  test('should export data with correct headers', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const result = await downloadAndVerifyCSV(page)

    // Verify header
    expect(result.rows[0]).toEqual(['id', 'name', 'email', 'city'])
  })

  test('should export all data rows', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const result = await downloadAndVerifyCSV(page)

    // Header + 5 data rows
    expect(result.rows.length).toBe(6)

    // Verify first data row
    expect(result.rows[1]).toEqual(['1', 'John Doe', 'john@example.com', 'New York'])
  })

  test('should export transformed data', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS mixed_case')
    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)

    // Apply uppercase transformation (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    const result = await downloadAndVerifyCSV(page)

    // Verify uppercased names
    expect(result.rows[1][1]).toBe('JOHN DOE')
    expect(result.rows[2][1]).toBe('JANE SMITH')
    expect(result.rows[3][1]).toBe('BOB JOHNSON')
  })

  test('should export data after multiple transformations', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Apply trim then uppercase (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    const result = await downloadAndVerifyCSV(page)

    // Verify trimmed and uppercased names
    expect(result.rows[1][1]).toBe('JOHN DOE')
    expect(result.rows[2][1]).toBe('JANE SMITH')
    expect(result.rows[3][1]).toBe('BOB JOHNSON')
  })

  test('should export reduced rows after deduplication', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS with_duplicates')
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 5)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')
    await laundromat.closePanel()

    const result = await downloadAndVerifyCSV(page)

    // Header + 3 unique rows
    expect(result.rows.length).toBe(4)
  })
})
