import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Diff Filtering Tests
 *
 * Tests for diff view filtering functionality:
 * 1. Diff shows all rows with changes (including new column values)
 * 2. Status pill filtering (Added, Removed, Modified)
 * 3. Column-level filtering
 *
 * Uses Tier 3 isolation (fresh browser context per test) because:
 * - Diff operations are memory-intensive
 * - Tests modify table structure (add columns)
 * - Need clean DuckDB state for reliable assertions
 */
test.describe('Diff View Filtering', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let diffView: DiffViewPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  // Extended timeout for diff + transformation operations
  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Tier 3: Fresh context per test for complete WASM isolation
    context = await browser.newContext()
    page = await context.newPage()

    // Initialize page objects
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    diffView = new DiffViewPage(page)
    picker = new TransformationPickerPage(page)
    inspector = createStoreInspector(page)

    await page.goto('/')
    await inspector.waitForDuckDBReady()
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

  test('should show rows with new column values in diff (Calculate Age adds age column)', async () => {
    /**
     * Scenario: Apply "Calculate Age" transformation which adds a new 'age' column
     * Expected: All rows should appear in diff as "modified" because they have new column values
     *
     * This tests the fix for: "diff only shows rows when data was modified,
     * columns added through transformations are missing from diff"
     */

    // Load test data with birth_date column
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_dates_split')
    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)

    // Get active table ID for later
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Apply Calculate Age transformation (adds 'age' column)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Calculate Age', {
      column: 'birth_date',
    })
    await inspector.waitForTransformComplete(tableId!)

    // Verify the 'age' column was added
    const columnsAfter = await inspector.getTableColumns('fr_a3_dates_split')
    const columnNames = columnsAfter.map(c => c.name)
    expect(columnNames).toContain('age')

    // Open Diff View (Compare with Preview mode - compares current vs original)
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // Should already be in "Compare with Preview" mode by default
    // Run comparison (no key column needed for preview mode)
    await diffView.runComparison()

    // Get summary directly from store (not animated UI values)
    // The UI has a 600ms count-up animation that can cause flaky reads
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

    // CRITICAL ASSERTION: All 5 rows should show as modified because they have new 'age' values
    // Before fix: summary.modified was 0 (rows with only new column values were marked 'unchanged')
    // After fix: summary.modified should be 5 (all rows have non-NULL age values)
    expect(summary.modified).toBe(5)
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)

    // The grid should have rows visible (totalDiffRows > 0)
    const gridRowCount = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as { getState: () => { totalDiffRows: number } } | undefined
      return diffStore?.getState()?.totalDiffRows ?? 0
    })
    expect(gridRowCount).toBe(5)
  })

  test('should show rows with new formula column values in diff (Formula Builder)', async () => {
    /**
     * Scenario: Apply Formula Builder to create a new column
     * Expected: All rows should appear in diff as "modified" because they have new column values
     *
     * This tests that Formula Builder preserves _cs_origin_id for proper diff matching.
     * Bug: Formula Builder was dropping _cs_origin_id, causing diff to fail with:
     *   "Binder Error: Values list "b" does not have a column named "_cs_origin_id""
     */

    // Load test data
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Apply Formula Builder to create a new column (LEN of name column)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Switch to Formula Builder tab (it's a separate tab, not a transform tile)
    const formulaTab = page.getByRole('tab', { name: 'Formula Builder' })
    await formulaTab.click()

    // Wait for the formula editor to render (placeholder starts with "e.g., IF(")
    const formulaTextarea = page.locator('textarea[placeholder*="IF(" i]')
    await formulaTextarea.waitFor({ state: 'visible', timeout: 5000 })

    // Fill in the formula using type() for reliable React state updates
    await formulaTextarea.click()
    await formulaTextarea.fill('LEN(@name)')

    // Fill in the output column name
    await page.locator('#new-column-name').fill('name_length')

    // Wait for the apply button to be enabled (formula validation runs async)
    const applyFormulaBtn = page.getByTestId('apply-formula-btn')
    await expect(applyFormulaBtn).toBeEnabled({ timeout: 10000 })

    // Apply the formula
    await applyFormulaBtn.click()

    // Wait for the "Applying..." state to complete
    await expect(applyFormulaBtn).not.toContainText('Applying', { timeout: 30000 })
    await inspector.waitForTransformComplete(tableId!)

    // Verify the column was added
    const columnsAfter = await inspector.getTableColumns('basic_data')
    expect(columnsAfter.map(c => c.name)).toContain('name_length')

    // Verify the formula calculation is correct (John Doe = 8 chars)
    // Note: DuckDB's LEN() returns BigInt, so we convert to Number for comparison
    const rows = await inspector.runQuery('SELECT name, name_length FROM basic_data ORDER BY name')
    expect(Number(rows.find((r: { name: string }) => r.name === 'Alice Brown')?.name_length)).toBe(11)
    expect(Number(rows.find((r: { name: string }) => r.name === 'John Doe')?.name_length)).toBe(8)

    // Open Diff View
    await laundromat.openDiffView()
    await diffView.waitForOpen()
    await diffView.runComparison()

    // Wait for diff to complete
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { summary: { added: number; removed: number; modified: number } | null }
        } | undefined
        return diffStore?.getState()?.summary
      })
      return state
    }, { timeout: 10000 }).not.toBeNull()

    const diffState = await inspector.getDiffState()
    const summary = diffState.summary!

    // CRITICAL: All rows should be modified because they have new column values
    // Before fix: diff would fail with "_cs_origin_id not found" error
    // After fix: summary.modified should be 5 (all rows have non-NULL name_length values)
    expect(summary.modified).toBe(5)
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)

    // The grid should have rows visible (totalDiffRows > 0)
    const gridRowCount = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as { getState: () => { totalDiffRows: number } } | undefined
      return diffStore?.getState()?.totalDiffRows ?? 0
    })
    expect(gridRowCount).toBe(5)
  })

  test('should filter by status when clicking summary pills', async () => {
    /**
     * Scenario: Load two tables with known differences, run diff, click status pills
     * Expected: Clicking a pill should filter the grid to show only rows with that status
     */

    // Clean up and load test tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_base')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_new')

    // Upload base table
    await laundromat.uploadFile(getFixturePath('fr_b2_base.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_base', 5)

    // Upload new table
    await laundromat.uploadFile(getFixturePath('fr_b2_new.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_new', 5)

    // Open Diff View
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // Switch to "Compare Two Tables" mode
    await page.locator('button').filter({ hasText: 'Compare Two Tables' }).click()

    // Wait for mode switch
    await expect.poll(async () => {
      const state = await inspector.getDiffState()
      return state.mode
    }, { timeout: 5000 }).toBe('compare-tables')

    // Select tables using combobox pattern (matches working regression tests)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'fr_b2_base' }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: 'fr_b2_new' }).click()

    // Select id as key column
    await page.getByRole('checkbox', { name: 'id' }).click()

    // Run comparison
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff to complete and get summary from store (not animated UI)
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => {
            isComparing: boolean
            summary: { added: number; removed: number; modified: number } | null
          }
        } | undefined
        const s = diffStore?.getState()
        return s?.isComparing === false && s?.summary !== null
      })
      return state
    }, { timeout: 30000 }).toBe(true)

    // Get summary from store
    const diffState = await inspector.getDiffState()
    const summary = diffState.summary!
    expect(summary.added).toBeGreaterThan(0)
    expect(summary.removed).toBeGreaterThan(0)
    expect(summary.modified).toBeGreaterThan(0)

    // === Test 1: Click "Added" pill ===
    const addedPill = page.getByTestId('diff-pill-added')
    await addedPill.click()

    // Verify filter is active (pill should have data-active="true")
    await expect(addedPill).toHaveAttribute('data-active', 'true')

    // Verify statusFilter in store
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as { getState: () => { statusFilter: string[] | null } } | undefined
        return diffStore?.getState()?.statusFilter
      })
      return state
    }, { timeout: 5000 }).toEqual(['added'])

    // === Test 2: Click "Removed" pill (should toggle, adding to filter) ===
    const removedPill = page.getByTestId('diff-pill-removed')
    await removedPill.click()

    // Both should be active now
    await expect(addedPill).toHaveAttribute('data-active', 'true')
    await expect(removedPill).toHaveAttribute('data-active', 'true')

    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as { getState: () => { statusFilter: string[] | null } } | undefined
        return diffStore?.getState()?.statusFilter
      })
      return state?.sort()
    }, { timeout: 5000 }).toEqual(['added', 'removed'])

    // === Test 3: Click "Added" again to deselect it ===
    await addedPill.click()

    // Only "Removed" should be active
    await expect(addedPill).toHaveAttribute('data-active', 'false')
    await expect(removedPill).toHaveAttribute('data-active', 'true')

    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as { getState: () => { statusFilter: string[] | null } } | undefined
        return diffStore?.getState()?.statusFilter
      })
      return state
    }, { timeout: 5000 }).toEqual(['removed'])

    // === Test 4: Clear filters ===
    const clearFiltersButton = page.getByRole('button', { name: /Clear Filters/i })
    await clearFiltersButton.click()

    // All pills should be inactive (statusFilter should be null)
    await expect.poll(async () => {
      const state = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as { getState: () => { statusFilter: string[] | null } } | undefined
        return diffStore?.getState()?.statusFilter
      })
      return state
    }, { timeout: 5000 }).toBeNull()
  })

  test('should filter by column when selecting from column dropdown', async () => {
    /**
     * Scenario: Load two tables with multiple modified columns, filter by specific column
     * Expected: Column filter should show only rows where that specific column changed
     */

    // Create test data with multiple columns that have different changes
    const baseCSV = `id,name,email,status
1,Alice,alice@test.com,active
2,Bob,bob@test.com,active
3,Charlie,charlie@test.com,active
4,Diana,diana@test.com,active
5,Eve,eve@test.com,active`

    // Modified table:
    // - Row 1: name changed
    // - Row 2: email changed
    // - Row 3: both name and email changed
    // - Row 4: status changed
    // - Row 5: unchanged
    const newCSV = `id,name,email,status
1,Alice_Modified,alice@test.com,active
2,Bob,bob_modified@test.com,active
3,Charlie_Modified,charlie_modified@test.com,active
4,Diana,diana@test.com,inactive
5,Eve,eve@test.com,active`

    // Write temp files
    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())

    const baseFilePath = path.join(tmpDir, 'diff_col_filter_base.csv')
    const newFilePath = path.join(tmpDir, 'diff_col_filter_new.csv')
    await fs.writeFile(baseFilePath, baseCSV)
    await fs.writeFile(newFilePath, newCSV)

    try {
      // Clean up and load tables
      await inspector.runQuery('DROP TABLE IF EXISTS diff_col_filter_base')
      await inspector.runQuery('DROP TABLE IF EXISTS diff_col_filter_new')

      await laundromat.uploadFile(baseFilePath)
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('diff_col_filter_base', 5)

      await laundromat.uploadFile(newFilePath)
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('diff_col_filter_new', 5)

      // Open Diff View and configure
      await laundromat.openDiffView()
      await diffView.waitForOpen()
      await page.locator('button').filter({ hasText: 'Compare Two Tables' }).click()

      await expect.poll(async () => {
        const state = await inspector.getDiffState()
        return state.mode
      }, { timeout: 5000 }).toBe('compare-tables')

      // Select tables using combobox pattern
      await page.getByRole('combobox').first().click()
      await page.getByRole('option', { name: 'diff_col_filter_base' }).click()
      await page.getByRole('combobox').nth(1).click()
      await page.getByRole('option', { name: 'diff_col_filter_new' }).click()

      // Select id as key column
      await page.getByRole('checkbox', { name: 'id' }).click()

      // Run comparison
      await page.getByTestId('diff-compare-btn').click()

      // Wait for diff to complete
      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as {
            getState: () => { isComparing: boolean; summary: { modified: number; unchanged: number } | null }
          } | undefined
          const s = diffStore?.getState()
          return s?.isComparing === false && s?.summary !== null
        })
        return state
      }, { timeout: 30000 }).toBe(true)

      // Verify we have 4 modified rows (rows 1-4 have changes)
      const diffState = await inspector.getDiffState()
      const summary = diffState.summary!
      expect(summary.modified).toBe(4)
      expect(summary.unchanged).toBe(1)

      // === Test column filter: "name" column ===
      // Should show rows 1 and 3 (where name changed)
      // The column filter is a Select in the controls row - use the Controls row context
      // Note: After selection, the dropdown text changes to the selected option
      const getColumnFilterDropdown = () => page.locator('button[role="combobox"]').first()

      await getColumnFilterDropdown().click()
      await page.getByRole('option', { name: 'name' }).click()

      // Verify columnFilter is set in store
      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as { getState: () => { columnFilter: string | null } } | undefined
          return diffStore?.getState()?.columnFilter
        })
        return state
      }, { timeout: 5000 }).toBe('name')

      // The grid should now filter to show only rows where 'name' column changed
      // This requires the getRowsWithColumnChanges function to work correctly

      // === Test column filter: "email" column ===
      await getColumnFilterDropdown().click()
      await page.getByRole('option', { name: 'email' }).click()

      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as { getState: () => { columnFilter: string | null } } | undefined
          return diffStore?.getState()?.columnFilter
        })
        return state
      }, { timeout: 5000 }).toBe('email')

      // === Test: Clear column filter by selecting "All columns" ===
      await getColumnFilterDropdown().click()
      await page.getByRole('option', { name: 'All columns' }).click()

      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as { getState: () => { columnFilter: string | null } } | undefined
          return diffStore?.getState()?.columnFilter
        })
        return state
      }, { timeout: 5000 }).toBeNull()

    } finally {
      // Cleanup temp files
      await fs.unlink(baseFilePath).catch(() => {})
      await fs.unlink(newFilePath).catch(() => {})
    }
  })

  test('should show rows with removed column values in diff (two-tables mode)', async () => {
    /**
     * Scenario: Compare two tables where the base has a column that the new table doesn't
     * Expected: All rows should show as modified because they had values in the removed column
     *
     * This tests the inverse of new column addition - removed columns should
     * also cause rows to appear in the diff.
     */

    // Create test data - base table has an extra column
    const baseCSV = `id,name,email,extra_data
1,Alice,alice@test.com,extra1
2,Bob,bob@test.com,extra2
3,Charlie,charlie@test.com,extra3`

    // New table doesn't have the extra_data column
    const newCSV = `id,name,email
1,Alice,alice@test.com
2,Bob,bob@test.com
3,Charlie,charlie@test.com`

    // Write temp files
    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())

    const baseFilePath = path.join(tmpDir, 'diff_removed_col_base.csv')
    const newFilePath = path.join(tmpDir, 'diff_removed_col_new.csv')
    await fs.writeFile(baseFilePath, baseCSV)
    await fs.writeFile(newFilePath, newCSV)

    try {
      // Clean up and load tables
      await inspector.runQuery('DROP TABLE IF EXISTS diff_removed_col_base')
      await inspector.runQuery('DROP TABLE IF EXISTS diff_removed_col_new')

      await laundromat.uploadFile(baseFilePath)
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('diff_removed_col_base', 3)

      await laundromat.uploadFile(newFilePath)
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('diff_removed_col_new', 3)

      // Open Diff View and configure
      await laundromat.openDiffView()
      await diffView.waitForOpen()
      await page.locator('button').filter({ hasText: 'Compare Two Tables' }).click()

      await expect.poll(async () => {
        const state = await inspector.getDiffState()
        return state.mode
      }, { timeout: 5000 }).toBe('compare-tables')

      // Select tables
      await page.getByRole('combobox').first().click()
      await page.getByRole('option', { name: 'diff_removed_col_base' }).click()
      await page.getByRole('combobox').nth(1).click()
      await page.getByRole('option', { name: 'diff_removed_col_new' }).click()

      // Select id as key column
      await page.getByRole('checkbox', { name: 'id' }).click()

      // Run comparison
      await page.getByTestId('diff-compare-btn').click()

      // Wait for diff to complete
      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as {
            getState: () => { isComparing: boolean; summary: { modified: number } | null }
          } | undefined
          const s = diffStore?.getState()
          return s?.isComparing === false && s?.summary !== null
        })
        return state
      }, { timeout: 30000 }).toBe(true)

      // Get summary from store
      const diffState = await inspector.getDiffState()
      const summary = diffState.summary!

      // All 3 rows should show as modified because they had values in the removed column (extra_data)
      expect(summary.modified).toBe(3)
      expect(summary.added).toBe(0)
      expect(summary.removed).toBe(0)

    } finally {
      // Cleanup temp files
      await fs.unlink(baseFilePath).catch(() => {})
      await fs.unlink(newFilePath).catch(() => {})
    }
  })

  test('should show combined status and column filters working together', async () => {
    /**
     * Scenario: Apply both status filter and column filter simultaneously
     * Expected: Should show only rows matching BOTH filters
     */

    // Create test data
    const baseCSV = `id,name,email
1,Alice,alice@test.com
2,Bob,bob@test.com
3,Charlie,charlie@test.com`

    const newCSV = `id,name,email
1,Alice_Modified,alice@test.com
2,Bob,bob_modified@test.com
4,NewPerson,new@test.com`
    // Row 1: name changed (modified)
    // Row 2: email changed (modified)
    // Row 3: removed
    // Row 4: added

    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())

    const baseFilePath = path.join(tmpDir, 'diff_combined_filter_base.csv')
    const newFilePath = path.join(tmpDir, 'diff_combined_filter_new.csv')
    await fs.writeFile(baseFilePath, baseCSV)
    await fs.writeFile(newFilePath, newCSV)

    try {
      await inspector.runQuery('DROP TABLE IF EXISTS diff_combined_filter_base')
      await inspector.runQuery('DROP TABLE IF EXISTS diff_combined_filter_new')

      await laundromat.uploadFile(baseFilePath)
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('diff_combined_filter_base', 3)

      await laundromat.uploadFile(newFilePath)
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('diff_combined_filter_new', 3)

      await laundromat.openDiffView()
      await diffView.waitForOpen()
      await page.locator('button').filter({ hasText: 'Compare Two Tables' }).click()

      await expect.poll(async () => {
        const state = await inspector.getDiffState()
        return state.mode
      }, { timeout: 5000 }).toBe('compare-tables')

      // Select tables using combobox pattern
      await page.getByRole('combobox').first().click()
      await page.getByRole('option', { name: 'diff_combined_filter_base' }).click()
      await page.getByRole('combobox').nth(1).click()
      await page.getByRole('option', { name: 'diff_combined_filter_new' }).click()

      // Select id as key column
      await page.getByRole('checkbox', { name: 'id' }).click()

      // Run comparison
      await page.getByTestId('diff-compare-btn').click()

      // Wait for diff to complete
      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as {
            getState: () => { isComparing: boolean; summary: { added: number; removed: number; modified: number } | null }
          } | undefined
          const s = diffStore?.getState()
          return s?.isComparing === false && s?.summary !== null
        })
        return state
      }, { timeout: 30000 }).toBe(true)

      // Verify initial counts from store
      const diffState = await inspector.getDiffState()
      const summary = diffState.summary!
      expect(summary.added).toBe(1)    // Row 4
      expect(summary.removed).toBe(1)  // Row 3
      expect(summary.modified).toBe(2) // Rows 1, 2

      // Apply status filter: Modified only
      const modifiedPill = page.getByTestId('diff-pill-modified')
      await modifiedPill.click()
      await expect(modifiedPill).toHaveAttribute('data-active', 'true')

      // Apply column filter: 'name' column
      // Use first combobox in the controls row (after summary pills)
      const getColumnFilterDropdown = () => page.locator('button[role="combobox"]').first()
      await getColumnFilterDropdown().click()
      await page.getByRole('option', { name: 'name' }).click()

      // Verify both filters are active
      await expect.poll(async () => {
        const state = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const diffStore = stores?.diffStore as {
            getState: () => {
              statusFilter: string[] | null
              columnFilter: string | null
            }
          } | undefined
          return diffStore?.getState()
        })
        return {
          statusFilter: state?.statusFilter,
          columnFilter: state?.columnFilter
        }
      }, { timeout: 5000 }).toEqual({
        statusFilter: ['modified'],
        columnFilter: 'name',
      })

      // Now only Row 1 should be visible (modified + name column changed)
      // Row 2 is modified but email changed, not name
      // Rows 3 and 4 are removed/added, filtered out by status filter

    } finally {
      await fs.unlink(baseFilePath).catch(() => {})
      await fs.unlink(newFilePath).catch(() => {})
    }
  })
})
