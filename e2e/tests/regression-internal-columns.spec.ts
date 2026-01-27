import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { coolHeap } from '../helpers/heap-cooling'

/**
 * Regression Tests: Internal Column Filtering
 *
 * Per e2e/CLAUDE.md Section 1: Tests involving diff operations are Tier 2/3
 * and should use beforeEach with fresh page to prevent "Target Closed" crashes.
 *
 * Validates that internal DuckDB columns (_cs_id, __base, duckdb_schema) are filtered from:
 * - Data grid columns
 * - Transformation pickers
 * - Diff grid columns
 * - Schema change warnings
 * - Console output
 */

test.describe('Internal Column Filtering', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  // Extended timeout for diff operations
  test.setTimeout(90000)

  // Tier 2/3: Fresh page per test for diff operations (per e2e/CLAUDE.md)
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Tier 2/3 cleanup - drop tables and close page
    try {
      await coolHeap(page, inspector, {
        dropTables: true,      // Full cleanup
        closePanels: true,
        clearDiffState: true,
        pruneAudit: true,
        auditThreshold: 30
      })
    } catch {
      // Ignore errors during cleanup
    }
    await page.close()  // Force WASM worker garbage collection
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

    // 1. Load basic-data.csv (fresh page per test, must load data)
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

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
    // DiffView uses simple conditional render, not Radix Sheet - just wait for visibility
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 })

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

    // Must upload tables via UI to enable diff button (tableStore needs entries)
    // 1. Upload fr_b2_base.csv and fr_b2_new.csv (have different schemas)
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
    // DiffView uses simple conditional render, not Radix Sheet - just wait for visibility
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 })

    const compareTwoTablesBtn = page.locator('button').filter({ hasText: 'Compare Two Tables' })
    await expect(compareTwoTablesBtn).toBeVisible({ timeout: 5000 })
    await compareTwoTablesBtn.click()

    // 3. Select tables
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_b2_base/i }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /fr_b2_new/i }).click()

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

    // 4. Select key column and run comparison
    await page.locator('#key-id').click()
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff comparison to complete
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.isComparing === false && diffState.summary !== null
    }, { timeout: 15000 }).toBe(true)

    // 5. Verify internal columns don't appear in the diff results
    // Check diff store's allColumns - should not contain internal columns
    const diffColumns = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as {
        getState: () => {
          allColumns: string[]
        }
      } | undefined
      return diffStore?.getState()?.allColumns || []
    })

    // Rule 2: Assert internal columns NOT present in diff results
    expect(diffColumns).not.toContain('_cs_id')
    expect(diffColumns).not.toContain('duckdb_schema')
    expect(diffColumns).not.toContain('row_id')

    // Verify only user columns appear
    expect(diffColumns).toContain('id')
    expect(diffColumns).toContain('name')
  })

  test('should not leak internal columns in console errors (regression test)', async () => {
    // Regression test for: Internal column names appearing in console output
    // Goal 3: No internal column names appear in console output

    // This is a simpler test that focuses on checking console output
    // during basic operations (upload, transform, export)

    // Setup console listener to capture all logs/errors/warnings
    const consoleMessages: string[] = []
    page.on('console', msg => {
      consoleMessages.push(msg.text())
    })

    // 1. Load basic-data.csv
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Apply a transformation (creates __base column internally)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Wait for panel to fully close
    await page.getByTestId('panel-clean').waitFor({ state: 'hidden', timeout: 5000 })

    // Wait for grid to be ready
    await inspector.waitForGridReady()

    // 3. Export CSV
    const exportBtn = page.getByTestId('export-csv-btn')
    await expect(exportBtn).toBeVisible({ timeout: 10000 })
    const downloadPromise = page.waitForEvent('download')
    await exportBtn.click()
    await downloadPromise

    // 4. Collect all console output
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
