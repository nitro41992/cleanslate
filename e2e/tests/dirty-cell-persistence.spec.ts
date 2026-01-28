/**
 * @file dirty-cell-persistence.spec.ts
 * @description Tests for dirty cell indicator (red triangle) persistence across page refresh.
 *
 * Bug: Dirty indicators on edited cells do not persist after page refresh.
 *
 * Root causes (both fixed):
 * 1. Zustand subscription race condition - the dirtyCells useMemo in DataGrid.tsx
 *    subscribed to getDirtyCellsAtPosition (function reference) which doesn't change when
 *    loadTimelines() restores state from OPFS. Fixed by subscribing to timeline object directly.
 *
 * 2. BigInt serialization mismatch - DuckDB returns _cs_id as BIGINT, but getTableDataWithRowIds()
 *    used type assertion `as string` instead of actual conversion. This caused csId to be stored
 *    as BigInt in cellChanges. After JSON serialization to app-state.json, the format was
 *    inconsistent (BigInt "1n" vs string "1"), causing dirty cell key comparison to fail.
 *    Fixed by using String() conversion in getTableDataWithRowIds().
 *
 * This test uses Tier 3 isolation (fresh browser context per test) since it involves
 * OPFS persistence which requires complete WebWorker cleanup between tests.
 */
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe('Dirty Cell Indicator Persistence', () => {
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

  test('should persist dirty cell indicators across page refresh', async () => {
    // 1. Load basic-data.csv (5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    // 2. Get the table ID for tracking
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // 3. Edit a cell - click on the name column (col 1) of the first row
    // First, we need to get the first row's _cs_id for verification later
    const rowsBefore = await inspector.runQuery<{ _cs_id: string; name: string }>(
      'SELECT _cs_id, name FROM basic_data ORDER BY _cs_id LIMIT 1'
    )
    const firstCsId = rowsBefore[0]._cs_id
    const originalValue = rowsBefore[0].name

    // Click on the cell to edit it
    // The grid is 0-indexed: col 0 is id, col 1 is name
    await laundromat.editCell(0, 1, 'EDITED_VALUE')

    // Wait for the edit to complete by polling database
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM basic_data WHERE _cs_id = '${firstCsId}'`
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('EDITED_VALUE')

    // Check timeline position to verify a command was recorded
    const timelinePos = await inspector.getTimelinePosition(tableId!)
    expect(timelinePos.total).toBeGreaterThan(0)

    // 4. Verify dirty cells in timeline store > 0 (poll for timing reliability)
    await expect.poll(async () => {
      const dirtyState = await inspector.getTimelineDirtyCells(tableId!)
      return dirtyState.count
    }, { timeout: 5000 }).toBeGreaterThan(0)

    const dirtyStateBefore = await inspector.getTimelineDirtyCells(tableId!)

    // Verify the cell key contains the csId and column name
    const expectedCellKey = `${firstCsId}:name`
    expect(dirtyStateBefore.dirtyCells).toContain(expectedCellKey)

    // 5. Flush OPFS and save app state to ensure persistence
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Wait for persistence to complete
    await inspector.waitForPersistenceComplete()

    // 6. Reload page and wait for hydration
    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()
    // Wait for timelines to be restored from OPFS (loadTimelines runs after initDuckDB)
    await inspector.waitForTimelinesRestored(tableId!)

    // Get the new tableId after reload (may have changed)
    const tableIdAfterReload = await inspector.getActiveTableId()

    // 7. Verify dirty cells in timeline store still > 0
    const dirtyStateAfter = await inspector.getTimelineDirtyCells(tableIdAfterReload!)
    expect(dirtyStateAfter.count).toBeGreaterThan(0)
    expect(dirtyStateAfter.dirtyCells.length).toBeGreaterThan(0)

    // 8. Verify the edited value persisted
    const rowsAfter = await inspector.runQuery<{ _cs_id: string; name: string }>(
      `SELECT _cs_id, name FROM basic_data WHERE name = 'EDITED_VALUE'`
    )
    expect(rowsAfter.length).toBe(1)
    expect(rowsAfter[0].name).toBe('EDITED_VALUE')

    // 9. Verify the EXACT cell key persists across reload
    // The csId should be identical before/after (Parquet preserves _cs_id values)
    // and the dirty cell tracking should find the same key
    const csIdAfterReload = rowsAfter[0]._cs_id
    expect(csIdAfterReload).toBe(firstCsId)
    expect(dirtyStateAfter.dirtyCells).toContain(`${csIdAfterReload}:name`)
  })

  test('should persist dirty cell indicators for scrolled-out-of-view cells', async () => {
    // Use with-duplicates.csv (5 rows) - tests that dirty cells persist even for cells not currently rendered
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('with_duplicates', 5)
    await inspector.waitForGridReady()

    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Edit the first row's name column
    const rowsBefore = await inspector.runQuery<{ _cs_id: string; name: string }>(
      'SELECT _cs_id, name FROM with_duplicates ORDER BY _cs_id LIMIT 1'
    )
    const firstCsId = rowsBefore[0]._cs_id

    await laundromat.editCell(0, 1, 'FIRST_ROW_EDIT')

    // Wait for the edit to complete by polling database
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM with_duplicates WHERE _cs_id = '${firstCsId}'`
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('FIRST_ROW_EDIT')

    // Verify dirty cell was recorded (poll for timing reliability)
    await expect.poll(async () => {
      const dirtyState = await inspector.getTimelineDirtyCells(tableId!)
      return dirtyState.count
    }, { timeout: 5000 }).toBe(1)

    const dirtyStateBefore = await inspector.getTimelineDirtyCells(tableId!)
    const expectedCellKey = `${firstCsId}:name`
    expect(dirtyStateBefore.dirtyCells).toContain(expectedCellKey)

    // Persist state
    await inspector.flushToOPFS()
    await inspector.saveAppState()
    await inspector.waitForPersistenceComplete()

    // Reload
    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.waitForTableLoaded('with_duplicates', 5)
    await inspector.waitForGridReady()
    // Wait for timelines to be restored from OPFS
    await inspector.waitForTimelinesRestored(tableId!)

    // Get the new tableId after reload (may have changed)
    const tableIdAfterReload = await inspector.getActiveTableId()

    // Verify dirty cells still tracked after reload
    const dirtyStateAfter = await inspector.getTimelineDirtyCells(tableIdAfterReload!)
    expect(dirtyStateAfter.count).toBe(1)
    // Verify it's still tracking the 'name' column
    const hasNameDirtyCell = dirtyStateAfter.dirtyCells.some(key => key.endsWith(':name'))
    expect(hasNameDirtyCell).toBe(true)
  })

  test('should persist multiple dirty cell indicators across refresh', async () => {
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Get first two rows' csIds
    const rows = await inspector.runQuery<{ _cs_id: string }>(
      'SELECT _cs_id FROM basic_data ORDER BY _cs_id LIMIT 2'
    )
    const firstCsId = rows[0]._cs_id
    const secondCsId = rows[1]._cs_id

    // Edit first cell and wait for it to complete
    await laundromat.editCell(0, 1, 'EDIT_1')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM basic_data WHERE _cs_id = '${firstCsId}'`
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('EDIT_1')

    // Edit second cell and wait for it to complete
    await laundromat.editCell(1, 1, 'EDIT_2')
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM basic_data WHERE _cs_id = '${secondCsId}'`
      )
      return rows[0]?.name
    }, { timeout: 10000 }).toBe('EDIT_2')

    // Verify both cells marked dirty (poll for timing reliability)
    await expect.poll(async () => {
      const dirtyState = await inspector.getTimelineDirtyCells(tableId!)
      return dirtyState.count
    }, { timeout: 5000 }).toBe(2)

    const dirtyStateBefore = await inspector.getTimelineDirtyCells(tableId!)
    expect(dirtyStateBefore.dirtyCells).toContain(`${firstCsId}:name`)
    expect(dirtyStateBefore.dirtyCells).toContain(`${secondCsId}:name`)

    // Persist and reload
    await inspector.flushToOPFS()
    await inspector.saveAppState()
    await inspector.waitForPersistenceComplete()

    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()
    // Wait for timelines to be restored from OPFS
    await inspector.waitForTimelinesRestored(tableId!)

    // Get the new tableId after reload (may have changed)
    const tableIdAfterReload = await inspector.getActiveTableId()

    // Verify both dirty cells still tracked
    const dirtyStateAfter = await inspector.getTimelineDirtyCells(tableIdAfterReload!)
    expect(dirtyStateAfter.count).toBe(2)
    // Verify both are for the 'name' column
    const nameDirtyCells = dirtyStateAfter.dirtyCells.filter(key => key.endsWith(':name'))
    expect(nameDirtyCells.length).toBe(2)
  })
})
