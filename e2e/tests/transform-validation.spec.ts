import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Transform Validation Tests
 *
 * Tests for live semantic validation that blocks no-op transforms.
 * Validates that the Apply button is disabled and appropriate messages shown
 * when a transform would have no effect on the data.
 */

test.describe('Transform Validation: No-Op Detection', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test('Remove Duplicates: shows validation message when no duplicates exist', async () => {
    // Load data with unique rows
    await inspector.runQuery('DROP TABLE IF EXISTS validation_unique_rows')
    await laundromat.uploadFile(getFixturePath('validation-unique-rows.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('validation_unique_rows', 4)

    // Open clean panel and select Remove Duplicates
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Remove Duplicates')

    // Wait for validation to complete (debounced)
    await expect(page.getByTestId('validation-message')).toBeVisible({ timeout: 5000 })

    // Check validation message shows no duplicates
    const message = page.getByTestId('validation-message')
    await expect(message).toHaveAttribute('data-status', 'no_op')
    await expect(message).toContainText('No duplicates found')

    // Apply button should be disabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeDisabled()
  })

  test('Remove Duplicates: allows apply when duplicates exist', async () => {
    // Load data with duplicates
    await inspector.runQuery('DROP TABLE IF EXISTS with_duplicates')
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 5)

    // Open clean panel and select Remove Duplicates
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Remove Duplicates')

    // Wait for validation to complete - no validation message should appear for valid
    // Give time for debounce
    await page.waitForTimeout(500)

    // Validation message should NOT be visible (status is valid)
    const message = page.getByTestId('validation-message')
    await expect(message).not.toBeVisible()

    // Apply button should be enabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeEnabled()
  })

  test('Fill Down: shows validation message when no empty values exist', async () => {
    test.skip(true, 'Transform is feature-flagged off (HIDDEN_TRANSFORMS)');
    // Load data with no empty values
    await inspector.runQuery('DROP TABLE IF EXISTS validation_no_empty')
    await laundromat.uploadFile(getFixturePath('validation-no-empty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('validation_no_empty', 3)

    // Open clean panel and select Fill Down
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Fill Down')

    // Select a column
    await picker.selectColumn('category')

    // Wait for validation to complete
    await expect(page.getByTestId('validation-message')).toBeVisible({ timeout: 5000 })

    // Check validation message shows no empty values
    const message = page.getByTestId('validation-message')
    await expect(message).toHaveAttribute('data-status', 'no_op')
    await expect(message).toContainText('No empty values to fill')

    // Apply button should be disabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeDisabled()
  })

  test('Fill Down: allows apply when empty values exist', async () => {
    test.skip(true, 'Transform is feature-flagged off (HIDDEN_TRANSFORMS)');
    // Load data with empty values using the empty-values fixture
    await inspector.runQuery('DROP TABLE IF EXISTS empty_values')
    await laundromat.uploadFile(getFixturePath('empty-values.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('empty_values', 5)

    // Open clean panel and select Fill Down
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Fill Down')

    // Select a column with empty values
    // The empty-values.csv file has blanks in 'name' column
    await picker.selectColumn('name')

    // Wait for validation (debounce)
    await expect.poll(async () => {
      const btn = page.getByTestId('apply-transformation-btn')
      return await btn.isEnabled()
    }, { timeout: 5000 }).toBe(true)

    // Apply button should be enabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeEnabled()
  })

  test('Standardize Date: shows validation message when no parseable dates', async () => {
    // Load data with no dates
    await inspector.runQuery('DROP TABLE IF EXISTS validation_non_dates')
    await laundromat.uploadFile(getFixturePath('validation-non-dates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('validation_non_dates', 3)

    // Open clean panel and select Standardize Date
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Standardize Date')

    // Select a column with no dates
    await picker.selectColumn('code')

    // Wait for validation to complete
    await expect(page.getByTestId('validation-message')).toBeVisible({ timeout: 5000 })

    // Check validation message shows no parseable dates
    const message = page.getByTestId('validation-message')
    await expect(message).toHaveAttribute('data-status', 'invalid')
    await expect(message).toContainText('No parseable dates')

    // Apply button should be disabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeDisabled()
  })

  test('Standardize Date: allows apply when dates can be parsed', async () => {
    // Load data with dates
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_dates_split')
    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)

    // Open clean panel and select Standardize Date
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Standardize Date')

    // Select a column with dates
    await picker.selectColumn('birth_date')

    // Wait for validation (debounce)
    await page.waitForTimeout(500)

    // No validation message should appear (valid)
    const message = page.getByTestId('validation-message')
    await expect(message).not.toBeVisible()

    // Apply button should be enabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeEnabled()
  })

  test('Replace: shows validation message when no matching values', async () => {
    // Load basic data
    await inspector.runQuery('DROP TABLE IF EXISTS validation_unique_rows')
    await laundromat.uploadFile(getFixturePath('validation-unique-rows.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('validation_unique_rows', 4)

    // Open clean panel and select Find & Replace
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Find & Replace')

    // Select column and enter non-existent search value
    await picker.selectColumn('name')
    await picker.fillParam('Find', 'NONEXISTENT_VALUE_XYZ')

    // Wait for validation to complete
    await expect(page.getByTestId('validation-message')).toBeVisible({ timeout: 5000 })

    // Check validation message shows no matches
    const message = page.getByTestId('validation-message')
    await expect(message).toHaveAttribute('data-status', 'no_op')
    await expect(message).toContainText('No rows contain')

    // Apply button should be disabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeDisabled()
  })

  test('Replace: allows apply when matching values exist', async () => {
    // Load basic data
    await inspector.runQuery('DROP TABLE IF EXISTS validation_unique_rows')
    await laundromat.uploadFile(getFixturePath('validation-unique-rows.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('validation_unique_rows', 4)

    // Open clean panel and select Find & Replace
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Find & Replace')

    // Select column and enter existing value
    await picker.selectColumn('name')
    await picker.fillParam('Find', 'John')

    // Wait for validation (debounce) and button to be enabled
    await expect.poll(async () => {
      const btn = page.getByTestId('apply-transformation-btn')
      return await btn.isEnabled()
    }, { timeout: 5000 }).toBe(true)

    // Apply button should be enabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeEnabled()
  })
})

test.describe('Transform Validation: Live Preview No-Match Detection', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test('Trim Whitespace: disables apply when no matching rows (no whitespace)', async () => {
    // Load data with no whitespace to trim
    await inspector.runQuery('DROP TABLE IF EXISTS validation_unique_rows')
    await laundromat.uploadFile(getFixturePath('validation-unique-rows.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('validation_unique_rows', 4)

    // Open clean panel and select Trim Whitespace
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Trim Whitespace')

    // Select a column with no whitespace
    await picker.selectColumn('name')

    // Wait for preview to complete (debounced)
    // Check that the preview shows "0 of 0 matching" (no rows to transform)
    await expect(page.getByText('No matching rows found')).toBeVisible({ timeout: 5000 })

    // Apply button should be disabled since no rows match
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeDisabled()
  })

  test('Trim Whitespace: allows apply when matching rows exist (has whitespace)', async () => {
    // Load data with whitespace to trim
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)  // 3 rows in fixture

    // Open clean panel and select Trim Whitespace
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Trim Whitespace')

    // Select a column with whitespace
    await picker.selectColumn('name')

    // Wait for preview to complete and button to be enabled
    await expect.poll(async () => {
      const btn = page.getByTestId('apply-transformation-btn')
      return await btn.isEnabled()
    }, { timeout: 5000 }).toBe(true)

    // Preview should show matching rows (not "No matching rows found")
    await expect(page.getByText('No matching rows found')).not.toBeVisible()

    // Apply button should be enabled
    const applyButton = page.getByTestId('apply-transformation-btn')
    await expect(applyButton).toBeEnabled()
  })

})
