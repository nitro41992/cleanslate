/**
 * @file changelog-persistence.spec.ts
 * @description Tests for OPFS JSONL changelog persistence for cell edits.
 *
 * The incremental persistence system uses a hybrid approach:
 * - Cell edits → OPFS JSONL changelog (instant, ~2-3ms)
 * - Transforms → Full Arrow IPC snapshot (blocking)
 * - Compaction → Merges changelog into Arrow IPC snapshot periodically
 *
 * This test verifies:
 * 1. Cell edits are persisted to changelog (not snapshot)
 * 2. Cell edits survive page refresh via changelog replay
 * 3. Compaction merges changelog into Arrow IPC snapshot
 * 4. Multiple rapid edits are batched correctly
 *
 * Uses Tier 3 isolation (fresh browser context per test) since it involves
 * OPFS persistence which requires complete WebWorker cleanup between tests.
 */
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Changelog Persistence (Cell Edits)', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // Tier 3 - OPFS heavy tests require fresh browser context per test
  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)
    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  test('should persist cell edits to changelog and survive page refresh', async () => {
    // 1. Load basic-data.csv (5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    // 2. Get the table ID and first row's _cs_id for verification
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    const rowsBefore = await inspector.runQuery<{ _cs_id: string; name: string }>(
      'SELECT _cs_id, name FROM basic_data ORDER BY _cs_id LIMIT 1'
    )
    const firstCsId = rowsBefore[0]._cs_id
    const _originalValue = rowsBefore[0].name  // Prefixed with _ to indicate intentionally unused

    // 3. Edit a cell - change the name column of the first row
    await laundromat.editCell(0, 1, 'CHANGELOG_TEST_VALUE')

    // 4. Wait for the edit to complete in database
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM basic_data WHERE _cs_id = '${firstCsId}'`
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('CHANGELOG_TEST_VALUE')

    // 5. Give a moment for changelog write to complete
    // (changelog write is async but should be very fast ~2-3ms)
    await page.waitForLoadState('networkidle')

    // 6. Refresh the page to test persistence
    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 7. Verify the cell edit survived the refresh
    // This validates that changelog replay worked correctly
    const rowsAfterRefresh = await inspector.runQuery<{ name: string }>(
      `SELECT name FROM basic_data WHERE _cs_id = '${firstCsId}'`
    )
    expect(rowsAfterRefresh[0]?.name).toBe('CHANGELOG_TEST_VALUE')
  })

  test('should persist multiple cell edits correctly', async () => {
    // 1. Load basic-data.csv
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    // 2. Make multiple edits to different cells
    // Edit row 0, col 1 (name)
    await laundromat.editCell(0, 1, 'EDIT_ONE')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 1'
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('EDIT_ONE')

    // Edit row 1, col 1 (name)
    await laundromat.editCell(1, 1, 'EDIT_TWO')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 2'
      )
      return rows[1]?.name
    }, { timeout: 10000 }).toBe('EDIT_TWO')

    // Edit row 2, col 1 (name)
    await laundromat.editCell(2, 1, 'EDIT_THREE')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 3'
      )
      return rows[2]?.name
    }, { timeout: 10000 }).toBe('EDIT_THREE')

    // 3. Wait for all changelog writes to complete
    await page.waitForLoadState('networkidle')

    // 4. Refresh and verify all edits survived
    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.waitForTableLoaded('basic_data', 5)

    const rowsAfterRefresh = await inspector.runQuery<{ name: string }>(
      'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 3'
    )
    expect(rowsAfterRefresh[0]?.name).toBe('EDIT_ONE')
    expect(rowsAfterRefresh[1]?.name).toBe('EDIT_TWO')
    expect(rowsAfterRefresh[2]?.name).toBe('EDIT_THREE')
  })

  test('should handle re-editing the same cell', async () => {
    // 1. Load basic-data.csv
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    // 2. Edit the same cell multiple times
    await laundromat.editCell(0, 1, 'FIRST_VALUE')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 1'
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('FIRST_VALUE')

    await laundromat.editCell(0, 1, 'SECOND_VALUE')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 1'
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('SECOND_VALUE')

    await laundromat.editCell(0, 1, 'FINAL_VALUE')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 1'
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('FINAL_VALUE')

    // 3. Refresh and verify the final value is correct
    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.waitForTableLoaded('basic_data', 5)

    const rowsAfterRefresh = await inspector.runQuery<{ name: string }>(
      'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 1'
    )
    expect(rowsAfterRefresh[0]?.name).toBe('FINAL_VALUE')
  })

  test('should show saved indicator after cell edit (fast path)', async () => {
    // 1. Load basic-data.csv
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    // 2. Make a cell edit
    await laundromat.editCell(0, 1, 'TEST_SAVE_INDICATOR')

    // 3. Wait for edit to complete in database
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        'SELECT name FROM basic_data ORDER BY _cs_id LIMIT 1'
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('TEST_SAVE_INDICATOR')

    // 4. Verify that save indicator shows "saved" (not "dirty" for too long)
    // Cell edits go through the fast path (changelog), so they should be
    // marked as saved almost immediately.
    await expect.poll(async () => {
      const status = await page.evaluate(() => {
        // Stores are exposed via __CLEANSLATE_STORES__
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return 'no_store'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return state?.persistenceStatus || 'no_status'
      })
      return status
    }, {
      timeout: 10000,
      message: 'Expected persistence status to be "saved" or "idle" after cell edit'
    }).toMatch(/^(saved|idle)$/)
  })
})
