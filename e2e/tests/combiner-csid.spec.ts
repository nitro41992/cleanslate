import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * FR-E: Combiner _cs_id column tests
 *
 * These tests verify that stack and join operations produce result tables
 * with the _cs_id column, which is required for:
 * - Keyset pagination (ORDER BY "_cs_id")
 * - Cell editing (locating rows by stable ID)
 * - Row highlighting
 *
 * Without _cs_id, the DataGrid fails with:
 * "Binder Error: Referenced column "_cs_id" not found in FROM clause!"
 */
test.describe('Combiner _cs_id column', () => {
  // Use fresh browser context per test for WASM isolation (Tier 3 test pattern)
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.setTimeout(120000) // 2 mins for heavy WASM operations

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)
    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  test('stack operation should include _cs_id column', async () => {
    // 1. Upload first table
    await laundromat.uploadFile(getFixturePath('stack-table-1.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_1', 2)

    // 2. Upload second table
    await laundromat.uploadFile(getFixturePath('stack-table-2.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_2', 2)

    // 3. Open Combine panel
    await laundromat.openCombinePanel()

    // 4. Select tables to stack
    // Scope to the dialog to avoid ambiguity, use getByRole for the combobox
    const combineDialog = page.getByRole('dialog', { name: 'Combine' })
    await combineDialog.waitFor({ state: 'visible' })

    // Select first table - selecting from combobox auto-adds the table
    const stackPanel = combineDialog.getByRole('tabpanel', { name: 'Stack' })
    await stackPanel.getByRole('combobox').click()
    await page.getByRole('option', { name: /stack_table_1/ }).click()

    // Select second table (combobox resets after each selection)
    await stackPanel.getByRole('combobox').click()
    await page.getByRole('option', { name: /stack_table_2/ }).click()

    // 5. Wait for Result Table Name input to appear (shows when 2 tables selected)
    // Note: The result name input is in the right column, outside the tabpanel
    const resultNameInput = combineDialog.getByPlaceholder('e.g., combined_sales')
    await resultNameInput.waitFor({ state: 'visible', timeout: 10000 })

    // 6. Enter result table name and stack
    await resultNameInput.fill('stacked_result')
    await combineDialog.getByRole('button', { name: 'Stack Tables' }).click()

    // 7. Wait for combiner operation to complete
    await inspector.waitForCombinerComplete()
    await inspector.waitForTableLoaded('stacked_result', 4) // 2 + 2 rows

    // 8. Verify _cs_id column exists in result table via SQL
    const columns = await inspector.runQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'stacked_result'`
    )
    const columnNames = columns.map((c) => c.column_name)
    expect(columnNames).toContain('_cs_id')

    // 9. Verify _cs_id values are gap-based sequential (100, 200, 300, 400)
    const rows = await inspector.runQuery<{ _cs_id: number }>(
      'SELECT "_cs_id" FROM stacked_result ORDER BY "_cs_id"'
    )
    expect(rows.map((r) => Number(r._cs_id))).toEqual([100, 200, 300, 400])

    // 10. Verify grid displays correctly by checking it's visible (not gray/error)
    await expect(laundromat.gridContainer).toBeVisible()

    // 11. Close panel
    await laundromat.closePanel()
  })

  test('join operation should include _cs_id column', async () => {
    // 1. Upload left table
    await laundromat.uploadFile(getFixturePath('join-left.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('join_left', 2)

    // 2. Upload right table
    await laundromat.uploadFile(getFixturePath('join-right.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('join_right', 2)

    // 3. Open Combine panel
    await laundromat.openCombinePanel()

    // 4. Scope to the dialog
    const combineDialog = page.getByRole('dialog', { name: 'Combine' })
    await combineDialog.waitFor({ state: 'visible' })

    // 5. Click Join tab
    await combineDialog.getByRole('tab', { name: 'Join' }).click()

    // 6. Select tables and key column
    const joinPanel = combineDialog.getByRole('tabpanel', { name: 'Join' })
    await joinPanel.waitFor({ state: 'visible' })

    // Select left table (first combobox in tabpanel)
    const tableComboboxes = joinPanel.getByRole('combobox')
    await tableComboboxes.nth(0).click()
    await page.getByRole('option', { name: /join_left/ }).click()

    // Select right table (second combobox in tabpanel)
    await tableComboboxes.nth(1).click()
    await page.getByRole('option', { name: /join_right/ }).click()

    // Select key column (combobox in the right column, outside tabpanel)
    // Wait for the key column selector to become available
    const keyColumnCombobox = combineDialog.locator('text=Key Column').locator('..').getByRole('combobox')
    await keyColumnCombobox.waitFor({ state: 'visible', timeout: 5000 })
    await keyColumnCombobox.click()
    await page.getByRole('option', { name: 'id' }).click()

    // 7. Wait for Result Table Name input to appear
    // Note: Result name input may be in right column, outside the tabpanel
    const resultNameInput = combineDialog.getByPlaceholder('e.g., orders_with_customers')
    await resultNameInput.waitFor({ state: 'visible', timeout: 10000 })

    // 8. Enter result table name and join
    await resultNameInput.fill('joined_result')
    await combineDialog.getByRole('button', { name: 'Join Tables' }).click()

    // 9. Wait for combiner operation to complete
    await inspector.waitForCombinerComplete()
    await inspector.waitForTableLoaded('joined_result', 2) // Inner join: 2 matching rows

    // 10. Verify _cs_id column exists in result table via SQL
    const columns = await inspector.runQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'joined_result'`
    )
    const columnNames = columns.map((c) => c.column_name)
    expect(columnNames).toContain('_cs_id')

    // 11. Verify _cs_id values are gap-based sequential (100, 200)
    const rows = await inspector.runQuery<{ _cs_id: number }>(
      'SELECT "_cs_id" FROM joined_result ORDER BY "_cs_id"'
    )
    expect(rows.map((r) => Number(r._cs_id))).toEqual([100, 200])

    // 12. Verify grid displays correctly by checking it's visible (not gray/error)
    await expect(laundromat.gridContainer).toBeVisible()

    // 13. Close panel
    await laundromat.closePanel()
  })

  test('stacked table should support cell editing via _cs_id', async () => {
    // This test verifies that the _cs_id column enables cell editing
    // which requires stable row identifiers

    // 1. Upload and stack tables
    await laundromat.uploadFile(getFixturePath('stack-table-1.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_1', 2)

    await laundromat.uploadFile(getFixturePath('stack-table-2.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_2', 2)

    await laundromat.openCombinePanel()

    // Scope to the dialog
    const combineDialog = page.getByRole('dialog', { name: 'Combine' })
    await combineDialog.waitFor({ state: 'visible' })

    const stackPanel = combineDialog.getByRole('tabpanel', { name: 'Stack' })

    // Select first table (selecting auto-adds)
    await stackPanel.getByRole('combobox').click()
    await page.getByRole('option', { name: /stack_table_1/ }).click()

    // Select second table
    await stackPanel.getByRole('combobox').click()
    await page.getByRole('option', { name: /stack_table_2/ }).click()

    // Enter result table name (input is in right column, outside tabpanel)
    const resultNameInput = combineDialog.getByPlaceholder('e.g., combined_sales')
    await resultNameInput.waitFor({ state: 'visible', timeout: 10000 })
    await resultNameInput.fill('edit_test')
    await combineDialog.getByRole('button', { name: 'Stack Tables' }).click()

    await inspector.waitForCombinerComplete()
    await inspector.waitForTableLoaded('edit_test', 4)
    await laundromat.closePanel()

    // 2. The stacked table should already be active after stacking
    // Verify the table exists
    const tables = await inspector.getTables()
    const editTestTable = tables.find((t) => t.name === 'edit_test')
    expect(editTestTable).toBeDefined()

    // 3. Wait for grid to be ready
    await inspector.waitForGridReady()

    // 4. Edit a cell in the stacked result table
    // The editCell function relies on _cs_id for row identification
    await laundromat.editCell(0, 1, 'EDITED_VALUE') // Edit first row, second column (name)

    // 5. Wait for the edit batch to be flushed to DuckDB
    await inspector.flushEditBatch()
    await inspector.waitForEditBatchFlush()

    // 6. Verify the edit was applied via SQL
    const data = await inspector.getTableData('edit_test')
    expect(data[0].name).toBe('EDITED_VALUE')
  })
})
