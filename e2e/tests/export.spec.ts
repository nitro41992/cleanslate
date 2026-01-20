import { test, expect } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { downloadAndVerifyCSV } from '../helpers/download-helpers'
import { createStoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Export', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()

    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test('should export CSV with correct filename', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const result = await downloadAndVerifyCSV(page)
    expect(result.filename).toBe('basic_data_cleaned.csv')
  })

  test('should export data with correct headers', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const result = await downloadAndVerifyCSV(page)

    // Verify header
    expect(result.rows[0]).toEqual(['id', 'name', 'email', 'city'])
  })

  test('should export all data rows', async ({ page }) => {
    const inspector = createStoreInspector(page)

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

  test('should export transformed data', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)

    // Apply uppercase transformation
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.clickRunRecipe()

    const result = await downloadAndVerifyCSV(page)

    // Verify uppercased names
    expect(result.rows[1][1]).toBe('JOHN DOE')
    expect(result.rows[2][1]).toBe('JANE SMITH')
    expect(result.rows[3][1]).toBe('BOB JOHNSON')
  })

  test('should export data after multiple transformations', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Apply trim then uppercase
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim', { column: 'name' })

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const result = await downloadAndVerifyCSV(page)

    // Verify trimmed and uppercased names
    expect(result.rows[1][1]).toBe('JOHN DOE')
    expect(result.rows[2][1]).toBe('JANE SMITH')
    expect(result.rows[3][1]).toBe('BOB JOHNSON')
  })

  test('should export reduced rows after deduplication', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')
    await laundromat.clickRunRecipe()

    const result = await downloadAndVerifyCSV(page)

    // Header + 3 unique rows
    expect(result.rows.length).toBe(4)
  })
})
