import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Data Manipulation Tests
 *
 * Tests for row operations:
 * - Row menu appears when clicking row markers
 * - Insert row above/below adds a new row
 * - Delete row removes a row
 *
 * Note: Column header tests are skipped due to glide-data-grid click detection issues.
 * The column menu works in manual testing but Playwright's mouse.click doesn't
 * trigger glide-data-grid's onHeaderClicked callback reliably.
 */

test.describe('Data Manipulation Operations', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // DuckDB WASM + schema operations need more time
  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  // Use fresh CONTEXT per test for true isolation (prevents cascade failures from WASM crashes)
  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()

    page.on('crash', () => {
      console.error('[data-manipulation] Page crashed during test')
    })

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)

    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  test.describe('Row Operations', () => {
    test('clicking row number shows row menu', async () => {
      // Arrange: Load CSV (basic-data.csv has 5 rows)
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Act: Click on a row number (row marker)
      const grid = page.getByTestId('data-grid')
      await grid.waitFor({ state: 'visible' })

      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      // Row markers are in the first ~40 pixels
      // Header is about 36px, so first data row starts around y=36
      // Click at x=20 (middle of row marker column), y=50 (first data row)
      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)

      // Assert: Row menu should appear
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await expect(page.getByText('Insert Below')).toBeVisible()
      await expect(page.getByText('Delete Row')).toBeVisible()
    })

    test('insert row adds a new row to the table', async () => {
      // Arrange: Load CSV
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const initialRowCount = 5

      // Act: Click row marker to show menu, then click Insert Above
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)
      await expect(page.getByText('Insert Above')).toBeVisible()
      await page.getByRole('button', { name: 'Insert Above' }).click()

      // Assert: Row count increased by 1
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(initialRowCount + 1)
    })

    test('insert above inserts row at correct position', async () => {
      // Arrange: Load CSV (basic-data.csv has ids 1,2,3,4,5)
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Get initial row order
      const initialRows = await inspector.runQuery('SELECT id, name FROM basic_data ORDER BY "_cs_id"')
      const _initialNames = initialRows.map(r => r.name)
      // Should be: John Doe, Jane Smith, Bob Johnson, Alice Brown, Charlie Wilson

      // Act: Click on row 2 (Jane Smith) and insert above
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      // Row 2 is around y + 70 (header ~36px, each row ~33px)
      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 70)
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Insert Above' }).click()

      // Assert: New row is inserted above Jane Smith (position 2)
      await expect.poll(async () => {
        const rows = await inspector.runQuery('SELECT id, name FROM basic_data ORDER BY "_cs_id"')
        return rows.length
      }, { timeout: 10000 }).toBe(6)

      // Verify order: new row (NULL) should be at position 2
      const finalRows = await inspector.runQuery('SELECT id, name FROM basic_data ORDER BY "_cs_id"')
      expect(finalRows[0].name).toBe('John Doe')  // Position 1 unchanged
      expect(finalRows[1].name).toBeNull()        // New row at position 2
      expect(finalRows[2].name).toBe('Jane Smith') // Jane moved to position 3
    })

    test('insert below inserts row at correct position', async () => {
      // Arrange: Load CSV
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Act: Click on row 2 (Jane Smith) and insert below
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 70)
      await expect(page.getByText('Insert Below')).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Insert Below' }).click()

      // Assert: New row is inserted after Jane Smith (position 3)
      await expect.poll(async () => {
        const rows = await inspector.runQuery('SELECT id, name FROM basic_data ORDER BY "_cs_id"')
        return rows.length
      }, { timeout: 10000 }).toBe(6)

      // Verify order: new row (NULL) should be at position 3
      const finalRows = await inspector.runQuery('SELECT id, name FROM basic_data ORDER BY "_cs_id"')
      expect(finalRows[0].name).toBe('John Doe')    // Position 1 unchanged
      expect(finalRows[1].name).toBe('Jane Smith')  // Position 2 unchanged
      expect(finalRows[2].name).toBeNull()          // New row at position 3
      expect(finalRows[3].name).toBe('Bob Johnson') // Bob moved to position 4
    })

    test('delete row removes the row from the table', async () => {
      // Arrange: Load CSV
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const initialRowCount = 5

      // Act: Click row marker to show menu, then Delete Row
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      // Click on row 3 (y around 100 from grid top)
      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 100)
      await expect(page.getByText('Delete Row')).toBeVisible()
      await page.getByRole('button', { name: 'Delete Row' }).click()

      // Confirm deletion in dialog
      await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 })
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()

      // Assert: Row count decreased by 1
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(initialRowCount - 1)
    })

    test('undo restores deleted row', async () => {
      // Arrange: Load CSV and delete a row
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const initialRowCount = 5

      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      // Delete a row - click row marker to show menu
      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 100)
      await expect(page.getByRole('button', { name: 'Delete Row' })).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Delete Row' }).click()

      // Wait for and confirm delete dialog
      await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 })
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()

      // Verify row was deleted
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(initialRowCount - 1)

      // Act: Click undo button (wait for it to be enabled first)
      const undoBtn = page.getByTestId('undo-btn')
      await expect(undoBtn).toBeEnabled({ timeout: 5000 })
      await undoBtn.click()

      // Assert: Row count is restored
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(initialRowCount)
    })

    // Persistence test is flaky due to timing issues with auto-save debounce
    // The persistence system is tested in other spec files (opfs-persistence.spec.ts)
    test.skip('changes persist across page refresh', async () => {
      // Arrange: Load CSV and make changes
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Insert a row above row 1
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Insert Above' }).click()

      // Wait for insert to complete and verify
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(6)

      // Wait for auto-save to complete
      // The persistence status shows: "Unsaved changes" → "Saving..." → "Saved"
      // Wait for "Saved" text to appear in the status area
      await expect(page.getByText('Saved', { exact: false })).toBeVisible({ timeout: 30000 })

      // Act: Reload the page
      await page.reload()

      // Re-initialize inspector after page reload
      inspector = createStoreInspector(page)
      await inspector.waitForDuckDBReady()

      // Wait for table to be restored from OPFS
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        return tables.some(t => t.name === 'basic_data')
      }, { timeout: 30000 }).toBe(true)

      // Assert: Changes persisted - should still have 6 rows
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(6)
    })
  })

  // Column header tests are skipped due to glide-data-grid click detection issues
  // The onHeaderClicked callback doesn't fire reliably with Playwright's mouse events
  test.describe.skip('Column Operations', () => {
    test('clicking column header shows column menu with type info', async () => {
      // This test is skipped - see note above
    })
  })

  // Column reordering tests are in e2e/tests/column-ordering.spec.ts
  // Drag-and-drop via Playwright doesn't reliably trigger glide-data-grid's onColumnMoved
  test.describe.skip('Column Reordering', () => {
    test('drag and drop reorders columns', async () => {
      // Covered in column-ordering.spec.ts
    })
  })

  test.describe('Row Menu on Inserted Rows', () => {
    test('row menu appears on newly inserted rows (regression: commit 3037ddf)', async () => {
      /**
       * Regression test for commit 3037ddf: csIdToRowIndex mapping fix
       *
       * Problem: After inserting a row, clicking the NEW row's marker didn't show
       * the context menu due to mapping collision in csIdToRowIndex.
       *
       * Solution: Proper mapping of new row _cs_id to visual row index.
       */

      // Load CSV
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Insert a row above row 1 (John Doe)
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Insert Above' }).click()

      // Wait for row to be inserted
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(6)

      // Dismiss any overlays
      await laundromat.dismissOverlays()

      // Click on the NEW row's marker (it should now be at position 1 / y ~50)
      // The inserted row is at position 1, so its row marker is at y + 50
      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)

      // Assert: Row menu should appear for the newly inserted row
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await expect(page.getByText('Insert Below')).toBeVisible()
      await expect(page.getByText('Delete Row')).toBeVisible()
    })

    test('inserted row has unique _cs_id for tracking (regression: commit 3037ddf)', async () => {
      /**
       * Regression test for commit 3037ddf: Row insertion tracking
       *
       * When a row is inserted, it gets a unique _cs_id that is used for:
       * 1. Green gutter indicator (visual feedback, stored in DataGrid local state)
       * 2. Accurate diff after row insertion (_cs_origin_id feature)
       * 3. Row menu functionality (csIdToRowIndex mapping)
       *
       * Note: The green gutter indicator state (insertedRowCsIds) is kept in
       * DataGrid component local state, not in a global store, so we can't
       * assert on it directly. We verify the row gets a valid _cs_id instead.
       */

      // Load CSV
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Get initial _cs_id values
      const beforeInsert = await inspector.runQuery<{ _cs_id: bigint }>(
        'SELECT "_cs_id" FROM basic_data ORDER BY "_cs_id"'
      )
      expect(beforeInsert.length).toBe(5)
      const initialCsIds = beforeInsert.map(r => String(r._cs_id))

      // Insert a row
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Insert Above' }).click()

      // Wait for insert to complete
      await expect.poll(async () => {
        const tables = await inspector.getTables()
        const table = tables.find(t => t.name === 'basic_data')
        return table?.rowCount
      }, { timeout: 10000 }).toBe(6)

      // Get _cs_id values after insert
      const afterInsert = await inspector.runQuery<{ _cs_id: bigint }>(
        'SELECT "_cs_id" FROM basic_data ORDER BY "_cs_id"'
      )
      expect(afterInsert.length).toBe(6)
      const finalCsIds = afterInsert.map(r => String(r._cs_id))

      // Find the new _cs_id (the one not in the original list)
      const newCsId = finalCsIds.find(id => !initialCsIds.includes(id))

      // Assert: The inserted row has a unique _cs_id
      expect(newCsId).toBeDefined()
      expect(newCsId).not.toBe('')
    })
  })

  test.describe('Scroll Position Preservation', () => {
    test.skip('scroll position preserved after row insertion', async () => {
      /**
       * Regression test for DataGrid.tsx scroll preservation
       *
       * Scenario:
       * 1. Load table with 100+ rows
       * 2. Scroll down to row 50
       * 3. Insert a row at current position
       * 4. Assert: Scroll position is still around row 50 (not reset to top)
       *
       * Note: This test requires a large fixture (100+ rows) which doesn't exist.
       * Skipped until large-dataset.csv fixture is created.
       */
      expect(true).toBe(true)
    })

    test.skip('scroll position preserved after column addition', async () => {
      /**
       * Regression test for DataGrid.tsx scroll preservation
       *
       * Scenario:
       * 1. Load table with many columns
       * 2. Scroll right to see last columns
       * 3. Add a new column (via split_column or other transform)
       * 4. Assert: Horizontal scroll position maintained
       *
       * Note: This test requires a wide table fixture and reliable horizontal
       * scroll detection. Skipped until fixture is created.
       */
      expect(true).toBe(true)
    })
  })
})
