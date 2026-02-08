/**
 * E2E Tests: Row and Column Persistence
 *
 * Regression tests to ensure that:
 * 1. Newly inserted rows persist across page refresh
 * 2. Column order after drag-reorder persists across page refresh
 *
 * These tests use fresh browser contexts and proper OPFS flushing
 * to ensure reliable persistence testing.
 */

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

// 2 minute timeout for persistence tests (WASM + OPFS operations)
test.setTimeout(120000)

/**
 * Check if the browser supports OPFS with the File System Access API.
 */
async function checkOPFSSupport(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      if (typeof navigator.storage?.getDirectory !== 'function') return false
      const root = await navigator.storage.getDirectory()
      const testDir = await root.getDirectoryHandle('__opfs_test__', { create: true })
      const testFile = await testDir.getFileHandle('__test__.txt', { create: true })
      const writable = await testFile.createWritable()
      await writable.write('test')
      await writable.close()
      await testDir.removeEntry('__test__.txt')
      await root.removeEntry('__opfs_test__')
      return true
    } catch {
      return false
    }
  })
}

/**
 * Clean up OPFS test data (Arrow IPC snapshots)
 */
async function cleanupOPFSTestData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      await root.removeEntry('cleanslate', { recursive: true })
    } catch {
      // Ignore - directory may not exist
    }
  })
}

/**
 * Wait for the app to be fully ready (DuckDB + hydration complete)
 */
async function waitForAppReady(page: Page, inspector: StoreInspector): Promise<void> {
  await inspector.waitForDuckDBReady()
  // Wait for "Restoring your workspace..." to disappear
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Restoring your workspace'),
    { timeout: 15000 }
  ).catch(() => {})
}

/**
 * Click on a row marker to open the row menu.
 * Row markers are in the leftmost ~50px of the grid.
 * @param page - Playwright page
 * @param rowIndex - 0-based row index
 */
async function clickRowMarker(page: Page, rowIndex: number): Promise<void> {
  const gridContainer = page.getByTestId('data-grid')
  const gridBox = await gridContainer.boundingBox()
  if (!gridBox) throw new Error('Grid container not found')

  // Row markers are in the first ~30px, header is ~36px
  // Each row is ~33px tall
  const ROW_HEIGHT = 33
  const HEADER_HEIGHT = 36
  const ROW_MARKER_X = 15 // Center of row marker area

  const clickX = gridBox.x + ROW_MARKER_X
  const clickY = gridBox.y + HEADER_HEIGHT + (rowIndex * ROW_HEIGHT) + (ROW_HEIGHT / 2)

  await page.mouse.click(clickX, clickY)
}

/**
 * Click on a column header to open the column menu.
 * @param page - Playwright page
 * @param columnIndex - 0-based column index (excluding row marker column)
 */
async function _clickColumnHeader(page: Page, columnIndex: number): Promise<void> {
  const gridContainer = page.getByTestId('data-grid')
  const gridBox = await gridContainer.boundingBox()
  if (!gridBox) throw new Error('Grid container not found')

  // Row markers take ~50px on the left
  // Each column is ~150px wide by default
  // Header row is at the top
  const ROW_MARKER_WIDTH = 50
  const DEFAULT_COLUMN_WIDTH = 150
  const HEADER_HEIGHT = 36

  const clickX = gridBox.x + ROW_MARKER_WIDTH + (columnIndex * DEFAULT_COLUMN_WIDTH) + (DEFAULT_COLUMN_WIDTH / 2)
  const clickY = gridBox.y + (HEADER_HEIGHT / 2)

  await page.mouse.click(clickX, clickY)
}

test.describe('Row and Column Persistence', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Fresh context per test for WASM isolation
    context = await browser.newContext()
    page = await context.newPage()

    // Capture browser console logs for debugging persistence issues
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[Persistence]') || text.includes('[Executor]')) {
        // console.log(`[Browser] ${text}`)
      }
    })

    await page.goto('/')

    const supportsOPFS = await checkOPFSSupport(page)
    if (!supportsOPFS) {
      test.skip(true, 'OPFS File System Access API not supported')
      return
    }

    // Clean up any previous test data
    await cleanupOPFSTestData(page)
    await page.reload()

    // Initialize page objects
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)

    await waitForAppReady(page, inspector)
  })

  test.afterEach(async () => {
    try {
      await cleanupOPFSTestData(page)
    } catch {
      // Ignore cleanup errors
    }
    try {
      await context.close()
    } catch {
      // Context may already be closed
    }
  })

  test('FR-ROW-PERSIST-1: Inserted row persists after page refresh', async () => {
    // Load a table (basic-data.csv has 5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete before testing row insertion
    // This prevents race conditions between import save and row insert save
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Get the original snapshot file size BEFORE row insert
    const originalSize = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const cleanslateDir = await root.getDirectoryHandle('cleanslate')
        const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
        const fileHandle = await snapshotsDir.getFileHandle('basic_data_shard_0.arrow')
        const file = await fileHandle.getFile()
        return file.size
      } catch {
        return 0
      }
    })
    console.log('[Test FR-ROW-PERSIST-1] Original snapshot size:', originalSize)

    // Verify initial row count
    const rowsBefore = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
    expect(Number(rowsBefore[0].cnt)).toBe(5)

    // Get initial data to verify order later
    const _initialData = await inspector.runQuery<{ id: number; name: string }>('SELECT id, name FROM basic_data ORDER BY "_cs_id"')

    // Click on row marker to open row menu for first row
    await clickRowMarker(page, 0)

    // Wait for row menu to appear
    const rowMenu = page.getByRole('button', { name: 'Insert Below' })
    await expect(rowMenu).toBeVisible({ timeout: 5000 })

    // Click "Insert Below" to insert a new row after the first row
    await rowMenu.click()

    // Wait for row to be inserted (row count should increase to 6)
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
      return Number(rows[0].cnt)
    }, { timeout: 10000 }).toBe(6)

    // Get the new row's _cs_id for verification after refresh
    const rowsWithCsId = await inspector.runQuery<{ _cs_id: string; id: number | null; name: string | null }>(
      'SELECT "_cs_id", id, name FROM basic_data ORDER BY "_cs_id"'
    )
    expect(rowsWithCsId).toHaveLength(6)

    // Find the inserted row (it has null values since it's empty)
    const insertedRow = rowsWithCsId.find(r => r.id === null)
    expect(insertedRow).toBeDefined()
    const insertedCsId = insertedRow!._cs_id

    // Check state immediately after row insert
    const stateAfterInsert = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      if (!stores?.uiStore) return { status: 'unknown', dirty: [], saving: [], priority: [] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (stores.uiStore as any).getState()
      return {
        status: state?.persistenceStatus,
        dirty: Array.from(state?.dirtyTableIds || []),
        saving: Array.from(state?.savingTables || []),
        priority: state?.prioritySaveTableIds ? Array.from(state.prioritySaveTableIds) : []
      }
    })
    console.log('[Test] State after insert:', stateAfterInsert)

    // Flush to OPFS before reload
    await inspector.flushToOPFS()

    // Wait for persistence to complete including atomic rename
    // Must wait until: no saves in progress AND no .tmp files AND file size increased
    await expect.poll(async () => {
      const state = await page.evaluate(async ({ origSize }) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true, hasTmpFiles: true, sizeIncreased: false }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uiState = (stores.uiStore as any).getState()

        // Check for .tmp files in OPFS and current file size
        let hasTmpFiles = false
        let currentSize = 0
        try {
          const root = await navigator.storage.getDirectory()
          const cleanslateDir = await root.getDirectoryHandle('cleanslate')
          const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
          for await (const entry of snapshotsDir.values()) {
            if (entry.name === 'basic_data_shard_0.arrow.tmp') {
              hasTmpFiles = true
            }
            if (entry.name === 'basic_data_shard_0.arrow' && entry.kind === 'file') {
              const file = await entry.getFile()
              currentSize = file.size
            }
          }
        } catch {
          // Directory may not exist
        }

        return {
          saving: uiState?.savingTables?.size > 0,
          hasTmpFiles,
          sizeIncreased: currentSize > origSize
        }
      }, { origSize: originalSize })
      console.log('[Test FR-ROW-PERSIST-1] Polling persistence state:', state)
      // Only return true when no saves in progress AND no .tmp files AND file size increased
      return !state.saving && !state.hasTmpFiles && state.sizeIncreased
    }, { timeout: 20000 }).toBe(true)

    // Save app state (timelines, UI prefs)
    await inspector.saveAppState()

    // Verify the snapshot file exists in OPFS before refresh
    const snapshotFiles = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const cleanslateDir = await root.getDirectoryHandle('cleanslate')
        const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
        const files: { name: string; size: number }[] = []
        for await (const entry of snapshotsDir.values()) {
          if (entry.kind === 'file') {
            const file = await entry.getFile()
            files.push({ name: entry.name, size: file.size })
          }
        }
        return files
      } catch {
        return [{ name: 'error', size: -1 }]
      }
    })
    console.log('[Test] Snapshot files in OPFS before refresh:', snapshotFiles)

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Check what's restored
    const restoredTables = await inspector.getTableList()
    console.log('[Test] Tables after refresh:', restoredTables)

    // Wait for table to be queryable in DuckDB
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        const count = Number(rows[0].cnt)
        console.log('[Test] Row count after refresh:', count)
        return count
      } catch (e) {
        console.log('[Test] Error querying table:', e)
        return 0
      }
    }, { timeout: 15000 }).toBe(6)

    // Verify the inserted row still exists
    const rowsAfterRefresh = await inspector.runQuery<{ _cs_id: string; id: number | null }>(
      'SELECT "_cs_id", id FROM basic_data'
    )
    expect(rowsAfterRefresh).toHaveLength(6)

    // Verify the specific inserted row is still there
    const foundInsertedRow = rowsAfterRefresh.find(r => r._cs_id === insertedCsId)
    expect(foundInsertedRow).toBeDefined()
  })

  test('FR-ROW-PERSIST-2: Insert row above persists correctly', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete before testing row insertion
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Click on row marker for second row
    await clickRowMarker(page, 1)

    // Wait for row menu to appear and click "Insert Above"
    const insertAboveBtn = page.getByRole('button', { name: 'Insert Above' })
    await expect(insertAboveBtn).toBeVisible({ timeout: 5000 })
    await insertAboveBtn.click()

    // Wait for row to be inserted
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
      return Number(rows[0].cnt)
    }, { timeout: 10000 }).toBe(6)

    // Get the original snapshot file size before the priority save completes
    const originalSize = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const cleanslateDir = await root.getDirectoryHandle('cleanslate')
        const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
        const fileHandle = await snapshotsDir.getFileHandle('basic_data_shard_0.arrow')
        const file = await fileHandle.getFile()
        return file.size
      } catch {
        return 0
      }
    })
    console.log('[Test FR-ROW-PERSIST-2] Original snapshot size:', originalSize)

    // Wait for the priority save to complete by checking that:
    // 1. No saves in progress
    // 2. No .tmp files (atomic rename complete)
    // 3. Snapshot file size has INCREASED (new row was actually saved)
    await expect.poll(async () => {
      const state = await page.evaluate(async ({ origSize }) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true, hasTmpFiles: true, sizeIncreased: false }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uiState = (stores.uiStore as any).getState()

        // Check for .tmp files in OPFS (indicates incomplete atomic rename)
        let hasTmpFiles = false
        let currentSize = 0
        try {
          const root = await navigator.storage.getDirectory()
          const cleanslateDir = await root.getDirectoryHandle('cleanslate')
          const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
          for await (const entry of snapshotsDir.values()) {
            if (entry.name === 'basic_data_shard_0.arrow.tmp') {
              hasTmpFiles = true
            }
            if (entry.name === 'basic_data_shard_0.arrow' && entry.kind === 'file') {
              const file = await entry.getFile()
              currentSize = file.size
            }
          }
        } catch { /* Ignore OPFS errors */ }

        return {
          saving: uiState?.savingTables?.size > 0,
          hasTmpFiles,
          sizeIncreased: currentSize > origSize
        }
      }, { origSize: originalSize })
      console.log('[Test FR-ROW-PERSIST-2] Persistence state:', state)
      return !state.saving && !state.hasTmpFiles && state.sizeIncreased
    }, { timeout: 20000 }).toBe(true)

    // Flush any pending data and save app state
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Debug: Check snapshot files before refresh
    const snapshotFiles = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const cleanslateDir = await root.getDirectoryHandle('cleanslate')
        const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
        const files: { name: string; size: number }[] = []
        for await (const entry of snapshotsDir.values()) {
          if (entry.kind === 'file') {
            const file = await entry.getFile()
            files.push({ name: entry.name, size: file.size })
          }
        }
        return files
      } catch {
        return [{ name: 'error', size: -1 }]
      }
    })
    console.log('[Test FR-ROW-PERSIST-2] Snapshot files before refresh:', snapshotFiles)

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Verify row count after refresh
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        const count = Number(rows[0].cnt)
        console.log('[Test FR-ROW-PERSIST-2] Row count after refresh:', count)
        return count
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(6)
  })

  test('FR-ROW-PERSIST-3: Multiple inserted rows persist correctly', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete before testing row insertion
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Insert first row below row 0
    await clickRowMarker(page, 0)
    await expect(page.getByRole('button', { name: 'Insert Below' })).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Insert Below' }).click()

    // Wait for first insert
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
      return Number(rows[0].cnt)
    }, { timeout: 10000 }).toBe(6)

    // Get file size after first insert (before save completes)
    const sizeAfterFirstInsert = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const cleanslateDir = await root.getDirectoryHandle('cleanslate')
        const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
        const fileHandle = await snapshotsDir.getFileHandle('basic_data_shard_0.arrow')
        const file = await fileHandle.getFile()
        return file.size
      } catch {
        return 0
      }
    })
    console.log('[Test FR-ROW-PERSIST-3] File size before first save:', sizeAfterFirstInsert)

    // Wait for first insert save to complete (file size must increase)
    await expect.poll(async () => {
      const state = await page.evaluate(async ({ origSize }) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true, hasTmpFiles: true, sizeIncreased: false }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uiState = (stores.uiStore as any).getState()

        let hasTmpFiles = false
        let currentSize = 0
        try {
          const root = await navigator.storage.getDirectory()
          const cleanslateDir = await root.getDirectoryHandle('cleanslate')
          const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
          for await (const entry of snapshotsDir.values()) {
            if (entry.name === 'basic_data_shard_0.arrow.tmp') {
              hasTmpFiles = true
            }
            if (entry.name === 'basic_data_shard_0.arrow' && entry.kind === 'file') {
              const file = await entry.getFile()
              currentSize = file.size
            }
          }
        } catch { /* Ignore OPFS errors */ }

        return {
          saving: uiState?.savingTables?.size > 0,
          hasTmpFiles,
          sizeIncreased: currentSize > origSize
        }
      }, { origSize: sizeAfterFirstInsert })
      return !state.saving && !state.hasTmpFiles && state.sizeIncreased
    }, { timeout: 20000 }).toBe(true)

    // Dismiss any overlay
    await page.keyboard.press('Escape')

    // Insert second row below row 2
    await clickRowMarker(page, 2)
    await expect(page.getByRole('button', { name: 'Insert Below' })).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Insert Below' }).click()

    // Wait for second insert
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
      return Number(rows[0].cnt)
    }, { timeout: 10000 }).toBe(7)

    // Row inserts are journaled to the OPFS changelog (fast path) and don't trigger
    // snapshot re-export. Use flushToOPFS() to force snapshot export before reload.
    // The key assertion is that 7 rows survive the reload, not snapshot file timing.
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Verify all rows persisted
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(7)
  })

  test('FR-ROW-PERSIST-4: Deleted row removal persists after refresh', async () => {
    // Load a table (basic-data.csv has 5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete before testing row deletion
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Get the original snapshot file size BEFORE row delete
    const originalSize = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const cleanslateDir = await root.getDirectoryHandle('cleanslate')
        const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
        const fileHandle = await snapshotsDir.getFileHandle('basic_data_shard_0.arrow')
        const file = await fileHandle.getFile()
        return file.size
      } catch {
        return 0
      }
    })
    console.log('[Test FR-ROW-PERSIST-4] Original snapshot size:', originalSize)

    // Get the _cs_id of the first row to verify it's deleted
    const initialRows = await inspector.runQuery<{ _cs_id: string; id: number }>('SELECT "_cs_id", id FROM basic_data ORDER BY "_cs_id" LIMIT 1')
    const deletedCsId = initialRows[0]._cs_id

    // Click on row marker to open row menu for first row
    await clickRowMarker(page, 0)

    // Wait for row menu to appear and click "Delete Row"
    const deleteBtn = page.getByRole('button', { name: 'Delete Row' })
    await expect(deleteBtn).toBeVisible({ timeout: 5000 })
    await deleteBtn.click()

    // Handle the confirmation dialog
    const confirmDeleteBtn = page.getByRole('button', { name: /^Delete$/i })
    await expect(confirmDeleteBtn).toBeVisible({ timeout: 5000 })
    await confirmDeleteBtn.click()

    // Wait for row to be deleted
    await expect.poll(async () => {
      const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
      return Number(rows[0].cnt)
    }, { timeout: 10000 }).toBe(4)

    // Flush to OPFS
    await inspector.flushToOPFS()

    // Wait for persistence to complete including atomic rename
    // Must wait until: no saves in progress AND no .tmp files AND file size decreased
    await expect.poll(async () => {
      const state = await page.evaluate(async ({ origSize }) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true, hasTmpFiles: true, sizeDecreased: false }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uiState = (stores.uiStore as any).getState()

        // Check for .tmp files in OPFS and current file size
        let hasTmpFiles = false
        let currentSize = 0
        try {
          const root = await navigator.storage.getDirectory()
          const cleanslateDir = await root.getDirectoryHandle('cleanslate')
          const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
          for await (const entry of snapshotsDir.values()) {
            if (entry.name === 'basic_data_shard_0.arrow.tmp') {
              hasTmpFiles = true
            }
            if (entry.name === 'basic_data_shard_0.arrow' && entry.kind === 'file') {
              const file = await entry.getFile()
              currentSize = file.size
            }
          }
        } catch {
          // Directory may not exist
        }

        return {
          saving: uiState?.savingTables?.size > 0,
          hasTmpFiles,
          sizeDecreased: currentSize < origSize
        }
      }, { origSize: originalSize })
      console.log('[Test FR-ROW-PERSIST-4] Polling persistence state:', state)
      // Only return true when no saves in progress AND no .tmp files AND file size decreased
      return !state.saving && !state.hasTmpFiles && state.sizeDecreased
    }, { timeout: 20000 }).toBe(true)

    await inspector.saveAppState()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Verify row count after refresh
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(4)

    // Verify the deleted row is actually gone
    const rowsAfterRefresh = await inspector.runQuery<{ _cs_id: string }>('SELECT "_cs_id" FROM basic_data')
    const foundDeletedRow = rowsAfterRefresh.find(r => r._cs_id === deletedCsId)
    expect(foundDeletedRow).toBeUndefined()
  })

  test('FR-COL-PERSIST-1: Column order persists after programmatic reorder', async () => {
    // Load a table (basic-data.csv has columns: id, name, email, city, state)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Get initial column order from tableStore
    const tableBefore = await inspector.getTableInfo('basic_data')
    expect(tableBefore).toBeDefined()
    const initialColumns = tableBefore!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    expect(initialColumns).toContain('id')
    expect(initialColumns).toContain('name')
    const tableId = tableBefore!.id

    // Note the initial order (id should be first)
    const idIndexBefore = initialColumns.indexOf('id')
    const nameIndexBefore = initialColumns.indexOf('name')
    expect(idIndexBefore).toBeLessThan(nameIndexBefore)

    // Reorder columns via store API (simulates what happens on drag-drop)
    // Move 'name' to first position by creating new order: [name, id, email, ...]
    await page.evaluate((id) => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      if (!stores?.tableStore) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableStore = stores.tableStore as any
      const state = tableStore.getState()
      const table = state.tables.find((t: { id: string }) => t.id === id)
      if (!table) return

      // Create new column order with 'name' first
      const currentCols = table.columns.map((c: { name: string }) => c.name)
      const nameIdx = currentCols.indexOf('name')
      const newOrder = [...currentCols]
      newOrder.splice(nameIdx, 1) // Remove 'name'
      newOrder.splice(0, 0, 'name') // Insert at position 0

      tableStore.getState().setColumnOrder(id, newOrder)
    }, tableId)

    // Wait for column order to update in store (checking columnOrder property, not raw columns)
    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      // columnOrder is the user-visible display order, set by setColumnOrder
      const order = table?.columnOrder?.filter((n: string) => !n.startsWith('_')) ?? []
      return order[0]
    }, { timeout: 10000 }).toBe('name')

    // Wait for app state save (columnOrder changes trigger saveAppStateNow)
    await page.waitForTimeout(1000) // Brief wait for async save
    await inspector.saveAppState()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify column order persisted (name should now be first)
    // Check columnOrder which is the user-visible display order
    const tableAfter = await inspector.getTableInfo('basic_data')
    expect(tableAfter).toBeDefined()
    const columnsAfter = tableAfter!.columnOrder?.filter((n: string) => !n.startsWith('_')) ?? []
    expect(columnsAfter[0]).toBe('name')
    expect(columnsAfter[1]).toBe('id')
  })

  test('FR-COL-PERSIST-2: Multiple column reorders persist correctly', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    const tableBefore = await inspector.getTableInfo('basic_data')
    expect(tableBefore).toBeDefined()
    const tableId = tableBefore!.id

    // Reorder columns via store API: set order to [email, city, id, name, ...]
    await page.evaluate((id) => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      if (!stores?.tableStore) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableStore = stores.tableStore as any
      const state = tableStore.getState()
      const table = state.tables.find((t: { id: string }) => t.id === id)
      if (!table) return

      // Create new column order: [email, city, id, name, state] (or whatever columns exist)
      const currentCols = table.columns.map((c: { name: string }) => c.name)
      // Filter out internal columns
      const userCols = currentCols.filter((n: string) => !n.startsWith('_'))

      // Rearrange to put email first, city second
      const emailIdx = userCols.indexOf('email')
      const cityIdx = userCols.indexOf('city')

      // Create new order
      const newUserOrder: string[] = []
      if (emailIdx !== -1) {
        newUserOrder.push('email')
      }
      if (cityIdx !== -1) {
        newUserOrder.push('city')
      }
      for (const col of userCols) {
        if (col !== 'email' && col !== 'city') {
          newUserOrder.push(col)
        }
      }

      // Add back internal columns at the end
      const internalCols = currentCols.filter((n: string) => n.startsWith('_'))
      const newOrder = [...newUserOrder, ...internalCols]

      tableStore.getState().setColumnOrder(id, newOrder)
    }, tableId)

    // Wait for column order to update in store (checking columnOrder property)
    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      const order = table?.columnOrder?.filter((n: string) => !n.startsWith('_')) ?? []
      return order[0]
    }, { timeout: 10000 }).toBe('email')

    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      const order = table?.columnOrder?.filter((n: string) => !n.startsWith('_')) ?? []
      return order[1]
    }, { timeout: 10000 }).toBe('city')

    // Wait for app state save
    await page.waitForTimeout(1000)
    await inspector.saveAppState()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify final column order persisted (check columnOrder, not raw columns)
    const tableAfter = await inspector.getTableInfo('basic_data')
    expect(tableAfter).toBeDefined()
    const columnsAfter = tableAfter!.columnOrder?.filter((n: string) => !n.startsWith('_')) ?? []
    expect(columnsAfter[0]).toBe('email')
    expect(columnsAfter[1]).toBe('city')
  })

  test('FR-COL-POSITION-1: Add column left inserts at correct position', async () => {
    // Load a table (basic-data.csv has columns: id, name, email, city)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Get initial column order
    const tableBefore = await inspector.getTableInfo('basic_data')
    const initialColumns = tableBefore!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                           tableBefore!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    console.log('[Test] Initial column order:', initialColumns)

    // Find the index of 'name' column (we'll insert left of it)
    const nameIndex = initialColumns.indexOf('name')
    expect(nameIndex).toBeGreaterThan(0) // 'name' should not be first
    const tableId = tableBefore!.id

    // NOTE: glide-data-grid header clicks don't work reliably with Playwright,
    // so we execute the add column command directly via the store
    // This tests the executor's columnOrder logic which is the fix target
    await page.evaluate(async ({ tableId, insertAfter }) => {
      // Use the command executor directly to add a column
      const { createCommand, getCommandExecutor } = await import('/src/lib/commands/index.ts')
      const command = createCommand('schema:add_column', {
        tableId,
        columnName: 'new_col',
        columnType: 'VARCHAR',
        insertAfter, // Insert after 'id' = left of 'name'
      })
      await getCommandExecutor().execute(command)
    }, { tableId, insertAfter: initialColumns[nameIndex - 1] }) // Insert after column before 'name'

    // Wait for column to be added
    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      const cols = table?.columns.map(c => c.name) ?? []
      return cols.includes('new_col')
    }, { timeout: 10000 }).toBe(true)

    // Verify the new column is to the LEFT of 'name'
    const tableAfter = await inspector.getTableInfo('basic_data')
    const columnsAfter = tableAfter!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                         tableAfter!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    console.log('[Test] Column order after insert left:', columnsAfter)

    const newColIndex = columnsAfter.indexOf('new_col')
    const nameIndexAfter = columnsAfter.indexOf('name')

    // new_col should be immediately before 'name'
    expect(newColIndex).toBe(nameIndexAfter - 1)
  })

  test('FR-COL-POSITION-2: Add column right inserts at correct position', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Get initial column order
    const tableBefore = await inspector.getTableInfo('basic_data')
    const initialColumns = tableBefore!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                           tableBefore!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    console.log('[Test] Initial column order:', initialColumns)
    const tableId = tableBefore!.id

    // NOTE: glide-data-grid header clicks don't work reliably with Playwright,
    // so we execute the add column command directly via the store
    // insertAfter: 'id' means the new column will appear right after 'id'
    await page.evaluate(async ({ tableId }) => {
      const { createCommand, getCommandExecutor } = await import('/src/lib/commands/index.ts')
      const command = createCommand('schema:add_column', {
        tableId,
        columnName: 'new_col_right',
        columnType: 'VARCHAR',
        insertAfter: 'id', // Insert right of 'id'
      })
      await getCommandExecutor().execute(command)
    }, { tableId })

    // Wait for column to be added
    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      const cols = table?.columns.map(c => c.name) ?? []
      return cols.includes('new_col_right')
    }, { timeout: 10000 }).toBe(true)

    // Verify the new column is to the RIGHT of 'id'
    const tableAfter = await inspector.getTableInfo('basic_data')
    const columnsAfter = tableAfter!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                         tableAfter!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    console.log('[Test] Column order after insert right:', columnsAfter)

    const idIndex = columnsAfter.indexOf('id')
    const newColIndex = columnsAfter.indexOf('new_col_right')

    // new_col_right should be immediately after 'id'
    expect(newColIndex).toBe(idIndex + 1)
  })

  test('FR-COL-PERSIST-3: Added column persists at correct position after refresh', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Get initial column order
    const tableBefore = await inspector.getTableInfo('basic_data')
    const initialColumns = tableBefore!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                           tableBefore!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    const tableId = tableBefore!.id
    console.log('[Test] Initial column order:', initialColumns)

    // Add column using command executor (insert after 'id', i.e., left of 'name')
    await page.evaluate(async ({ tableId }) => {
      const { createCommand, getCommandExecutor } = await import('/src/lib/commands/index.ts')
      const command = createCommand('schema:add_column', {
        tableId,
        columnName: 'persisted_col',
        columnType: 'VARCHAR',
        insertAfter: 'id', // Insert after 'id'
      })
      await getCommandExecutor().execute(command)
    }, { tableId })

    // Wait for column to be added
    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      const cols = table?.columns.map(c => c.name) ?? []
      return cols.includes('persisted_col')
    }, { timeout: 10000 }).toBe(true)

    // Get column position before refresh
    const tableBeforeRefresh = await inspector.getTableInfo('basic_data')
    const columnsBefore = tableBeforeRefresh!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                          tableBeforeRefresh!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    const positionBefore = columnsBefore.indexOf('persisted_col')
    console.log('[Test] Column order before refresh:', columnsBefore, 'persisted_col at index:', positionBefore)

    // Wait for persistence to complete including atomic rename
    await expect.poll(async () => {
      const state = await page.evaluate(async () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true, hasTmpFiles: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uiState = (stores.uiStore as any).getState()

        // Check for .tmp files in OPFS
        let hasTmpFiles = false
        try {
          const root = await navigator.storage.getDirectory()
          const cleanslateDir = await root.getDirectoryHandle('cleanslate')
          const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
          for await (const entry of snapshotsDir.values()) {
            if (entry.name.endsWith('.tmp')) {
              hasTmpFiles = true
              break
            }
          }
        } catch { /* Ignore OPFS errors */ }

        return { saving: uiState?.savingTables?.size > 0, hasTmpFiles }
      })
      return !state.saving && !state.hasTmpFiles
    }, { timeout: 20000 }).toBe(true)

    // Flush and save
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify the column still exists AND is at the correct position
    const tableAfter = await inspector.getTableInfo('basic_data')
    const columnsAfter = tableAfter!.columnOrder?.filter((n: string) => !n.startsWith('_')) ??
                         tableAfter!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    console.log('[Test] Column order after refresh:', columnsAfter)

    // Column should exist
    expect(columnsAfter).toContain('persisted_col')

    // Column should be at the same position as before refresh
    const positionAfter = columnsAfter.indexOf('persisted_col')
    expect(positionAfter).toBe(positionBefore)
  })

  test('FR-COL-PERSIST-4: Deleted column removal persists after refresh', async () => {
    // Load a table
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for initial import save to complete
    await expect.poll(async () => {
      const uiState = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.uiStore as any).getState()
        return { saving: state?.savingTables?.size > 0 }
      })
      return !uiState.saving
    }, { timeout: 15000 }).toBe(true)

    // Get initial columns
    const tableBefore = await inspector.getTableInfo('basic_data')
    const columnsBefore = tableBefore!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    const tableId = tableBefore!.id
    const tableName = tableBefore!.name
    console.log('[Test] Columns before delete:', columnsBefore)
    expect(columnsBefore).toContain('city')

    // Delete column using command executor
    // NOTE: schema:delete_column is NOT in LOCAL_ONLY_COMMANDS,
    // so it goes through the normal path with full updateTableStore
    const deleteResult = await page.evaluate(async ({ tableId, tableName }) => {
      const { createCommand, getCommandExecutor } = await import('/src/lib/commands/index.ts')
      const command = createCommand('schema:delete_column', {
        tableId,
        tableName,
        columnName: 'city',
      })
      const result = await getCommandExecutor().execute(command)
      return { success: result.success, error: result.error }
    }, { tableId, tableName })
    console.log('[Test] Delete column result:', deleteResult)
    expect(deleteResult.success).toBe(true)

    // Wait for column to be deleted
    await expect.poll(async () => {
      const table = await inspector.getTableInfo('basic_data')
      const cols = table?.columns.map(c => c.name) ?? []
      console.log('[Test] Columns after delete (polling):', cols)
      return !cols.includes('city')
    }, { timeout: 10000 }).toBe(true)

    // Also verify via SQL that column is gone
    const sqlVerify = await inspector.runQuery<{ column_name: string }>(`
      SELECT column_name FROM (DESCRIBE basic_data)
    `)
    console.log('[Test] Columns in DuckDB after delete:', sqlVerify.map(r => r.column_name))

    // Wait for persistence to complete - must wait for both savingTables to be empty AND no .tmp files
    await expect.poll(async () => {
      const state = await page.evaluate(async () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.uiStore) return { saving: true, hasTmpFiles: true, savingTables: [] }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uiState = (stores.uiStore as any).getState()

        let hasTmpFiles = false
        try {
          const root = await navigator.storage.getDirectory()
          const cleanslateDir = await root.getDirectoryHandle('cleanslate')
          const snapshotsDir = await cleanslateDir.getDirectoryHandle('snapshots')
          for await (const entry of snapshotsDir.values()) {
            if (entry.name.endsWith('.tmp')) {
              hasTmpFiles = true
              break
            }
          }
        } catch { /* Ignore OPFS errors */ }

        return {
          saving: uiState?.savingTables?.size > 0,
          hasTmpFiles,
          savingTables: Array.from(uiState?.savingTables || [])
        }
      })
      console.log('[Test] Persistence state:', state)
      return !state.saving && !state.hasTmpFiles
    }, { timeout: 30000 }).toBe(true)

    // Explicit flush and save
    await inspector.flushToOPFS()
    await inspector.saveAppState()

    // Wait a bit more for all async operations
    await inspector.waitForPersistenceComplete()

    // Verify via SQL that column is STILL gone before refresh
    const sqlVerifyBeforeRefresh = await inspector.runQuery<{ column_name: string }>(`
      SELECT column_name FROM (DESCRIBE basic_data)
    `)
    console.log('[Test] Columns in DuckDB before refresh:', sqlVerifyBeforeRefresh.map(r => r.column_name))
    expect(sqlVerifyBeforeRefresh.map(r => r.column_name)).not.toContain('city')

    // Refresh page
    await page.reload()
    await waitForAppReady(page, inspector)

    // Wait for table to be queryable
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM basic_data')
        return Number(rows[0].cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(5)

    // Verify the column is still deleted
    const tableAfter = await inspector.getTableInfo('basic_data')
    const columnsAfter = tableAfter!.columns.map(c => c.name).filter(n => !n.startsWith('_'))
    console.log('[Test] Columns after refresh:', columnsAfter)
    expect(columnsAfter).not.toContain('city')
  })
})
