import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Diff + Row Insertion Tests
 *
 * Tests for regression fixes related to diff view behavior with row insertions and cell edits:
 *
 * 1. Commit 2652a8b: _cs_origin_id for accurate diff after row insertion
 *    - Before: When row inserted, _cs_id values shift, causing ALL subsequent rows to show as "modified"
 *    - After: Only actual changes (inserted row + real edits) appear in diff
 *
 * 2. Commit 904ffb1: Manual edit recognition in diff
 *    - Before: dataVersion didn't increment for edit:cell commands, so diff preview didn't re-run
 *    - After: Manual cell edits correctly appear in diff preview
 *
 * Uses Tier 3 isolation (fresh browser context per test) because:
 * - Diff operations are memory-intensive
 * - Tests modify table structure (insert rows, edit cells)
 * - Need clean DuckDB state for reliable assertions
 */
test.describe('Diff After Row Insertion', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let diffView: DiffViewPage
  let inspector: StoreInspector

  // Extended timeout for diff + WASM operations
  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Tier 3: Fresh context per test for complete WASM isolation
    context = await browser.newContext()
    page = await context.newPage()

    // Handle page crashes gracefully
    page.on('crash', () => {
      console.error('[diff-row-insertion] Page crashed during test')
    })

    // Initialize page objects
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    diffView = new DiffViewPage(page)
    inspector = createStoreInspector(page)

    await page.goto('/')
    await inspector.waitForDuckDBReady()

    // Disable edit batching for immediate cell edit commits
    await inspector.disableEditBatching()
  })

  test.afterEach(async () => {
    try {
      // Close diff view if open
      await diffView.close().catch(() => {})
    } catch {
      // Ignore cleanup errors
    }
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test('diff shows only actual changes after row insertion (not shifted rows)', async () => {
    /**
     * Regression test for commit 2652a8b: _cs_origin_id feature
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Edit cell in row 3 (mark as dirty)
     * 3. Insert a new row at position 2 (shifts rows 3-5)
     * 4. Open diff (Compare with Preview)
     * 5. Assert: Only 2 rows show as modified:
     *    - The inserted row (new)
     *    - Row 3's edited cell (actual edit)
     * 6. Assert: Rows 4, 5 do NOT appear as modified (just shifted)
     *
     * Before fix: All rows after insertion showed as "modified" due to _cs_id shifting
     * After fix: Only actual changes appear in diff
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Get tableId for later use
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Get initial data for verification
    const initialData = await inspector.runQuery('SELECT * FROM basic_data ORDER BY "_cs_id"')
    expect(initialData.length).toBe(5)

    // Step 1: Edit a cell in row 3 (Bob Johnson -> Bob Modified)
    // Row 3 is at index 2 (0-indexed), column 1 is 'name'
    await inspector.waitForGridReady()
    await laundromat.editCell(2, 1, 'Bob Modified')

    // Wait for edit to complete and verify using polling
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY "_cs_id" LIMIT 1 OFFSET 2'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Bob Modified')

    // Step 2: Insert a new row above row 2 (Jane Smith)
    // This will shift rows 2-5 (Jane, Bob, Alice, Charlie) down by one position
    const grid = page.getByTestId('data-grid')
    const gridBounds = await grid.boundingBox()
    if (!gridBounds) throw new Error('Grid not found')

    // Click on row 2 marker (Jane Smith) and insert above
    await page.mouse.click(gridBounds.x + 20, gridBounds.y + 70)
    await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Insert Above' }).click()

    // Wait for insert to complete
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(6)

    // Verify row order after insert: John, NEW, Jane, Bob Modified, Alice, Charlie
    const afterInsert = await inspector.runQuery('SELECT name FROM basic_data ORDER BY "_cs_id"')
    expect(afterInsert.length).toBe(6)
    expect(afterInsert[0].name).toBe('John Doe')
    expect(afterInsert[1].name).toBeNull() // New row
    expect(afterInsert[2].name).toBe('Jane Smith')
    expect(afterInsert[3].name).toBe('Bob Modified') // Our edited row
    expect(afterInsert[4].name).toBe('Alice Brown')
    expect(afterInsert[5].name).toBe('Charlie Wilson')

    // Step 3: Open Diff View (Compare with Preview mode)
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // Run comparison in preview mode (compares current vs original)
    await diffView.runComparison()

    // Step 4: Get diff summary and verify
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { added: number; removed: number; modified: number; unchanged: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    const summary = diffState.summary!

    // CRITICAL ASSERTIONS:
    // - Added: 1 (the newly inserted row)
    // - Modified: 1 (Bob Johnson -> Bob Modified)
    // - Removed: 0
    // - Unchanged: 4 (John Doe, Jane Smith, Alice Brown, Charlie Wilson)
    //
    // Before fix: Modified would be 4 (all rows after insert point)
    // After fix: Modified should be 1 (only actual edit)
    expect(summary.added).toBe(1)
    expect(summary.modified).toBe(1)
    expect(summary.removed).toBe(0)
    expect(summary.unchanged).toBe(4)
  })

  test('diff detects manual cell edits in preview mode', async () => {
    /**
     * Regression test for commit 904ffb1: Manual edit recognition in diff
     *
     * Scenario:
     * 1. Load table
     * 2. Double-click cell, change value, press Enter
     * 3. Open diff (Compare with Preview)
     * 4. Assert: The edited row shows as "modified"
     * 5. Assert: summary.modified >= 1
     *
     * Before fix: dataVersion didn't increment for edit:cell commands,
     * so diff preview didn't re-run and edits were not visible.
     * After fix: Manual cell edits correctly appear in diff preview.
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Get tableId for later use
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Wait for grid to be ready before editing
    await inspector.waitForGridReady()

    // Edit a cell: Change "John Doe" to "John Modified"
    // Row 0, column 1 (name column)
    await laundromat.editCell(0, 1, 'John Modified')

    // Wait for edit to complete and verify using polling
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY "_cs_id" LIMIT 1'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('John Modified')

    // Open Diff View (Compare with Preview mode - compares current vs original)
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // Run comparison
    await diffView.runComparison()

    // Wait for diff to complete and verify summary from store
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { added: number; removed: number; modified: number; unchanged: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    const summary = diffState.summary!

    // CRITICAL ASSERTION: The manually edited row should appear as modified
    // Before fix: summary.modified was 0 (edit wasn't detected)
    // After fix: summary.modified should be 1
    expect(summary.modified).toBe(1)
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
    expect(summary.unchanged).toBe(4) // Other 4 rows unchanged
  })

  test('diff correctly handles multiple edits on same row after insertion', async () => {
    /**
     * Edge case test: Multiple edits + row insertion
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Edit cell in row 1 (first edit)
     * 3. Insert a new row
     * 4. Edit another cell in the same logical row (now shifted)
     * 5. Open diff and verify only actual changes appear
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    await inspector.waitForGridReady()

    // Edit row 1 (John Doe) - change name
    await laundromat.editCell(0, 1, 'John First Edit')

    // Wait for edit to complete
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY "_cs_id" LIMIT 1'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('John First Edit')

    // Insert a row at position 1
    const grid = page.getByTestId('data-grid')
    const gridBounds = await grid.boundingBox()
    if (!gridBounds) throw new Error('Grid not found')

    await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)
    await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Insert Above' }).click()

    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(6)

    // Edit the same logical row again (now at index 1 due to inserted row above)
    await laundromat.editCell(1, 2, 'john_second_edit@example.com')

    // Wait for edit to complete
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ email: string }>(
        'SELECT email FROM basic_data ORDER BY "_cs_id" LIMIT 1 OFFSET 1'
      )
      return result[0]?.email
    }, { timeout: 10000 }).toBe('john_second_edit@example.com')

    // Open Diff View
    await laundromat.openDiffView()
    await diffView.waitForOpen()
    await diffView.runComparison()

    // Wait for diff to complete
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { modified: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    const summary = diffState.summary!

    // Should have:
    // - 1 added row (the inserted row)
    // - 1 modified row (John Doe with both edits - name and email)
    expect(summary.added).toBe(1)
    expect(summary.modified).toBe(1) // John Doe row with 2 edits is still 1 modified row
    expect(summary.unchanged).toBe(4) // Jane, Bob, Alice, Charlie
  })

  test('diff shows correct row numbers for newly inserted rows (not "-")', async () => {
    /**
     * Regression test for commit 5d8ecf3: _cs_origin_id assignment for inserted rows
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Insert a new row at position 2
     * 3. Open Diff View, run comparison
     * 4. Verify the added row has actual row number (not "-" or null)
     *
     * Before fix: Inserted rows lacked _cs_origin_id, causing row numbers to show as "-"
     * After fix: Inserted rows get _cs_origin_id assigned, enabling proper row number display
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    await inspector.waitForGridReady()

    // Insert a new row at position 2 (above Jane Smith)
    const grid = page.getByTestId('data-grid')
    const gridBounds = await grid.boundingBox()
    if (!gridBounds) throw new Error('Grid not found')

    // Click on row 2 marker (Jane Smith row)
    await page.mouse.click(gridBounds.x + 20, gridBounds.y + 70)
    await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Insert Above' }).click()

    // Wait for insert to complete
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(6)

    // CRITICAL ASSERTION: Verify _cs_origin_id is populated for the new row
    // The new row should have a non-null _cs_origin_id
    const newRowOriginId = await inspector.runQuery<{ _cs_origin_id: string | null }>(
      `SELECT "_cs_origin_id" FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER) LIMIT 1 OFFSET 1`
    )
    expect(newRowOriginId[0]?._cs_origin_id).not.toBeNull()
    expect(newRowOriginId[0]?._cs_origin_id).toBeDefined()

    // Open Diff View
    await laundromat.openDiffView()
    await diffView.waitForOpen()
    await diffView.runComparison()

    // Wait for diff to complete
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { added: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    expect(diffState.summary?.added).toBe(1)

    // Get the diff table name to query row numbers
    const diffTableName = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as {
        getState: () => { diffTableName: string | null }
      } | undefined
      return diffStore?.getState()?.diffTableName
    })
    expect(diffTableName).not.toBeNull()

    // CRITICAL ASSERTION: Query the diff table to verify row numbers for added rows
    // b_row_num should be a number (not null) for the added row
    // Note: DuckDB returns BigInt for row numbers, so we check for bigint or number
    const addedRows = await inspector.runQuery<{ diff_status: string; b_row_num: bigint | number | null }>(
      `SELECT diff_status, b_row_num FROM "${diffTableName}" WHERE diff_status = 'added'`
    )
    expect(addedRows.length).toBe(1)
    expect(addedRows[0]?.b_row_num).not.toBeNull()
    // DuckDB may return BigInt; verify it's a numeric type
    expect(['number', 'bigint']).toContain(typeof addedRows[0]?.b_row_num)
    // Verify the row number is a positive integer
    expect(Number(addedRows[0]?.b_row_num)).toBeGreaterThan(0)
  })

  test('diff correctly handles multiple consecutive row insertions', async () => {
    /**
     * Edge case test: Multiple row insertions
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Insert 3 rows at the beginning (simpler than scattered insertions)
     * 3. Open Diff View, run comparison
     * 4. Verify 3 added rows with distinct row numbers
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await inspector.waitForGridReady()

    // Helper to insert a row at the first position
    async function insertRowAtTop() {
      const grid = page.getByTestId('data-grid')
      const gridBounds = await grid.boundingBox()
      if (!gridBounds) throw new Error('Grid not found')

      // Click on first row marker
      await page.mouse.click(gridBounds.x + 20, gridBounds.y + 50)
      await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: 'Insert Above' }).click()
    }

    // Insert 3 rows at the top
    await insertRowAtTop()
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(6)

    await insertRowAtTop()
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(7)

    await insertRowAtTop()
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(8)

    // Open Diff View
    await laundromat.openDiffView()
    await diffView.waitForOpen()
    await diffView.runComparison()

    // Wait for diff to complete
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { added: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    expect(diffState.summary?.added).toBe(3)

    // Get the diff table name to query row numbers
    const diffTableName = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as {
        getState: () => { diffTableName: string | null }
      } | undefined
      return diffStore?.getState()?.diffTableName
    })
    expect(diffTableName).not.toBeNull()

    // Verify all 3 added rows have distinct row numbers
    // Note: DuckDB returns BigInt for row numbers
    const addedRows = await inspector.runQuery<{ diff_status: string; b_row_num: bigint | number | null }>(
      `SELECT diff_status, b_row_num FROM "${diffTableName}" WHERE diff_status = 'added' ORDER BY b_row_num`
    )
    expect(addedRows.length).toBe(3)

    // All should have non-null row numbers
    for (const row of addedRows) {
      expect(row.b_row_num).not.toBeNull()
      expect(['number', 'bigint']).toContain(typeof row.b_row_num)
    }

    // Row numbers should be distinct (convert to Number for comparison)
    const rowNums = addedRows.map(r => Number(r.b_row_num))
    const uniqueRowNums = new Set(rowNums)
    expect(uniqueRowNums.size).toBe(3)
  })

  test('diff correctly identifies removed rows after deletion', async () => {
    /**
     * Regression test for stable row identity with deletions
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Delete row 2 (Jane Smith)
     * 3. Open Diff View, run comparison
     * 4. Verify 1 removed, 0 modified (no false positives from shifted rows)
     *
     * This ensures _cs_origin_id correctly tracks identity so deleted rows
     * are properly identified as "removed" and remaining rows aren't falsely
     * marked as "modified" just because they shifted positions.
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await inspector.waitForGridReady()

    // Delete row 2 (Jane Smith) - click row marker then delete
    const grid = page.getByTestId('data-grid')
    const gridBounds = await grid.boundingBox()
    if (!gridBounds) throw new Error('Grid not found')

    // Click on row 2 marker
    await page.mouse.click(gridBounds.x + 20, gridBounds.y + 70)

    // Wait for row action menu and click Delete
    await expect(page.getByRole('button', { name: 'Delete Row' })).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Delete Row' }).click()

    // Confirm deletion if there's a confirmation dialog
    const confirmDialog = page.getByRole('alertdialog')
    if (await confirmDialog.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirmDialog.getByRole('button', { name: /delete|confirm/i }).click()
    }

    // Wait for delete to complete
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(4)

    // Open Diff View
    await laundromat.openDiffView()
    await diffView.waitForOpen()
    await diffView.runComparison()

    // Wait for diff to complete
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { removed: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    const summary = diffState.summary!

    // CRITICAL ASSERTIONS:
    // - Removed: 1 (Jane Smith was deleted)
    // - Modified: 0 (no false positives from shifted rows)
    // - Added: 0
    // - Unchanged: 4 (John, Bob, Alice, Charlie)
    expect(summary.removed).toBe(1)
    expect(summary.modified).toBe(0)
    expect(summary.added).toBe(0)
    expect(summary.unchanged).toBe(4)
  })
})
