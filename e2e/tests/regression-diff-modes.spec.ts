import { test, expect, Page, Browser } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { expectValidUuid } from '../helpers/high-fidelity-assertions'

/**
 * Regression Tests: Diff Dual Comparison Modes
 *
 * Process-Level Isolation: This file runs in a separate Playwright worker process from regression-diff.spec.ts
 * to prevent WASM memory fragmentation accumulation.
 *
 * Page-Level Isolation: Each test gets its own fresh browser page to prevent memory accumulation from
 * transformation snapshots and diff operations. This prevents "Target page, context or browser has been closed"
 * errors that occur when running multiple diff-heavy tests in sequence on the same page.
 */

test.describe.serial('FR-B2: Diff Dual Comparison Modes', () => {
  let browser: Browser
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

  test.beforeEach(async () => {
    // Create fresh page for each test to prevent memory accumulation
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    diffView = new DiffViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
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
    // Close page after each test to free memory
    await page.close()
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

    // 6. Verify expected differences
    const summary = await diffView.getSummary()
    expect(summary.added).toBe(1) // Frank added
    expect(summary.removed).toBe(1) // Charlie removed
    expect(summary.modified).toBeGreaterThanOrEqual(3) // At least Alice, Diana, Eve modified
  })

  test('should not flag rows as modified when only _cs_id differs (regression test)', async () => {
    // Regression test for: Internal columns causing false "MODIFIED" flags
    // Issue: Duplicating a table regenerates _cs_id, which should NOT cause modifications

    // 1. Clean up tables (use unique names to avoid regex collision)
    await inspector.runQuery('DROP TABLE IF EXISTS test_original')
    await inspector.runQuery('DROP TABLE IF EXISTS test_duplicate')

    // 2. Upload test data
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 3. Create tables with distinct names
    await inspector.runQuery(`
      CREATE TABLE test_original AS
      SELECT * FROM basic_data
    `)

    await inspector.runQuery(`
      CREATE TABLE test_duplicate AS
      SELECT gen_random_uuid() as _cs_id, id, name, email
      FROM test_original
    `)

    // 4. Verify _cs_id actually differs between tables
    const row1A = await inspector.runQuery('SELECT _cs_id FROM test_original WHERE id = 1')
    const row1B = await inspector.runQuery('SELECT _cs_id FROM test_duplicate WHERE id = 1')

    // Rule 2: Positive UUID validation before comparison (high-fidelity helper)
    expectValidUuid(row1A[0]._cs_id, { notEqual: row1B[0]._cs_id })

    // 5. Open Diff view
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // 6. Select Compare Two Tables mode
    await diffView.selectCompareTablesMode()

    // 7. Select tables
    await diffView.selectTableA('test_original')
    await diffView.selectTableB('test_duplicate')

    // 8. Select key column and run comparison
    await diffView.toggleKeyColumn('id')
    await diffView.runComparison()

    // 9. Verify: ZERO modifications (core fix validation)
    // Even though _cs_id differs, user data is identical
    const summary = await diffView.getSummary()
    expect(summary.modified).toBe(0) // ✅ Core fix: _cs_id excluded from value comparison
    expect(summary.unchanged).toBe(5)
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)

    // 10. Verify diff state in store
    const diffState = await inspector.getDiffState()
    expect(diffState.summary?.modified).toBe(0)
  })

  test('should preserve Original snapshot after multiple manual edits (regression test)', async () => {
    // Regression test for: Original snapshot preservation through manual edits
    // Issue: Eager timeline init ensures Original snapshot exists immediately after upload
    // Goal 1: Ensure we don't lose the "Original" state when doing manual edits

    // 1. Clean up and load data
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Get original data for later verification
    const originalData = await inspector.getTableData('basic_data')
    const originalRow0Name = originalData[0].name
    const originalRow1Email = originalData[1].email
    const originalRow2Name = originalData[2].name

    // 3. Apply 3 manual edits to different cells
    await laundromat.editCell(0, 1, 'EDITED_NAME_0')  // Row 0, col 1 (name)
    await inspector.waitForTransformComplete()
    await laundromat.editCell(1, 2, 'edited@test.com')  // Row 1, col 2 (email)
    await inspector.waitForTransformComplete()
    await laundromat.editCell(2, 1, 'EDITED_NAME_2')  // Row 2, col 1 (name)
    await inspector.waitForTransformComplete()

    // 4. Verify timeline has "Original" snapshot in store
    const timelineState = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const tableStore = stores?.tableStore as { getState: () => { activeTableId: string | null } } | undefined
      const activeTableId = tableStore?.getState()?.activeTableId

      const timelineStore = stores?.timelineStore as {
        getState: () => {
          timelines: Record<string, { snapshots: Array<{ name: string; type: string }> }>
        }
      } | undefined
      const timeline = timelineStore?.getState()?.timelines?.[activeTableId || '']

      return {
        hasOriginal: timeline?.snapshots?.some((s: { name: string }) => s.name.includes('original')) || false,
        snapshotCount: timeline?.snapshots?.length || 0,
      }
    })

    // Rule 1: Assert exact timeline state (high-fidelity)
    expect(timelineState.hasOriginal).toBe(true)
    expect(timelineState.snapshotCount).toBeGreaterThan(0)

    // 5. Open Diff view
    await laundromat.openDiffView()

    // 6. Verify diff button is enabled (not disabled)
    const isDiffButtonEnabled = await page.getByTestId('diff-compare-btn').isEnabled()
    expect(isDiffButtonEnabled).toBe(true)

    // 7. Verify diff opens instantly (< 1 second, no 3-second delay)
    const startTime = Date.now()
    await diffView.waitForOpen()
    const openDuration = Date.now() - startTime
    console.log(`[Diff Open Time] ${openDuration}ms`)
    expect(openDuration).toBeLessThan(1000)  // No 3-second IO wait

    // 8. Verify no IO Error in console (capture console messages)
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    // 9. Switch to "Compare with Preview" mode (should be default, but make explicit)
    await diffView.selectComparePreviewMode()

    // Wait for mode switch to register in store
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.mode
    }, { timeout: 5000 }).toBe('compare-preview')

    // 10. Run comparison (no key columns needed - uses _cs_id internally)
    await diffView.runComparison()

    // 11. Verify diff shows 3 modified rows (the edited ones)
    const summary = await diffView.getSummary()
    expect(summary.modified).toBe(3)
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
    expect(summary.unchanged).toBe(2)  // 5 total - 3 modified = 2 unchanged

    // 12. Verify no console errors containing "IO Error"
    const ioErrors = consoleErrors.filter(err => err.includes('IO Error') || err.includes('Access Handles'))
    expect(ioErrors.length).toBe(0)

    // 13. Verify diff state mode is 'compare-preview'
    const diffState = await inspector.getDiffState()
    expect(diffState.mode).toBe('compare-preview')

    // Rule 1: Assert exact row identities that were modified (not just count)
    // Verify previous/new values for the edited cells
    const auditEntries = await inspector.getAuditEntries()
    const editEntries = auditEntries.filter(e => e.action.includes('Manual Edit'))
    expect(editEntries.length).toBe(3)

    // Rule 2: Assert exact previous values (positive assertions)
    const edit0 = editEntries.find(e => e.rowIndex === 0)
    const edit1 = editEntries.find(e => e.rowIndex === 1)
    const edit2 = editEntries.find(e => e.rowIndex === 2)

    expect(edit0?.previousValue).toBe(originalRow0Name)
    expect(edit0?.newValue).toBe('EDITED_NAME_0')
    expect(edit1?.previousValue).toBe(originalRow1Email)
    expect(edit1?.newValue).toBe('edited@test.com')
    expect(edit2?.previousValue).toBe(originalRow2Name)
    expect(edit2?.newValue).toBe('EDITED_NAME_2')
  })
})
