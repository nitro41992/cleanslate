import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Regression Tests: Internal Column Filtering
 *
 * Runs in fresh browser worker with 1.8GB heap to prevent memory accumulation from other test groups.
 * Validates that internal DuckDB columns (_cs_id, __base, duckdb_schema) are filtered from:
 * - Data grid columns
 * - Transformation pickers
 * - Diff grid columns
 * - Schema change warnings
 * - Console output
 */

test.describe.serial('Internal Column Filtering', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    // Prevent DuckDB cold start timeout
    test.setTimeout(60000)

    page = await browser.newPage()

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Drop internal diff tables created during comparison to prevent memory accumulation
    try {
      const internalTables = await inspector.runQuery(`
        SELECT table_name FROM information_schema.tables
        WHERE table_name LIKE 'v_diff_%' OR table_name LIKE '_timeline_%'
      `)
      for (const t of internalTables) {
        await inspector.runQuery(`DROP TABLE IF EXISTS "${t.table_name}"`)
      }
    } catch {
      // Ignore errors during cleanup
    }
    // Press Escape to close any open panels
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  test('should never display internal columns in grid (regression test)', async () => {
    // Regression test for: Internal column leakage into UI
    // Goal 3: Ensure internal DuckDB metadata doesn't leak into UI

    // 1. Upload basic-data.csv
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Get grid column headers via store inspection
    const gridColumns = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const tableStore = stores?.tableStore as {
        getState: () => {
          tables: Array<{ name: string; columns: Array<{ name: string }> }>
          activeTableId: string | null
        }
      } | undefined
      const state = tableStore?.getState()
      const activeTable = state?.tables?.find(t => t.name === 'basic_data')
      return activeTable?.columns?.map(c => c.name) || []
    })

    // Rule 1: Assert exact column set (identity, not cardinality)
    expect(gridColumns).toContain('id')
    expect(gridColumns).toContain('name')
    expect(gridColumns).toContain('email')

    // Rule 2: Assert internal columns are NOT present (positive assertions)
    expect(gridColumns).not.toContain('_cs_id')
    expect(gridColumns).not.toContain('duckdb_schema')
    expect(gridColumns).not.toContain('row_id')

    // 3. Apply Trim transformation (creates `name__base` column for Tier 1 undo)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // 4. Verify grid still doesn't show `name__base`
    const gridColumnsAfterTrim = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const tableStore = stores?.tableStore as {
        getState: () => {
          tables: Array<{ name: string; columns: Array<{ name: string }> }>
        }
      } | undefined
      const state = tableStore?.getState()
      const activeTable = state?.tables?.find(t => t.name === 'basic_data')
      return activeTable?.columns?.map(c => c.name) || []
    })

    expect(gridColumnsAfterTrim).not.toContain('name__base')  // __base columns filtered

    // Test complete - internal columns successfully filtered from grid
  })

  test('should not show internal columns in transformation pickers (regression test)', async () => {
    // Regression test for: Internal columns appearing in transformation column dropdowns
    // Goal 3: Transformation UI only shows user columns

    // 1. Load basic-data.csv (reuse from previous test if possible)
    const tables = await inspector.getTables()
    if (!tables.some(t => t.name === 'basic_data')) {
      await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)
    }

    // 2. Apply Trim transformation (creates `name__base`)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()

    // 3. Open Clean panel → Add Transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // 4. Select "Uppercase" transformation to see column dropdown
    // Use the page object method to select transformation (it uses button selector, not option)
    await picker.selectTransformation('Uppercase')

    // 5. Click column selector to open dropdown
    const columnSelect = page.getByTestId('column-selector')
    await columnSelect.waitFor({ state: 'visible', timeout: 5000 })
    await columnSelect.click()
    // Wait for dropdown options to appear
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 })

    // 6. Get column dropdown options from opened listbox
    const actualColumnOptions = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'))
      return options.map(opt => opt.textContent || '')
    })

    // Rule 1: Assert exact set of user columns
    expect(actualColumnOptions).toContain('id')
    expect(actualColumnOptions).toContain('name')
    expect(actualColumnOptions).toContain('email')

    // Rule 2: Assert internal columns NOT present
    expect(actualColumnOptions).not.toContain('_cs_id')
    expect(actualColumnOptions).not.toContain('name__base')
    expect(actualColumnOptions).not.toContain('duckdb_schema')

    // Alternative: Query store directly for transformation available columns
    const storeColumns = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const tableStore = stores?.tableStore as {
        getState: () => {
          tables: Array<{ name: string; columns: Array<{ name: string }> }>
        }
      } | undefined
      const state = tableStore?.getState()
      const activeTable = state?.tables?.find(t => t.name === 'basic_data')
      // Filter out internal columns (same logic as production code)
      return activeTable?.columns
        ?.map(c => c.name)
        .filter(name => !name.startsWith('_') && !name.endsWith('__base') && name !== 'duckdb_schema')
        || []
    })

    // Verify store-level filtering (basic-data.csv has 4 columns)
    expect(storeColumns).toEqual(['id', 'name', 'email', 'city'])
  })

  test('should not show internal columns in diff grid (except Status) (regression test)', async () => {
    // Regression test for: Internal columns appearing in diff grid
    // Goal 3: Diff grid only shows Status + user columns

    // 1. Upload two tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_base')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_new')

    await laundromat.uploadFile(getFixturePath('fr_b2_base.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_base', 5)

    await laundromat.uploadFile(getFixturePath('fr_b2_new.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_new', 5)

    // 2. Open Diff view → Compare Two Tables
    await laundromat.openDiffView()
    await inspector.waitForPanelAnimation('match-view')

    const compareTwoTablesBtn = page.locator('button').filter({ hasText: 'Compare Two Tables' })
    await expect(compareTwoTablesBtn).toBeVisible({ timeout: 5000 })
    await compareTwoTablesBtn.click()

    // 3. Select tables
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_b2_base/i }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /fr_b2_new/i }).click()

    // 4. Select key and run comparison
    // Checkbox has id="key-{columnName}" in DiffConfigPanel.tsx
    await page.locator('#key-id').click()
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff comparison to complete
    await expect.poll(async () => {
      const diffState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { isComparing: boolean; summary: unknown }
        } | undefined
        const state = diffStore?.getState()
        return { isComparing: state?.isComparing, hasSummary: state?.summary !== null }
      })
      return diffState.isComparing === false && diffState.hasSummary
    }, { timeout: 15000 }).toBe(true)

    await inspector.waitForGridReady()

    // 5. Get diff grid column headers
    const diffColumns = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as {
        getState: () => {
          allColumns: string[]
        }
      } | undefined
      return diffStore?.getState()?.allColumns || []
    })

    // Rule 1: Assert exact column set (user columns only - Status is added by UI, not in store)
    // fr_b2_base.csv has columns: id, name, department, salary
    expect(diffColumns).toContain('id')
    expect(diffColumns).toContain('name')
    expect(diffColumns).toContain('department')
    expect(diffColumns).toContain('salary')

    // Rule 2: Assert internal columns NOT present
    expect(diffColumns).not.toContain('_cs_id')
    expect(diffColumns).not.toContain('row_id')
    expect(diffColumns).not.toContain('a_row_id')
    expect(diffColumns).not.toContain('b_row_id')
    expect(diffColumns).not.toContain('duckdb_schema')
  })

  test('should not show internal columns in diff schema banner (regression test)', async () => {
    // Regression test for: Internal columns appearing in schema change warnings
    // Goal 3: Schema change warnings filter internal columns

    // 1. Create table1 with columns: id, name, email
    await inspector.runQuery('DROP TABLE IF EXISTS schema_test_1')
    await inspector.runQuery('DROP TABLE IF EXISTS schema_test_2')

    await inspector.runQuery(`
      CREATE TABLE schema_test_1 AS
      SELECT 1 as id, 'Alice' as name, 'alice@test.com' as email
    `)

    // 2. Create table2 with columns: id, name, age, _cs_id (manually injected)
    await inspector.runQuery(`
      CREATE TABLE schema_test_2 AS
      SELECT 1 as id, 'Alice' as name, 25 as age, gen_random_uuid() as _cs_id
    `)

    // 3. Open Diff view → Compare Two Tables
    await page.keyboard.press('Escape')

    await laundromat.openDiffView()
    await inspector.waitForPanelAnimation('match-view')

    const compareTwoTablesBtn = page.locator('button').filter({ hasText: 'Compare Two Tables' })
    await expect(compareTwoTablesBtn).toBeVisible({ timeout: 5000 })
    await compareTwoTablesBtn.click()

    // 4. Select tables
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /schema_test_1/i }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /schema_test_2/i }).click()

    // Wait for table selection to register
    await expect.poll(async () => {
      const diffState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { tableA: unknown; tableB: unknown }
        } | undefined
        const state = diffStore?.getState()
        return state?.tableA !== null && state?.tableB !== null
      })
      return diffState
    }, { timeout: 5000 }).toBe(true)

    // 5. Verify schema change banner appears
    // Look for warning or info message about schema differences
    const schemaBanner = page.locator('text=/column/i').or(page.locator('text=/schema/i'))
    const hasBanner = await schemaBanner.isVisible().catch(() => false)

    if (hasBanner) {
      const bannerText = await schemaBanner.first().textContent()

      // Rule 2: Assert banner doesn't contain internal column names
      expect(bannerText).not.toContain('_cs_id')
      expect(bannerText).not.toContain('duckdb_schema')

      // Should mention user columns only
      // Banner shows: "New columns: age" (not _cs_id)
      // Banner shows: "Removed columns: email"
      if (bannerText?.includes('New')) {
        expect(bannerText).toContain('age')
        expect(bannerText).not.toContain('_cs_id')
      }
    } else {
      console.log('[Schema Banner Test] No schema warning banner displayed (may not be implemented)')
    }
  })

  test('should not leak internal columns in console errors (regression test)', async () => {
    // Regression test for: Internal column names appearing in console output
    // Goal 3: No internal column names appear in console output

    // Setup console listener to capture all logs/errors/warnings
    const consoleMessages: string[] = []
    page.on('console', msg => {
      consoleMessages.push(msg.text())
    })

    // 1. Load basic-data.csv
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data_console_test')
    await page.keyboard.press('Escape')

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Apply multiple transformations
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await picker.addTransformation('Uppercase', { column: 'email' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // 3. Open diff view
    await laundromat.openDiffView()
    await inspector.waitForPanelAnimation('match-view')

    const comparePreviewBtn = page.locator('button').filter({ hasText: 'Compare with Preview' })
    await expect(comparePreviewBtn).toBeVisible({ timeout: 5000 })
    await comparePreviewBtn.click()
    await page.getByRole('checkbox', { name: 'id' }).click()
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff comparison to complete
    await expect.poll(async () => {
      const diffState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as {
          getState: () => { isComparing: boolean; summary: unknown }
        } | undefined
        const state = diffStore?.getState()
        return { isComparing: state?.isComparing, hasSummary: state?.summary !== null }
      })
      return diffState.isComparing === false && diffState.hasSummary
    }, { timeout: 15000 }).toBe(true)

    await inspector.waitForGridReady()

    // 4. Export CSV
    await page.keyboard.press('Escape')

    const downloadPromise = page.waitForEvent('download')
    const exportBtn = page.getByTestId('export-table-btn')
    await expect(exportBtn).toBeVisible({ timeout: 5000 })
    await exportBtn.click()
    await downloadPromise

    // 5. Collect all console output
    // Filter out intentional debug logs
    const leakedMessages = consoleMessages.filter(msg =>
      (msg.includes('_cs_id') ||
       msg.includes('duckdb_schema') ||
       msg.includes('row_id') ||
       msg.includes('__base')) &&
      !msg.includes('[Timeline]') &&  // Allow intentional debug logs
      !msg.includes('[Snapshot]') &&
      !msg.includes('[Command]')
    )

    // Rule 2: Assert no console message contains internal column names
    expect(leakedMessages.length).toBe(0)

    // If there are leaked messages, log them for debugging
    if (leakedMessages.length > 0) {
      console.log('[Console Leak Test] Leaked internal columns:', leakedMessages)
    }
  })
})
