import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Bug Regression Tests: Split Column Undo
 *
 * Verifies split_column undo removes all created columns.
 * Uses sentences with 5 words to create 5 split columns.
 */
test.describe('Bug: Split Column Undo', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.setTimeout(60000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await page.goto('/')
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try { await context.close() } catch { /* ignore */ }
  })

  test('undo removes all 5 split columns', async () => {
    // Import: sentence column has 5 words each
    await laundromat.uploadFile(getFixturePath('split-undo-test.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('split_undo_test', 3)

    // Verify initial: only id, sentence, category
    const before = await inspector.runQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'split_undo_test' ORDER BY column_name"
    )
    expect(before.map(c => c.column_name)).toEqual(['_cs_id', 'category', 'id', 'sentence'])

    // Split sentence by space -> creates sentence_1 through sentence_5
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Split Column')
    await picker.selectColumn('sentence')
    await picker.fillParam('Delimiter', ' ')
    await picker.apply()

    // Wait for 5 new columns
    await expect.poll(async () => {
      const cols = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'split_undo_test' AND column_name LIKE 'sentence_%'"
      )
      return cols.length
    }, { timeout: 10000 }).toBe(5)

    // Verify all 5 split columns exist
    const afterSplit = await inspector.runQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'split_undo_test' ORDER BY column_name"
    )
    expect(afterSplit.map(c => c.column_name)).toContain('sentence_1')
    expect(afterSplit.map(c => c.column_name)).toContain('sentence_5')

    // Close panel and undo
    await laundromat.closePanel()
    await page.getByTestId('undo-btn').click()
    await inspector.waitForReplayComplete()

    // CRITICAL: All 5 split columns should be gone
    await expect.poll(async () => {
      const cols = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'split_undo_test' AND column_name LIKE 'sentence_%'"
      )
      return cols.length
    }, { timeout: 10000, message: 'All split columns should be removed after undo' }).toBe(0)

    // Original data intact
    const data = await inspector.runQuery('SELECT sentence FROM split_undo_test ORDER BY id')
    expect(data[0].sentence).toBe('the quick brown fox jumps')
  })
})
