import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
// import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Regression Tests: Diff Core Functionality
 *
 * Process-Level Isolation: This file runs in a separate Playwright worker process from regression-diff-modes.spec.ts.
 * Contains lightweight diff tests (2 tests, 5 rows) and heavy regression test (1 test, 100 rows).
 * Dual comparison mode tests moved to regression-diff-modes.spec.ts for independent memory allocation.
 */

test.describe.serial('FR-B2: Visual Diff - Lightweight', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    // Prevent DuckDB cold start timeout
    test.setTimeout(60000)

    page = await browser.newPage()

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('should detect row changes between two tables', async () => {
    // Load a table first (diff button disabled on empty state)
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Open diff view via panel-based navigation (single-page app)
    await laundromat.openDiffView()

    // Verify diff view loads
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 })
  })

  test('should identify added, removed, and modified rows', async () => {
    // Close diff view to upload files
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('diff-view')).toBeHidden({ timeout: 5000 })

    // Clean up any existing tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_base')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_new')

    // Upload first file (base)
    await laundromat.uploadFile(getFixturePath('fr_b2_base.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_base', 5)

    // Upload second file (new)
    await laundromat.uploadFile(getFixturePath('fr_b2_new.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_new', 5)

    // Open diff view via panel-based navigation
    await laundromat.openDiffView()

    // Explicitly select "Compare Two Tables" mode (previous tests may have left it in "Compare with Preview" mode)
    await page.locator('button').filter({ hasText: 'Compare Two Tables' }).click()

    // Wait for mode switch to register in store
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.mode
    }, { timeout: 5000 }).toBe('compare-tables')

    // Fail-fast guard: Assert diff comparison UI exists (requires 2+ tables)
    await expect(page.getByTestId('diff-compare-btn')).toBeVisible({ timeout: 5000 })

    // Select tables and key column
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'fr_b2_base' }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: 'fr_b2_new' }).click()

    // Select id as key column
    await page.getByRole('checkbox', { name: 'id' }).click()

    // Run comparison
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff results to appear - look for the summary pills
    await expect(page.getByTestId('diff-pill-added')).toBeVisible({ timeout: 10000 })

    // Verify diff found expected changes via pill values
    // Expected: 1 added (Frank), 1 removed (Charlie), some modified rows
    const addedPill = page.getByTestId('diff-pill-added')
    const removedPill = page.getByTestId('diff-pill-removed')
    const modifiedPill = page.getByTestId('diff-pill-modified')

    // Check pill values - look for the number span
    await expect(addedPill.locator('span').first()).toContainText('1')
    await expect(removedPill.locator('span').first()).toContainText('1')
    // Modified should have some rows
    const modifiedText = await modifiedPill.locator('span').first().textContent()
    expect(parseInt(modifiedText || '0')).toBeGreaterThan(0)

    // Rule 3: Verify diff state in store
    const diffState = await inspector.getDiffState()
    expect(diffState.summary).toBeDefined()
    expect(diffState.summary?.added).toBe(1)
    expect(diffState.summary?.removed).toBe(1)
  })
})

test.describe('FR-B2: Visual Diff - Heavy Regression', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // Extended timeout for heavy diff tests
  test.setTimeout(90000)

  // Tier 3: Fresh page per test for heavy operations (per e2e/CLAUDE.md)
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await page.close()
  })

  test('should show all diff statuses (100 rows) (regression test)', async () => {
    // Regression test for: Diff correctly identifies Added, Modified, Removed rows
    // Goal: Validate functionality works correctly (minimal dataset for fast execution)

    // Close diff view to upload files (use dismissOverlays helper for robustness)
    await laundromat.dismissOverlays()
    await expect(page.getByTestId('diff-view')).toBeHidden({ timeout: 5000 })

    // Generate minimal overlapping data
    const generateOverlappingCSV = (startId: number, endId: number, prefix: string): string => {
      const lines = ['id,name,email']
      for (let i = startId; i <= endId; i++) {
        lines.push(`${i},${prefix}_User_${i},${prefix.toLowerCase()}_user${i}@example.com`)
      }
      return lines.join('\n')
    }

    // Base: rows 1-100
    const baseCSV = generateOverlappingCSV(1, 100, 'Base')
    // New: rows 10-110 (overlap 10-100, remove 1-9, add 101-110)
    const newCSV = generateOverlappingCSV(10, 110, 'New')

    // console.log(`[Diff Test] Generated Base CSV: ${(baseCSV.length / (1024 * 1024)).toFixed(2)}MB`)
    // console.log(`[Diff Test] Generated New CSV: ${(newCSV.length / (1024 * 1024)).toFixed(2)}MB`)

    // Clean up any existing tables
    await inspector.runQuery('DROP TABLE IF EXISTS diff_base_100')
    await inspector.runQuery('DROP TABLE IF EXISTS diff_new_110')

    // Upload base file - use helper to write temp file first
    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())

    const baseFilePath = path.join(tmpDir, 'diff_base_100.csv')
    await fs.writeFile(baseFilePath, baseCSV)

    await laundromat.uploadFile(baseFilePath)
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('diff_base_100', 100)

    // Upload new file
    const newFilePath = path.join(tmpDir, 'diff_new_110.csv')
    await fs.writeFile(newFilePath, newCSV)

    await laundromat.uploadFile(newFilePath)
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('diff_new_110', 101)  // 10-110 inclusive = 101 rows

    // Open Diff view
    await laundromat.openDiffView()
    // DiffView uses simple conditional render, not Radix Sheet - just wait for visibility
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 })

    // Select Compare Two Tables mode
    await page.locator('button').filter({ hasText: 'Compare Two Tables' }).click()

    // Wait for mode switch to register in store
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.mode
    }, { timeout: 5000 }).toBe('compare-tables')

    // Select tables
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /diff_base_100/i }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /diff_new_110/i }).click()

    // Select id as key column
    await page.getByRole('checkbox', { name: 'id' }).click()

    // Run comparison
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff comparison to complete
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.isComparing === false && diffState.summary !== null
    }, { timeout: 15000 }).toBe(true)

    // Verify diff summary
    const summary = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as {
        getState: () => {
          summary: { added: number; removed: number; modified: number; unchanged: number } | null
        }
      } | undefined
      return diffStore?.getState()?.summary || null
    })

    // Rule 1: Assert exact counts (identity, not cardinality)
    // Base: 1-100 | New: 10-110
    // Removed: 1-9 (9 rows)
    // Added: 101-110 (10 rows)
    // Modified: 10-100 (91 rows - all have different names/emails)
    expect(summary).not.toBeNull()
    expect(summary?.added).toBe(10)        // Rows 101-110 (new rows)
    expect(summary?.removed).toBe(9)       // Rows 1-9 (deleted rows)
    expect(summary?.modified).toBe(91)     // Rows 10-100 have different names/emails
    expect(summary?.unchanged).toBe(0)     // No unchanged rows (all overlapping rows were modified)

    // Verify diff pills show correct numbers
    const addedPill = page.getByTestId('diff-pill-added')
    const removedPill = page.getByTestId('diff-pill-removed')
    const modifiedPill = page.getByTestId('diff-pill-modified')

    await expect(addedPill.locator('span').first()).toContainText('10')
    await expect(removedPill.locator('span').first()).toContainText('9')
    await expect(modifiedPill.locator('span').first()).toContainText('91')

    // Rule 3: Verify grid visually shows green/red/yellow rows correctly
    // (Canvas grid, so we verify store state instead of DOM)
    const diffState = await inspector.getDiffState()
    expect(diffState.summary?.added).toBe(10)
    expect(diffState.summary?.removed).toBe(9)
    expect(diffState.summary?.modified).toBe(91)

    // Cleanup temp files
    await fs.unlink(baseFilePath).catch(() => {})
    await fs.unlink(newFilePath).catch(() => {})
  })
})
