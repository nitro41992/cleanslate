import { test, expect } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Transformations', () => {
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

  test('should apply trim transformation', async ({ page }) => {
    const inspector = createStoreInspector(page)

    // Upload whitespace data
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Add trim transformation
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Run recipe
    await laundromat.clickRunRecipe()

    // Verify via DuckDB query
    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('John Doe')
    expect(data[1].name).toBe('Jane Smith')
    expect(data[2].name).toBe('Bob Johnson')
  })

  test('should apply uppercase transformation', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('mixed_case')
    expect(data[0].name).toBe('JOHN DOE')
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')
  })

  test('should apply lowercase transformation', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('mixed_case')
    expect(data[0].name).toBe('john doe')
    expect(data[1].name).toBe('jane smith')
    expect(data[2].name).toBe('bob johnson')
  })

  test('should remove duplicates', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()

    // Wait for table to be loaded
    await inspector.waitForTableLoaded('with_duplicates', 5)

    // Verify initial count
    let tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')

    await laundromat.clickRunRecipe()

    // Verify reduced count
    tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3) // 3 unique rows
  })

  test('should filter empty values', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('empty-values.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('empty_values', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Filter Empty', { column: 'name' })

    await laundromat.clickRunRecipe()

    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3) // Rows with empty name removed
  })

  test('should chain multiple transformations', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    // Add trim
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Add uppercase
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('JOHN DOE') // Trimmed and uppercased
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')
  })

  test('should log transformations to audit log', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    await laundromat.clickRunRecipe()

    // Verify audit log entry
    const auditEntries = await inspector.getAuditEntries()
    const trimEntry = auditEntries.find((e) => e.action.includes('Trim'))
    expect(trimEntry).toBeDefined()
    expect(trimEntry?.details).toContain('Rows affected')
  })
})
