import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Audit Row Tracking Tests
 *
 * Tests for audit log row number display after structural changes (insertions/deletions).
 *
 * Key regression test for commit 9b68947:
 * - Before: Audit drill-down showed stale row numbers based on _cs_id position at edit time
 * - After: Audit drill-down shows dynamic row numbers using _cs_origin_id for stable identity
 *
 * Uses Tier 3 isolation (fresh browser context per test) because:
 * - Audit operations involve timeline store state
 * - Tests modify table structure (insert rows, edit cells)
 * - Need clean DuckDB state for reliable assertions
 */
test.describe('Audit Row Tracking After Structural Changes', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // Extended timeout for audit + WASM operations
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
      console.error('[audit-row-tracking] Page crashed during test')
    })

    // Initialize page objects
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)

    await page.goto('/')
    await inspector.waitForDuckDBReady()

    // Disable edit batching for immediate cell edit commits
    await inspector.disableEditBatching()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test('audit drill-down shows correct row numbers after row insertion', async () => {
    /**
     * Regression test for commit 9b68947: Dynamic row numbers in audit drill-down
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Edit cell in row 3 (Bob -> "Bob Edited")
     * 3. Insert a new row above row 3 (Bob shifts to row 4)
     * 4. Open audit log, click on the earlier edit entry
     * 5. Verify the row number shows 4 (updated), not 3 (stale)
     *
     * Before fix: The drill-down showed "Row 3" (stale value from edit time)
     * After fix: The drill-down shows "Row 4" (dynamic value reflecting current position)
     */

    // Load test data (basic-data.csv has 5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await inspector.waitForGridReady()

    // Step 1: Edit cell in row 3 (0-indexed: row 2) - "Bob Johnson" -> "Bob Edited"
    await laundromat.editCell(2, 1, 'Bob Edited')

    // Wait for edit to complete
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER) LIMIT 1 OFFSET 2'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Bob Edited')

    // Step 2: Insert a new row ABOVE row 3 (Jane Smith position, row index 1)
    // After insertion, Bob will shift from visual row 3 to visual row 4
    const grid = page.getByTestId('data-grid')
    const gridBounds = await grid.boundingBox()
    if (!gridBounds) throw new Error('Grid not found')

    // Click on row 3 marker (Bob's row, which is at index 2)
    await page.mouse.click(gridBounds.x + 20, gridBounds.y + 90)
    await expect(page.getByText('Insert Above')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Insert Above' }).click()

    // Wait for insert to complete - table now has 6 rows
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(6)

    // Verify Bob is now at visual row 4 (0-indexed: row 3)
    // Order should be: John(1), Jane(2), NEW(3), Bob(4), Alice(5), Charlie(6)
    const dataAfterInsert = await inspector.runQuery<{ name: string }>(
      'SELECT name FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER)'
    )
    expect(dataAfterInsert.length).toBe(6)
    expect(dataAfterInsert[3]?.name).toBe('Bob Edited') // Bob is now at index 3 (visual row 4)

    // Step 3: Open audit sidebar and find the Manual Edit entry
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Find the Manual Edit entry in the UI
    const manualEditEntry = sidebar
      .getByTestId('audit-entry-with-details')
      .filter({ hasText: /Manual Edit/i })
      .first()

    await expect(manualEditEntry).toBeVisible({ timeout: 10000 })

    // Step 4: Click to open the drill-down modal
    await manualEditEntry.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Wait for modal animation to complete (Radix UI pattern)
    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // Verify ManualEditDetailView is displayed
    await expect(page.getByTestId('manual-edit-detail-view')).toBeVisible({ timeout: 5000 })

    // Step 5: CRITICAL ASSERTION - Verify the row number shows 4 (not 3)
    // The ManualEditDetailView dynamically fetches row numbers using _cs_origin_id
    const rowCell = page.getByTestId('manual-edit-detail-row').first()
    await expect(rowCell).toBeVisible()

    // Check that "Row 4" is displayed (not "Row 3")
    // Using regex to be flexible with whitespace
    await expect(rowCell).toContainText(/Row\s+4/i)

    // Also verify the edit details are shown correctly
    await expect(page.getByTestId('manual-edit-detail-table')).toContainText('Bob Edited')
    await expect(page.getByTestId('manual-edit-detail-table')).toContainText('name')

    // Close modal
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('audit drill-down shows (deleted) for rows that no longer exist', async () => {
    /**
     * Test that audit entries for deleted rows show "(deleted)" indicator
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Edit cell in row 2 (Jane -> "Jane Edited")
     * 3. Delete row 2 (Jane's row)
     * 4. Open audit log, click on the earlier edit entry
     * 5. Verify the row shows "(deleted)" indicator
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await inspector.waitForGridReady()

    // Step 1: Edit cell in row 2 (0-indexed: row 1) - "Jane Smith" -> "Jane Edited"
    await laundromat.editCell(1, 1, 'Jane Edited')

    // Wait for edit to complete
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER) LIMIT 1 OFFSET 1'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Jane Edited')

    // Step 2: Delete row 2 (Jane's row)
    const grid = page.getByTestId('data-grid')
    const gridBounds = await grid.boundingBox()
    if (!gridBounds) throw new Error('Grid not found')

    // Click on row 2 marker (Jane's row, index 1)
    await page.mouse.click(gridBounds.x + 20, gridBounds.y + 70)

    // Wait for row action menu and click Delete
    await expect(page.getByRole('button', { name: 'Delete Row' })).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Delete Row' }).click()

    // Confirm deletion if there's a confirmation dialog
    const confirmDialog = page.getByRole('alertdialog')
    if (await confirmDialog.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirmDialog.getByRole('button', { name: /delete|confirm/i }).click()
    }

    // Wait for delete to complete - table now has 4 rows
    await expect.poll(async () => {
      const tables = await inspector.getTables()
      const table = tables.find(t => t.name === 'basic_data')
      return table?.rowCount
    }, { timeout: 10000 }).toBe(4)

    // Step 3: Open audit sidebar and find the Manual Edit entry
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Find the Manual Edit entry for Jane's edit (should be before the delete entry)
    // Look for the one that mentions "Jane Edited" or just the first Manual Edit
    const manualEditEntry = sidebar
      .getByTestId('audit-entry-with-details')
      .filter({ hasText: /Manual Edit/i })
      .first()

    await expect(manualEditEntry).toBeVisible({ timeout: 10000 })

    // Step 4: Click to open the drill-down modal
    await manualEditEntry.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Wait for modal animation
    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // Verify ManualEditDetailView is displayed
    await expect(page.getByTestId('manual-edit-detail-view')).toBeVisible({ timeout: 5000 })

    // Step 5: CRITICAL ASSERTION - Verify "(deleted)" is shown
    const rowCell = page.getByTestId('manual-edit-detail-row').first()
    await expect(rowCell).toBeVisible()

    // Check that "(deleted)" is displayed for the deleted row
    await expect(rowCell).toContainText(/\(deleted\)/i)

    // Verify the edit details still show the values
    await expect(page.getByTestId('manual-edit-detail-table')).toContainText('Jane Edited')

    // Close modal
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('multiple edits show correct dynamic row numbers after insertions', async () => {
    /**
     * Test that multiple edit entries all show correct updated row numbers
     *
     * Scenario:
     * 1. Load table with 5 rows
     * 2. Edit row 1 (John), row 3 (Bob), row 5 (Charlie)
     * 3. Insert a row at position 1
     * 4. All original edits should show row numbers +1
     */

    // Load test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await inspector.waitForGridReady()

    // Make 3 edits to rows 1, 3, 5 (indices 0, 2, 4)
    await laundromat.editCell(0, 1, 'John Edited')
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER) LIMIT 1'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('John Edited')

    await laundromat.editCell(2, 1, 'Bob Edited')
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER) LIMIT 1 OFFSET 2'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Bob Edited')

    await laundromat.editCell(4, 1, 'Charlie Edited')
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY CAST("_cs_id" AS INTEGER) LIMIT 1 OFFSET 4'
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Charlie Edited')

    // Insert a row at position 1 (above John)
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

    // After insert: NEW(1), John(2), Jane(3), Bob(4), Alice(5), Charlie(6)
    // Original edits were: John(was 1, now 2), Bob(was 3, now 4), Charlie(was 5, now 6)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Find all Manual Edit entries
    const manualEditEntries = sidebar.getByTestId('audit-entry-with-details').filter({ hasText: /Manual Edit/i })

    // We should have 3 edit entries (order may vary)
    const editCount = await manualEditEntries.count()
    expect(editCount).toBeGreaterThanOrEqual(3)

    // Click the first edit entry to verify row number logic works
    await manualEditEntries.first().click()

    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // The row number should be one of 2, 4, or 6 (the new positions)
    // Not 1, 3, or 5 (the old positions)
    const rowCell = page.getByTestId('manual-edit-detail-row').first()
    await expect(rowCell).toBeVisible()

    // Extract the row number text and verify it's an even number (2, 4, or 6)
    const rowText = await rowCell.textContent()
    const rowMatch = rowText?.match(/Row\s+(\d+)/i)
    expect(rowMatch).not.toBeNull()
    if (rowMatch) {
      const rowNum = parseInt(rowMatch[1], 10)
      // Row should be 2, 4, or 6 (shifted by +1)
      expect([2, 4, 6]).toContain(rowNum)
    }

    // Close modal
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })
})
