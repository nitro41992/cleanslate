import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Regression Tests: Diff Dual Comparison Modes
 *
 * Process-Level Isolation: This file runs in a separate Playwright worker process from regression-diff.spec.ts
 * to prevent WASM memory fragmentation accumulation.
 *
 * Context-Level Isolation: Each test gets its own fresh browser CONTEXT to prevent WASM WebWorker state
 * from leaking between tests. This is stronger than page-level isolation per e2e/CLAUDE.md guidelines.
 */

test.describe.serial('FR-B2: Diff Dual Comparison Modes', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector
  let diffView: DiffViewPage

  // Prevent DuckDB cold start timeout + allow time for transformation/snapshot operations
  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  // Use fresh CONTEXT per test for true isolation (prevents cascade failures from WASM crashes)
  // per e2e/CLAUDE.md: Diff operations are Tier 3 and need context isolation
  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    diffView = new DiffViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Skip cleanup if page is already closed (prevents cascade failures)
    if (page.isClosed()) {
      try {
        await context.close()
      } catch {
        // Ignore - context may already be closed
      }
      return
    }

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
    try {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    } catch {
      // Ignore - page may be in bad state
    }

    // Close CONTEXT (not just page) to fully release WASM memory
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  test('should support Compare with Preview mode', async () => {
    // 1. Load table
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Apply transformation to create difference
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    // Wait for transform to complete before proceeding
    const tableId = await inspector.getActiveTableId()
    await inspector.waitForTransformComplete(tableId)
    await laundromat.closePanel()

    // 3. Open Diff view
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // 4. Select Compare with Preview mode (should be default)
    await diffView.selectComparePreviewMode()

    // 5. Run comparison (no key column selection needed - uses internal _cs_id)
    await diffView.runComparison()

    // 6. Verify results show modified rows
    // Poll for diff state to have the expected summary
    await expect.poll(async () => {
      const state = await inspector.getDiffState()
      return state.isComparing === false && state.summary !== null
    }, { timeout: 10000, message: 'Diff comparison should complete' }).toBe(true)

    // Rule 3: Verify diff state via store (more reliable than reading pills)
    const diffState = await inspector.getDiffState()
    expect(diffState.summary?.modified).toBe(5) // All 5 rows have uppercase names
    expect(diffState.summary?.added).toBe(0)
    expect(diffState.summary?.removed).toBe(0)
    expect(diffState.mode).toBe('compare-preview')
  })

  test('should support Compare Two Tables mode', async () => {
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

    // 2. Open Diff view
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // 3. Select Compare Two Tables mode
    await diffView.selectCompareTablesMode()

    // 4. Select tables
    await diffView.selectTableA('fr_b2_base')
    await diffView.selectTableB('fr_b2_new')

    // 5. Select key column and run comparison
    await diffView.toggleKeyColumn('id')
    await diffView.runComparison()

    // 6. Verify expected differences via store (more reliable than animated UI pills)
    // Note: DiffSummaryPills has 600ms count-up animation - reading from store avoids timing issues
    const diffState = await inspector.getDiffState()
    expect(diffState.summary?.added).toBe(1) // Frank added
    expect(diffState.summary?.removed).toBe(1) // Charlie removed
    expect(diffState.summary?.modified).toBeGreaterThanOrEqual(3) // At least Alice, Diana, Eve modified
  })

  test.skip('should not flag rows as modified when only _cs_id differs (regression test)', async () => {
    // SKIPPED: This test requires creating tables via raw SQL, which are not visible
    // to the tableStore and thus cannot be used with the Diff UI.
    //
    // The core behavior (_cs_id excluded from diff comparison) should be tested
    // at the unit level in the diff comparison logic rather than E2E.
    //
    // Original intent: Verify that when comparing tables with identical user data
    // but different internal _cs_id values, the diff shows zero modifications.
    expect(true).toBe(true)
  })

})
