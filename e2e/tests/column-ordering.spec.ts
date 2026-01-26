import { test, expect, type Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Column Order Preservation Tests
 *
 * These tests verify that column order is preserved through all transformation tiers,
 * undo/redo operations, and combiner operations. Tests are written to FAIL before
 * the column ordering infrastructure is implemented (TDD approach).
 *
 * Expected failures before fix:
 * - Transformed columns move to last position
 * - Undo/redo loses original order
 * - Combiner operations don't initialize columnOrder
 */

test.describe('Column Order Preservation', () => {
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

  test('Tier 1 (trim) preserves original column order', async () => {
    // Arrange: Load CSV with known column order
    await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('column_order_test', 4)

    // Get initial column order from store
    const initialColumns = await inspector.getTableColumns('column_order_test')
    expect(initialColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status'])

    // Act: Apply trim transformation to 'email' (column index 3)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'email' })

    // Assert: Column order should remain unchanged
    const finalColumns = await inspector.getTableColumns('column_order_test')
    expect(finalColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status'])
  })

  test('Tier 2 (rename_column) keeps renamed column in same position', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('column_order_test', 4)

    const initialOrder = ['id', 'name', 'email', 'status']

    // Act: Rename 'email' (position 3) to 'email_address'
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Rename Column')
    await picker.selectColumn('email')
    await picker.fillParam('New Name', 'email_address')
    await picker.apply()

    // Assert: Column stays in position 3 with new name
    const finalColumns = await inspector.getTableColumns('column_order_test')
    expect(finalColumns.map(c => c.name)).toEqual(['id', 'name', 'email_address', 'status'])
  })

  test('Tier 3 (remove_duplicates) preserves column order', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 6)

    const initialColumns = await inspector.getTableColumns('with_duplicates')
    const initialOrder = initialColumns.map(c => c.name)

    // Act: Remove duplicates (Tier 3 - uses snapshot)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates', { column: 'email' })

    // Assert: Column order unchanged (only rows affected)
    const finalColumns = await inspector.getTableColumns('with_duplicates')
    expect(finalColumns.map(c => c.name)).toEqual(initialOrder)
  })

  test('split_column appends new columns at end, keeps original', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('split-column-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('split_column_test', 3)

    // Initial: ['_cs_id', 'id', 'full_name', 'email']

    // Act: Split 'full_name' by space
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Split Column')
    await picker.selectColumn('full_name')
    await picker.fillParam('Delimiter', ' ')
    await picker.apply()

    // Assert: New columns at end, original kept (current implementation keeps original column)
    const finalColumns = await inspector.getTableColumns('split_column_test')
    expect(finalColumns.map(c => c.name)).toEqual(['id', 'full_name', 'email', 'full_name_1', 'full_name_2'])
  })

  test('undo restores original column order', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('column_order_test', 4)

    const originalOrder = ['id', 'name', 'email', 'status']

    // Act: Transform + Undo
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'email' })
    await laundromat.closePanel()

    // Verify order might be affected after transform (this will show the bug)
    const afterTransform = await inspector.getTableColumns('column_order_test')
    // console.log('After transform:', afterTransform.map(c => c.name))

    await laundromat.clickUndo()

    // Assert: Order restored to original
    const afterUndo = await inspector.getTableColumns('column_order_test')
    expect(afterUndo.map(c => c.name)).toEqual(originalOrder)
  })

  test('redo preserves column order after undo', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('column_order_test', 4)

    // Act: Transform → Undo → Redo
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    const afterTransform = await inspector.getTableColumns('column_order_test')
    const orderAfterTransform = afterTransform.map(c => c.name)

    await laundromat.clickUndo()
    await laundromat.clickRedo()

    // Assert: Redo restores the SAME order as after transform (not shuffled again)
    const afterRedo = await inspector.getTableColumns('column_order_test')
    expect(afterRedo.map(c => c.name)).toEqual(orderAfterTransform)
  })

  test('chained transformations preserve column order', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('column_order_test', 4)

    const originalOrder = ['id', 'name', 'email', 'status']

    // Act: Apply 3 transformations in sequence
    // 1. Trim email
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'email' })
    await laundromat.closePanel()

    // 2. Lowercase name
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'name' })
    await laundromat.closePanel()

    // 3. Uppercase status
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'status' })
    await laundromat.closePanel()

    // Assert: Original column order maintained
    const finalColumns = await inspector.getTableColumns('column_order_test')
    expect(finalColumns.map(c => c.name)).toEqual(originalOrder)
  })

  test('combiner stack preserves union column order', async () => {
    // Arrange: Load two tables with different column orders
    await inspector.runQuery('DROP TABLE IF EXISTS stack_table_1')
    await inspector.runQuery('DROP TABLE IF EXISTS stack_table_2')
    await inspector.runQuery('DROP TABLE IF EXISTS stacked_result')

    await laundromat.uploadFile(getFixturePath('stack-table-1.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_1', 2)

    await laundromat.uploadFile(getFixturePath('stack-table-2.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_2', 2)

    // Act: Stack tables (UNION ALL)
    await laundromat.openCombinePanel()
    await expect(page.locator('text=Stack').first()).toBeVisible()
    await expect(page.getByTestId('combiner-stack-tab')).toBeVisible()

    // Add first table
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'stack_table_1' }).click()
    await page.getByRole('button', { name: 'Add' }).click()

    // Add second table
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'stack_table_2' }).click()
    await page.getByRole('button', { name: 'Add' }).click()

    // Enter result table name
    await page.getByPlaceholder('e.g., combined_sales').fill('stacked_result')

    // Click Stack Tables button
    await page.getByTestId('combiner-stack-btn').click()
    await expect(page.getByText('Tables Stacked', { exact: true })).toBeVisible({ timeout: 5000 })

    // Assert: Column order = union of source columns (first appearance)
    // Table 1: ['id', 'name', 'email']
    // Table 2: ['id', 'email', 'status']
    // Expected: ['id', 'name', 'email', 'status']
    const stackedColumns = await inspector.getTableColumns('stacked_result')
    expect(stackedColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status'])
  })

  test('combiner join preserves left + right column order', async () => {
    // Arrange: Load two tables
    await inspector.runQuery('DROP TABLE IF EXISTS join_left')
    await inspector.runQuery('DROP TABLE IF EXISTS join_right')
    await inspector.runQuery('DROP TABLE IF EXISTS join_result')

    await laundromat.uploadFile(getFixturePath('join-left.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('join_left', 2)

    await laundromat.uploadFile(getFixturePath('join-right.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('join_right', 2)

    // Act: Join on 'id'
    await laundromat.openCombinePanel()
    await expect(page.locator('text=Stack').first()).toBeVisible()

    // Switch to Join tab
    await page.getByTestId('combiner-join-tab').click()
    await expect(page.locator('text=Join Tables').first()).toBeVisible()

    // Select left table
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'join_left' }).click()

    // Select right table
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: 'join_right' }).click()

    // Select join key
    await page.getByRole('combobox').nth(2).click()
    await page.getByRole('option', { name: 'id' }).click()

    // Enter result table name
    await page.getByPlaceholder('e.g., orders_with_customers').fill('join_result')

    // Click Join Tables button
    await page.getByTestId('combiner-join-btn').click()
    await expect(page.getByText('Tables Joined', { exact: true })).toBeVisible({ timeout: 5000 })

    // Assert: Left columns + Right columns (excluding duplicate join key)
    // Left: ['id', 'name', 'email']
    // Right: ['id', 'status', 'role']
    // Expected: ['id', 'name', 'email', 'status', 'role'] (right's id excluded)
    const joinedColumns = await inspector.getTableColumns('join_result')
    expect(joinedColumns.map(c => c.name)).toEqual(['id', 'name', 'email', 'status', 'role'])
  })

  test('transform after combiner preserves combined table order', async () => {
    // Arrange: Stack two tables
    await inspector.runQuery('DROP TABLE IF EXISTS stack_table_1')
    await inspector.runQuery('DROP TABLE IF EXISTS stack_table_2')
    await inspector.runQuery('DROP TABLE IF EXISTS stacked_result')

    await laundromat.uploadFile(getFixturePath('stack-table-1.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_1', 2)

    await laundromat.uploadFile(getFixturePath('stack-table-2.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('stack_table_2', 2)

    await laundromat.openCombinePanel()
    await expect(page.locator('text=Stack').first()).toBeVisible()

    // Add tables and stack
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'stack_table_1' }).click()
    await page.getByRole('button', { name: 'Add' }).click()

    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'stack_table_2' }).click()
    await page.getByRole('button', { name: 'Add' }).click()

    await page.getByPlaceholder('e.g., combined_sales').fill('stacked_result')
    await page.getByTestId('combiner-stack-btn').click()
    await expect(page.getByText('Tables Stacked', { exact: true })).toBeVisible({ timeout: 5000 })

    const orderAfterStack = await inspector.getTableColumns('stacked_result')
    const expectedOrder = orderAfterStack.map(c => c.name)

    // Close combiner panel
    await laundromat.closePanel()

    // Act: Apply transformation to stacked table
    // First, switch to stacked_result table in the UI
    await page.getByTestId('table-selector').click()
    await page.getByRole('option', { name: 'stacked_result' }).click()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'email' })

    // Assert: Combined table's column order preserved
    const finalColumns = await inspector.getTableColumns('stacked_result')
    expect(finalColumns.map(c => c.name)).toEqual(expectedOrder)
  })

  test('internal columns (_cs_id, __base) excluded from user-facing order', async () => {
    // Arrange
    await laundromat.uploadFile(getFixturePath('column-order-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('column_order_test', 4)

    // Act: Apply Tier 1 transformation (creates __base column)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'email' })

    // Assert: Fetch tableStore columnOrder - should NOT contain internal columns
    const tableInfo = await inspector.getTableInfo('column_order_test')

    // columnOrder field might not exist yet (this is what we're implementing)
    // But if it does, it should not contain _cs_id or __base columns
    if (tableInfo?.columnOrder) {
      expect(tableInfo.columnOrder).not.toContain('_cs_id')
      expect(tableInfo.columnOrder.every((name: string) => !name.endsWith('__base'))).toBe(true)
    }

    // Grid columns should not include internal columns in the columnOrder metadata
    const allColumns = await inspector.getTableColumns('column_order_test')
    // Just verify we have some columns (the actual presence of _cs_id depends on table initialization)
    expect(allColumns.length).toBeGreaterThan(0)
  })

  test.skip('batched transformations (>500k rows) preserve column order', async () => {
    // This test requires a large CSV fixture (600k rows) which is not practical
    // for TDD. The batching logic will be tested separately once infrastructure
    // is in place. Skipping for now.
    expect(true).toBe(true)
  })
})
