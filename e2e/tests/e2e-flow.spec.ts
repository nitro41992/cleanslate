import { test, expect } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { downloadAndVerifyCSV } from '../helpers/download-helpers'
import { createStoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Full E2E Flow', () => {
  test('upload → configure → transform → verify → export', async ({ page }) => {
    const laundromat = new LaundromatPage(page)
    const wizard = new IngestionWizardPage(page)
    const picker = new TransformationPickerPage(page)
    const inspector = createStoreInspector(page)

    // 1. Navigate to app
    await laundromat.goto()
    await inspector.waitForDuckDBReady()

    // 2. Verify initial state - dropzone visible
    await expect(laundromat.dropzone).toBeVisible()

    // 3. Upload CSV file
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))

    // 4. Configure ingestion wizard
    await wizard.waitForOpen()
    expect(await wizard.getDetectedColumnCount()).toBe(3)
    await wizard.import()

    // 5. Verify file loaded - grid visible
    await expect(laundromat.gridContainer).toBeVisible()
    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3)

    // 6. Apply transformation: Trim whitespace (direct-apply)
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // 7. Apply transformation: Uppercase (direct-apply)
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    // 8. Verify transformation results via store
    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('JOHN DOE')
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')

    // 9. Verify audit log has entries
    const auditEntries = await inspector.getAuditEntries()
    const transformEntries = auditEntries.filter(
      (e) => e.action.includes('Trim') || e.action.includes('Uppercase')
    )
    expect(transformEntries.length).toBeGreaterThanOrEqual(2)

    // 10. Export and verify download
    const downloadResult = await downloadAndVerifyCSV(page)
    expect(downloadResult.filename).toContain('cleaned.csv')
    expect(downloadResult.rows[1][1]).toBe('JOHN DOE')
  })

  test('upload pipe-delimited → detect delimiter → transform → export', async ({ page }) => {
    const laundromat = new LaundromatPage(page)
    const wizard = new IngestionWizardPage(page)
    const picker = new TransformationPickerPage(page)
    const inspector = createStoreInspector(page)

    await laundromat.goto()
    await inspector.waitForDuckDBReady()

    // Upload pipe-delimited file
    await laundromat.uploadFile(getFixturePath('pipe-delimited.csv'))

    // Verify auto-detected delimiter
    await wizard.waitForOpen()
    await expect(page.locator('text=/Auto.*Pipe/')).toBeVisible()
    await wizard.import()

    // Verify data loaded correctly
    await expect(laundromat.gridContainer).toBeVisible()
    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3)

    // Apply uppercase transformation (direct-apply)
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    // Verify transformation
    const data = await inspector.getTableData('pipe_delimited')
    expect(data[0].name).toBe('JOHN DOE')

    // Export and verify
    const downloadResult = await downloadAndVerifyCSV(page)
    expect(downloadResult.rows[1][1]).toBe('JOHN DOE')
  })

  test('upload → deduplicate → filter empty → export', async ({ page }) => {
    const laundromat = new LaundromatPage(page)
    const wizard = new IngestionWizardPage(page)
    const picker = new TransformationPickerPage(page)
    const inspector = createStoreInspector(page)

    await laundromat.goto()
    await inspector.waitForDuckDBReady()

    // Upload data with duplicates
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()

    // Wait for table to be loaded
    await inspector.waitForTableLoaded('with_duplicates', 5)

    // Verify initial count
    let tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(5)

    // Remove duplicates (direct-apply)
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')

    // Verify reduced count
    tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3)

    // Export deduplicated data
    const downloadResult = await downloadAndVerifyCSV(page)
    expect(downloadResult.rows.length).toBe(4) // Header + 3 rows
  })
})
