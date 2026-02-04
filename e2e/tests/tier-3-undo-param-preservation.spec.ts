import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Bug Regression Tests: Tier 3 Undo Parameter Preservation
 *
 * These tests verify that custom command parameters survive the timeline
 * replay system. When a Tier 3 command is undone, all commands are replayed
 * from a snapshot. Parameters like length=9 for pad_zeros MUST be preserved.
 *
 * Pattern:
 * 1. Apply transform with non-default params
 * 2. Apply unrelated transform (creates timeline entry)
 * 3. Undo the unrelated transform (triggers replay)
 * 4. Verify via SQL that original params are preserved
 *
 * Per e2e/CLAUDE.md Section 1: Heavy Tests (Tier 3 operations with snapshots)
 * use beforeEach with fresh CONTEXT to prevent "Target Closed" crashes from WASM.
 */
test.describe('Bug: Tier 3 Undo Parameter Preservation', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  // Extended timeout for Tier 3 operations (snapshots + replay)
  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  // Tier 3: Fresh CONTEXT per test for complete WASM isolation (per e2e/CLAUDE.md)
  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()

    // Capture browser console logs for debugging
    page.on('console', _msg => {
      // Uncomment to see replay/timeline logs during debugging:
      // const text = _msg.text()
      // if (text.includes('[REPLAY]') || text.includes('[TIMELINE]')) {
      //   console.log(`[BROWSER] ${text}`)
      // }
    })

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()

    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Tier 3 cleanup - drop tables and close context
    try {
      await inspector.runQuery('DROP TABLE IF EXISTS undo_param_test')
      await inspector.runQuery('DROP TABLE IF EXISTS param_preservation_base')
    } catch {
      // Ignore errors during cleanup
    }
    try {
      await context.close()  // Terminates all pages + WebWorkers for complete WASM cleanup
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  // TEST: Verifies pad_zeros length parameter preservation during timeline replay after undo.
  test('pad zeros params should persist after unrelated rename undo', async () => {
    // Setup: Import test data
    await inspector.runQuery('DROP TABLE IF EXISTS undo_param_test')
    await laundromat.uploadFile(getFixturePath('undo-param-test.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('undo_param_test', 3)

    // Step 1: Apply pad zeros with length=9 to account_number
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Pad Zeros', {
      column: 'account_number',
      params: { 'Target length': '9' }  // CRITICAL: Use 9, not default 5. Label matches UI config.
    })

    // Wait for transformation to complete (SQL polling, not fixed timeout)
    await expect.poll(async () => {
      const rows = await inspector.getTableData('undo_param_test')
      return rows[0]?.account_number
    }, { timeout: 10000 }).toBe('000000123')

    // Verify all rows have 9 digits
    const dataBefore = await inspector.getTableData('undo_param_test')
    // console.log('[TEST] Data after pad zeros:', dataBefore)
    expect(dataBefore[0].account_number).toBe('000000123')
    expect(dataBefore[1].account_number).toBe('000000456')
    expect(dataBefore[2].account_number).toBe('000000789')

    // Debug: Check what params are stored in the timeline
    const timelineParams = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timelineStore = stores?.timelineStore as any
      const state = timelineStore?.getState?.()
      if (!state?.timelines) return { error: 'no timelines' }

      // Get the first timeline
      const timelines = state.timelines as Map<string, { commands: Array<{ params: unknown }> }>
      for (const [, timeline] of timelines) {
        if (timeline.commands.length > 0) {
          const padZerosCmd = timeline.commands[0]
          return {
            commandParams: padZerosCmd.params,
            commandCount: timeline.commands.length
          }
        }
      }
      return { error: 'no commands' }
    })
    console.log('[TEST] Timeline params after pad_zeros:', JSON.stringify(timelineParams, null, 2))

    // Close panel before applying next transform to avoid WASM pressure
    await laundromat.closePanel()
    await page.getByTestId('panel-clean').waitFor({ state: 'hidden', timeout: 3000 })

    // Step 2: Rename DIFFERENT column (name → customer_name)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Rename Column', {
      column: 'name',
      params: { 'New column name': 'customer_name' }
    })

    // Verify rename worked (SQL polling)
    await expect.poll(async () => {
      const schema = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'undo_param_test' ORDER BY column_name"
      )
      return schema.map(c => c.column_name)
    }, { timeout: 5000 }).toContain('customer_name')

    // Close picker
    await laundromat.closePanel()

    // Wait for panel to fully close (state-aware)
    await page.getByTestId('panel-clean').waitFor({ state: 'hidden', timeout: 5000 })

    // Verify data is still correct before undo
    const _dataBeforeUndo = await inspector.runQuery(
      'SELECT account_number FROM undo_param_test ORDER BY id'
    )
    // console.log('[TEST] Data BEFORE undo (should be 9 zeros):', _dataBeforeUndo)

    // Step 3: Undo the rename
    // console.log('[TEST] Clicking Undo button to undo rename...')
    await page.getByTestId('undo-btn').waitFor({ state: 'visible', timeout: 5000 })
    await laundromat.clickUndo()

    // Wait for undo to complete (column 'name' should exist again)
    await expect.poll(async () => {
      const schema = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'undo_param_test' ORDER BY column_name"
      )
      return schema.map(c => c.column_name)
    }, { timeout: 5000 }).toContain('name')

    // CRITICAL: Wait for Heavy Path replay to complete
    // The undo triggers a snapshot restore + replay of all commands from that point.
    // Without this wait, we may read data from the snapshot (before pad_zeros replay).
    await inspector.waitForReplayComplete()

    // CRITICAL ASSERTIONS: Verify data still has 9 zeros (NOT 5!)
    // Use polling to ensure replay has fully propagated to DuckDB
    await expect.poll(async () => {
      const rows = await inspector.runQuery(
        'SELECT account_number FROM undo_param_test ORDER BY id'
      )
      return rows[0]?.account_number
    }, { timeout: 15000, message: 'Pad zeros should preserve length=9 after undo replay' }).toBe('000000123')

    // Layer 1: Direct DuckDB query (bypass UI entirely)
    const dataAfterUndo = await inspector.runQuery(
      'SELECT account_number FROM undo_param_test ORDER BY id'
    )
    // console.log('[TEST] Data after undo (direct SQL):', dataAfterUndo)

    // Assert exact values (identity, not just length)
    expect(dataAfterUndo[0].account_number).toBe('000000123')  // NOT '00123'
    expect(dataAfterUndo[1].account_number).toBe('000000456')  // NOT '00456'
    expect(dataAfterUndo[2].account_number).toBe('000000789')  // NOT '00789'

    // Layer 2: Verify via getTableData with explicit ordering
    const gridData = await inspector.runQuery('SELECT * FROM undo_param_test ORDER BY id')
    // console.log('[TEST] Data via SQL (ordered by id):', gridData)
    expect(gridData[0].account_number).toBe('000000123')
  })
})

// Additional parameterized tests can be added here following the same pattern as above.
// For now, the core pad_zeros test verifies the parameter preservation fix works.
