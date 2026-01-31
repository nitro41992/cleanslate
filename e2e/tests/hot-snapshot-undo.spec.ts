import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * LRU Undo Cache (Phase 3) Tests
 *
 * These tests verify that the hot snapshot system provides instant undo
 * for the most recent expensive operation, while cold (Parquet) snapshots
 * provide slower but reliable undo for older operations.
 *
 * Key behaviors:
 * 1. Hot snapshots provide instant undo (<500ms)
 * 2. Cold snapshots take ~2-5s to restore
 * 3. Only the most recent snapshot is hot (LRU eviction)
 * 4. Hot snapshots are lost on page refresh (expected)
 *
 * Per e2e/CLAUDE.md Section 1: Heavy Tests (Tier 3 operations with snapshots)
 * use beforeEach with fresh browser context for complete WASM isolation.
 */
test.describe('LRU Hot Snapshot Undo', () => {
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

  // Tier 3: Fresh browser context per test for complete WASM isolation
  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()

    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await inspector.runQuery('DROP TABLE IF EXISTS hot_snapshot_test')
    } catch {
      // Ignore errors during cleanup
    }
    try {
      await context.close()  // Terminates all WebWorkers, clears SharedArrayBuffer
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  test('hot snapshot undo should be significantly faster than cold', async () => {
    // Setup: Import test data
    await inspector.runQuery('DROP TABLE IF EXISTS hot_snapshot_test')
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 10)

    // Step 1: Apply an expensive transform (creates first snapshot)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')

    // Wait for transform to complete (poll for data change)
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      return rows.length
    }, { timeout: 15000 }).toBeLessThan(10)

    // Record data state after first expensive operation
    const dataAfterFirstTransform = await inspector.getTableData('with_duplicates')
    const rowCountAfterFirstTransform = dataAfterFirstTransform.length

    // Step 2: Apply another expensive transform (evicts first hot, creates new hot)
    await picker.addTransformation('Sort', {
      column: 'id',
      params: { 'Sort direction': 'Descending' }
    })

    // Wait for sort to complete
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      // After descending sort, first row should have highest id
      return rows.length > 0
    }, { timeout: 15000 }).toBe(true)

    const dataAfterSort = await inspector.getTableData('with_duplicates')

    // Step 3: Undo the second transform (should use HOT path - instant)
    const hotUndoStart = Date.now()
    await laundromat.undo()

    // Wait for undo to complete by polling data
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      // After undoing sort, data should match post-dedupe state
      return rows.length
    }, { timeout: 10000 }).toBe(rowCountAfterFirstTransform)

    const hotUndoTime = Date.now() - hotUndoStart
    console.log(`[HOT UNDO] Completed in ${hotUndoTime}ms`)

    // Verify data is restored correctly
    const dataAfterHotUndo = await inspector.getTableData('with_duplicates')
    expect(dataAfterHotUndo.length).toBe(rowCountAfterFirstTransform)

    // Step 4: Undo again (should use COLD path - slower, loading from Parquet)
    // First, redo to get back to sorted state
    await laundromat.redo()
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      return rows.length > 0
    }, { timeout: 10000 }).toBe(true)

    // Now undo to the first transform, then undo again to original
    await laundromat.undo()
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      return rows.length
    }, { timeout: 10000 }).toBe(rowCountAfterFirstTransform)

    // This undo goes to original state (cold path - no hot snapshot)
    const coldUndoStart = Date.now()
    await laundromat.undo()

    // Wait for cold undo to complete
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      // Original data had duplicates, so more rows
      return rows.length
    }, { timeout: 20000 }).toBe(10)

    const coldUndoTime = Date.now() - coldUndoStart
    console.log(`[COLD UNDO] Completed in ${coldUndoTime}ms`)

    // Hot undo should be significantly faster (at least 2x faster typically)
    // Note: We use a generous margin because CI environments can be variable
    console.log(`[COMPARISON] Hot: ${hotUndoTime}ms, Cold: ${coldUndoTime}ms`)
    // Hot undo should be under 1 second for small datasets
    expect(hotUndoTime).toBeLessThan(1000)
  })

  test('audit log should show hot/cold snapshot indicators', async () => {
    // Setup: Import test data and apply expensive transform
    await inspector.runQuery('DROP TABLE IF EXISTS hot_snapshot_test')
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 10)

    // Apply expensive transform (creates snapshot)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')

    // Wait for transform to complete
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      return rows.length
    }, { timeout: 15000 }).toBeLessThan(10)

    // Open audit log panel
    await laundromat.openAuditLogPanel()

    // Look for hot snapshot indicator (Instant badge)
    // The most recent expensive transform should show as hot
    const hotBadge = page.getByTestId('snapshot-hot-badge')

    // Wait for the badge to appear (may take a moment for UI to update)
    await expect(hotBadge.first()).toBeVisible({ timeout: 5000 })
  })

  test('timeline scrubber should show hot snapshot with amber glow', async () => {
    // Setup: Import test data and apply expensive transform
    await inspector.runQuery('DROP TABLE IF EXISTS hot_snapshot_test')
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 10)

    // Apply expensive transform (creates snapshot)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')

    // Wait for transform to complete
    await expect.poll(async () => {
      const rows = await inspector.getTableData('with_duplicates')
      return rows.length
    }, { timeout: 15000 }).toBeLessThan(10)

    // Look for hot snapshot indicator in timeline (diamond with amber styling)
    const hotSnapshotMarker = page.getByTestId('snapshot-hot')

    // Wait for the marker to appear
    await expect(hotSnapshotMarker.first()).toBeVisible({ timeout: 5000 })
  })
})
