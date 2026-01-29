/**
 * Bug Reproduction Test: Manual edits lost when undoing through a transform
 *
 * Scenario:
 * 1. Manual Edit 1 (edit cell A)
 * 2. Transform (trim whitespace on a column)
 * 3. Manual Edit 2 (edit cell B)
 * 4. Undo Manual Edit 2 → Cell B should revert, dirty indicator gone
 * 5. Undo Transform → Transform should revert
 * 6. BUG: Manual Edit 1 is lost! Cell A shows original value instead of edited value
 * 7. Redo Transform → Transform reapplied
 * 8. Redo Manual Edit 2 → BUG: Manual Edit 2 is also lost!
 */

import { test, expect, type Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import * as fs from 'fs'
import * as path from 'path'

test.describe('Manual Edit Undo Through Transform', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector
  let tempFile: string

  // Use fresh page per test to avoid state pollution
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    inspector = createStoreInspector(page)

    await page.goto('/')
    await inspector.waitForDuckDBReady()
    // Disable edit batching for immediate audit log entries
    await inspector.disableEditBatching()

    // Clean up any existing test table
    await inspector.runQuery('DROP TABLE IF EXISTS undo_test')

    // Create temp CSV file with text data that has whitespace
    // Using a text-based column that won't be auto-parsed to a different type
    const csvContent = `id,name,description
1,Alice,  needs trim
2,Bob,  also needs trim
3,Charlie,  whitespace here  `

    const tempDir = path.join(process.cwd(), 'e2e', 'fixtures', 'csv')
    tempFile = path.join(tempDir, 'temp_undo_test.csv')
    fs.writeFileSync(tempFile, csvContent)
  })

  test.afterEach(async () => {
    // Cleanup temp file
    try {
      fs.unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }

    // Cleanup table
    try {
      await inspector.runQuery('DROP TABLE IF EXISTS undo_test')
    } catch {
      // Ignore cleanup errors
    }
    await page.close()
  })

  test('manual edits should persist when undoing through a transform', async () => {
    // Set longer timeout for this complex test
    test.setTimeout(120000)

    // ===== SETUP: Import test data =====
    await laundromat.uploadFile(tempFile)
    await wizard.waitForOpen()
    await wizard.import()
    // Table name will be derived from file name: temp_undo_test
    await inspector.waitForTableLoaded('temp_undo_test', 3)

    // Verify initial data
    const initialData = await inspector.runQuery<{ id: number; name: string; description: string }>(
      `SELECT id, name, description FROM temp_undo_test ORDER BY id`
    )
    expect(initialData[0].name).toBe('Alice')
    expect(initialData[1].name).toBe('Bob')
    // Verify description has leading/trailing whitespace
    expect(initialData[0].description).toContain('needs trim')

    // ===== STEP 1: Manual Edit 1 - Edit the name in row 1 =====
    // console.log('STEP 1: Manual Edit 1 - Editing name in row 1')

    // Edit row 1's name: Alice -> Alice_EDITED
    // Column 0 = id, Column 1 = name, Column 2 = description
    await laundromat.editCell(0, 1, 'Alice_EDITED')

    // Verify the edit was applied
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM temp_undo_test WHERE id = 1`
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Alice_EDITED')

    // console.log('Manual Edit 1 applied: Alice -> Alice_EDITED')

    // ===== STEP 2: Apply Transform (Trim Whitespace) =====
    // console.log('STEP 2: Applying Trim Whitespace transform')

    // Open the Clean panel and apply transform
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'description' })

    // Wait for transform to complete - description should be trimmed
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ description: string }>(
        `SELECT description FROM temp_undo_test WHERE id = 1`
      )
      return result[0]?.description
    }, { timeout: 15000 }).toBe('needs trim')

    // console.log('Transform applied: whitespace trimmed')

    // Close the panel
    await laundromat.closePanel()

    // Verify Manual Edit 1 still exists after transform
    const afterTransform = await inspector.runQuery<{ name: string }>(
      `SELECT name FROM temp_undo_test WHERE id = 1`
    )
    expect(afterTransform[0].name).toBe('Alice_EDITED')
    // console.log('Manual Edit 1 still present after transform')

    // ===== STEP 3: Manual Edit 2 - Edit the name in row 2 =====
    // console.log('STEP 3: Manual Edit 2 - Editing name in row 2')

    // Wait for grid to be ready after panel close (required per e2e guidelines)
    await inspector.waitForGridReady()

    // Edit row 2's name: Bob -> Bob_EDITED
    await laundromat.editCell(1, 1, 'Bob_EDITED')

    // Verify the edit was applied
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM temp_undo_test WHERE id = 2`
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Bob_EDITED')

    // console.log('Manual Edit 2 applied: Bob -> Bob_EDITED')

    // ===== STEP 4: Undo Manual Edit 2 =====
    // console.log('STEP 4: Undo Manual Edit 2')

    await page.keyboard.press('Control+z')

    // Verify Manual Edit 2 was undone
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM temp_undo_test WHERE id = 2`
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Bob')

    // console.log('Manual Edit 2 undone: Bob_EDITED -> Bob')

    // Verify Manual Edit 1 still exists
    const afterUndo2 = await inspector.runQuery<{ name: string }>(
      `SELECT name FROM temp_undo_test WHERE id = 1`
    )
    expect(afterUndo2[0].name).toBe('Alice_EDITED')
    // console.log('Manual Edit 1 still present after undoing Manual Edit 2')

    // ===== STEP 5: Undo Transform =====
    // console.log('STEP 5: Undo Transform')

    // Collect ALL console logs to understand what's happening during undo
    const consoleLogs: string[] = []
    page.on('console', msg => {
      const text = msg.text()
      // Capture relevant logs
      if (text.includes('[TIMELINE]') || text.includes('[REPLAY]') ||
          text.includes('[FastPath]') || text.includes('[Timeline]') ||
          text.includes('[Snapshot]') || text.includes('CRITICAL') ||
          text.includes('Error') || text.includes('error') ||
          msg.type() === 'error') {
        consoleLogs.push(`[${msg.type()}] ${text}`)
      }
    })

    // Also capture page errors
    page.on('pageerror', err => {
      consoleLogs.push(`[PAGE ERROR] ${err.message}`)
    })

    await page.keyboard.press('Control+z')

    // Wait for undo to complete - undo operations use isReplaying, not isLoading
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        // Wait for replay to complete
        return !state.isReplaying
      },
      { timeout: 15000 }
    )

    // Check if table exists
    let _tableExists = false
    try {
      const result = await inspector.runQuery<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM temp_undo_test`
      )
      // DuckDB returns BigInt for COUNT(*), so convert to Number for comparison
      _tableExists = Number(result[0]?.cnt) === 3
      // console.log('Table exists with', Number(result[0]?.cnt), 'rows')
    } catch {
      // console.log('Table does not exist')
    }

    // Wait for undo to complete - table may be briefly dropped during restore
    // Poll for the actual data we need (description with whitespace) rather than just table existence
    // This avoids race conditions where the table exists but data isn't fully restored
    let afterUndoDesc: { description: string }[] = []
    await expect.poll(async () => {
      try {
        afterUndoDesc = await inspector.runQuery<{ description: string }>(
          `SELECT description FROM temp_undo_test WHERE id = 1`
        )
        // After undo, should have leading/trailing whitespace again
        const desc = afterUndoDesc[0]?.description
        if (!desc) return false
        // Check that whitespace was restored (trim changes the value)
        return desc.trim() !== desc
      } catch {
        return false
      }
    }, { timeout: 15000, message: 'Transform should be undone (whitespace restored)' }).toBe(true)

    // Verify the description has whitespace (assertion for clarity)
    expect(afterUndoDesc[0]?.description?.trim()).not.toBe(afterUndoDesc[0]?.description)

    // console.log('Transform undone: whitespace restored')

    // ===== CRITICAL CHECK: Manual Edit 1 should STILL exist =====
    // console.log('CRITICAL CHECK: Manual Edit 1 should still exist after undoing transform')

    const afterUndoTransform = await inspector.runQuery<{ name: string }>(
      `SELECT name FROM temp_undo_test WHERE id = 1`
    )

    // THIS IS THE BUG: Manual Edit 1 is lost!
    // Expected: 'Alice_EDITED' (the manual edit should persist)
    // Actual (bug): 'Alice' (reverted to original)
    expect(afterUndoTransform[0].name).toBe('Alice_EDITED')

    // console.log('Manual Edit 1 persisted after undoing transform')

    // ===== STEP 6: Redo Transform =====
    // console.log('STEP 6: Redo Transform')

    await page.keyboard.press('Control+y')

    // Wait for transform to be redone (description should be trimmed again)
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ description: string }>(
        `SELECT description FROM temp_undo_test WHERE id = 1`
      )
      return result[0]?.description
    }, { timeout: 15000 }).toBe('needs trim')

    // console.log('Transform redone')

    // Manual Edit 1 should still exist after redo transform
    const afterRedoTransform = await inspector.runQuery<{ name: string }>(
      `SELECT name FROM temp_undo_test WHERE id = 1`
    )
    expect(afterRedoTransform[0].name).toBe('Alice_EDITED')

    // ===== STEP 7: Redo Manual Edit 2 =====
    // console.log('STEP 7: Redo Manual Edit 2')

    await page.keyboard.press('Control+y')

    // Manual Edit 2 should be restored
    await expect.poll(async () => {
      const result = await inspector.runQuery<{ name: string }>(
        `SELECT name FROM temp_undo_test WHERE id = 2`
      )
      return result[0]?.name
    }, { timeout: 10000 }).toBe('Bob_EDITED')

    // console.log('Manual Edit 2 redone: Bob -> Bob_EDITED')

    // Final verification: both edits should be present
    const finalState = await inspector.runQuery<{ id: number; name: string; description: string }>(
      `SELECT id, name, description FROM temp_undo_test ORDER BY id`
    )

    expect(finalState[0].name).toBe('Alice_EDITED')
    expect(finalState[1].name).toBe('Bob_EDITED')
    expect(finalState[0].description).toBe('needs trim')

    // console.log('TEST PASSED: All manual edits persisted through undo/redo cycle')
  })
})
