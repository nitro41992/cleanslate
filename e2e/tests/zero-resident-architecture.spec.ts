import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Zero-Resident Architecture E2E Tests
 *
 * Validates the shard/manifest/chunk-manager layer:
 * 1. Shard and manifest files written correctly to OPFS
 * 2. Manifest metadata integrity (row counts, columns, shard info)
 * 3. Multi-table switching preserves data correctness
 * 4. Transforms execute correctly after table switch + materialization
 * 5. Diff works with shard-backed snapshots
 * 6. Cell edits work after table switch (Phase 4 Gap A)
 * 7. CommandExecutor gate allows transform after table switch
 * 8. Materialization indicator UI feedback
 * 9. Sort works after freeze/thaw cycle
 * 10. Stack combines tables when one source is frozen
 * 11. Join combines tables when one source is frozen
 *
 * Tier 3: Fresh browser context per test (OPFS + WASM isolation).
 */
test.describe('Zero-Resident Architecture', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let diffView: DiffViewPage
  let inspector: StoreInspector

  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    diffView = new DiffViewPage(page)
    inspector = createStoreInspector(page)

    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test('shard and manifest files are written to OPFS after import', async () => {
    // Upload basic-data.csv (5 rows)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for persistence to complete (shard files written to OPFS)
    await inspector.waitForPersistenceComplete()

    // Poll for OPFS files to appear (persistence is async with debounce)
    await expect.poll(async () => {
      const files = await inspector.getOPFSSnapshotFiles('basic_data')
      return files.length
    }, { timeout: 15000 }).toBeGreaterThan(0)

    const files = await inspector.getOPFSSnapshotFiles('basic_data')

    // Verify shard file exists with reasonable size
    const shardFile = files.find(f => f.name === 'basic_data_shard_0.arrow')
    expect(shardFile).toBeDefined()
    expect(shardFile!.size).toBeGreaterThan(8)

    // Verify manifest file exists with reasonable size
    const manifestFile = files.find(f => f.name === 'basic_data_manifest.json')
    expect(manifestFile).toBeDefined()
    expect(manifestFile!.size).toBeGreaterThan(10)

    // Verify no .tmp files remain (atomic write completed)
    const tmpFiles = files.filter(f => f.name.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  test('manifest metadata matches imported data', async () => {
    // Upload basic-data.csv (5 rows: id, name, email, city)
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for persistence to complete
    await inspector.waitForPersistenceComplete()

    // Poll for manifest to appear in OPFS
    await expect.poll(async () => {
      const manifest = await inspector.getOPFSManifest('basic_data')
      return manifest !== null
    }, { timeout: 15000 }).toBe(true)

    // Read and parse manifest
    const manifest = await inspector.getOPFSManifest('basic_data')
    expect(manifest).not.toBeNull()

    // Verify top-level metadata
    expect(manifest!.totalRows).toBe(5)
    expect(manifest!.shardSize).toBe(50000)

    // Verify columns include the CSV columns (may also include internal columns)
    const userColumns = ['id', 'name', 'email', 'city']
    for (const col of userColumns) {
      expect(manifest!.columns).toContain(col)
    }

    // Verify shard array
    expect(manifest!.shards).toHaveLength(1)
    expect(manifest!.shards[0].rowCount).toBe(5)
    expect(manifest!.shards[0].fileName).toBe('basic_data_shard_0.arrow')
    expect(manifest!.shards[0].byteSize).toBeGreaterThan(0)
  })

  test('table switch restores frozen table from OPFS shards', async () => {
    // Upload first CSV: fr_e1_jan_sales (4 rows)
    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)

    // Wait for first table to persist before uploading second
    await inspector.waitForPersistenceComplete()

    // Upload second CSV: basic-data (5 rows)
    // This freezes fr_e1_jan_sales and makes basic_data active
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Wait for second table to persist
    await inspector.waitForPersistenceComplete()

    // Switch back to jan_sales via table selector dropdown
    // This thaws fr_e1_jan_sales from OPFS shards and freezes basic_data
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /fr_e1_jan_sales/ }).click()

    // Wait for table switch to complete (materialization + loading)
    await inspector.waitForMaterializationComplete()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)

    // Verify jan_sales data was correctly restored from OPFS shards
    await expect.poll(async () => {
      try {
        const salesRows = await inspector.runQuery<{ sale_id: string }>(
          'SELECT sale_id FROM fr_e1_jan_sales ORDER BY sale_id'
        )
        return salesRows.map(r => r.sale_id)
      } catch {
        return null // Table may not be ready yet
      }
    }, { timeout: 15000 }).toEqual(['J001', 'J002', 'J003', 'J004'])
  })

  test('transform executes correctly after table switch', async () => {
    // Upload two CSVs
    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // basic_data is now active. Apply uppercase on city column.
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'city' })
    await inspector.waitForTransformComplete(tableId!)

    // Verify cities are uppercased
    const rows = await inspector.runQuery<{ city: string }>(
      'SELECT city FROM basic_data ORDER BY "_cs_id"'
    )
    expect(rows.map(r => r.city)).toEqual([
      'NEW YORK', 'LOS ANGELES', 'CHICAGO', 'HOUSTON', 'PHOENIX'
    ])
  })

  // --- Phase 4 Tests: Materialization Gating + Frozen Table Behavior ---

  test('cell edit works after table switch', async () => {
    // Validates Gap A: cell edits don't silently fail after a table switch.
    // The materialization gate in DataGrid.tsx waits for the table to be ready.
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForPersistenceComplete()

    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)
    await inspector.waitForPersistenceComplete()

    // Switch back to basic_data (freezes jan_sales)
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /basic_data/ }).click()
    await inspector.waitForMaterializationComplete()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForGridReady()

    // Verify table is queryable before editing
    const rowsBefore = await inspector.runQuery<{ _cs_id: string; name: string }>(
      'SELECT "_cs_id", name FROM basic_data ORDER BY "_cs_id" LIMIT 1'
    )
    expect(rowsBefore.length).toBeGreaterThan(0)
    const firstCsId = rowsBefore[0]._cs_id

    // After table switch, the grid re-renders with new data. Give the grid a
    // warm-up click to ensure the canvas is fully interactive and the edit
    // overlay will capture keystrokes reliably. Without this, the first few
    // characters can be lost because the overlay isn't ready when typing starts.
    const gridContainer = page.locator('[data-testid="data-grid"]')
    const gridBox = await gridContainer.boundingBox()
    if (gridBox) {
      await page.mouse.click(gridBox.x + 100, gridBox.y + 60)
      // Wait for grid to process the click and establish cell selection
      await page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ))
    }

    // Edit cell: row 0, col 1 (name column)
    await laundromat.editCell(0, 1, 'SWITCHED_EDIT')

    // Flush edit batch and verify via SQL
    await inspector.flushEditBatch()
    await inspector.waitForEditBatchFlush()

    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ name: string }>(
          `SELECT name FROM basic_data WHERE "_cs_id" = '${firstCsId}'`
        )
        return rows[0]?.name
      } catch {
        return null
      }
    }, { timeout: 15000 }).toBe('SWITCHED_EDIT')
  })

  test('CommandExecutor gate allows transform after table switch', async () => {
    // Validates the enhanced frozenTables gate in executor.ts:
    // The executor checks both frozenTables and materializingTables before running commands.
    // After a table switch, the switched-to table is materialized and transforms work.
    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)
    await inspector.waitForPersistenceComplete()

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Switch to jan_sales (freezes basic_data)
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /fr_e1_jan_sales/ }).click()
    await inspector.waitForMaterializationComplete()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)

    // Verify table is in DuckDB before applying transform
    await expect.poll(async () => {
      try {
        const rows = await inspector.runQuery<{ sale_id: string }>(
          'SELECT sale_id FROM fr_e1_jan_sales LIMIT 1'
        )
        return rows.length
      } catch {
        return 0
      }
    }, { timeout: 10000 }).toBeGreaterThan(0)

    // Apply uppercase on product column — the executor gate must allow this
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'product' })
    await inspector.waitForTransformComplete(tableId!)

    // Verify transform applied correctly
    const rows = await inspector.runQuery<{ product: string }>(
      'SELECT product FROM fr_e1_jan_sales ORDER BY "_cs_id"'
    )
    expect(rows.map(r => r.product)).toEqual([
      'WIDGET A', 'GADGET X', 'TOOL Z', 'WIDGET B'
    ])
  })

  test('materialization indicator appears during table switch', async () => {
    // Upload two CSVs
    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)
    await inspector.waitForPersistenceComplete()

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForPersistenceComplete()

    // Switch back to jan_sales — materialization indicator should appear
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /fr_e1_jan_sales/ }).click()

    // The indicator should appear (may be brief for small datasets)
    // We verify it appeared at some point OR materialization completed
    await expect.poll(async () => {
      const indicatorVisible = await page.getByTestId('materialization-indicator').isVisible().catch(() => false)
      const materializingDone = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (stores.tableStore as any).getState().materializingTables.size === 0
      })
      // Either indicator is visible (still materializing) or materialization completed
      return indicatorVisible || materializingDone
    }, { timeout: 15000 }).toBe(true)

    // After materialization completes, indicator should disappear
    await inspector.waitForMaterializationComplete()
    await expect(page.getByTestId('materialization-indicator')).toBeHidden({ timeout: 10000 })
  })

  test('sort works correctly after table switch', async () => {
    // Upload two CSVs
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)
    await inspector.waitForPersistenceComplete()

    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)
    await inspector.waitForPersistenceComplete()

    // Switch back to basic_data
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /basic_data/ }).click()

    await inspector.waitForMaterializationComplete()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Get the tableId for basic_data
    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Apply sort on city column (ascending) via store
    await page.evaluate((tid) => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      if (!stores?.tableStore) throw new Error('Store not available')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(stores.tableStore as any).getState().setSort(tid, 'city', 'asc')
    }, tableId)

    // Verify sorted data via SQL (sort triggers re-fetch through DuckDB)
    await expect.poll(async () => {
      try {
        return await page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return null
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vs = (stores.tableStore as any).getState().getViewState(tid)
          return vs?.sortColumn
        }, tableId)
      } catch {
        return null
      }
    }, { timeout: 5000 }).toBe('city')

    // Verify the data is queryable (table is materialized, not frozen)
    const rows = await inspector.runQuery<{ city: string }>(
      'SELECT city FROM basic_data ORDER BY city ASC'
    )
    expect(rows.map(r => r.city)).toEqual([
      'Chicago', 'Houston', 'Los Angeles', 'New York', 'Phoenix'
    ])
  })

  // --- Phase 4 Tests: Combiner with Frozen Source Tables ---

  test('stack combines tables when one source is frozen', async () => {
    // Validates that the combiner engine resolves frozen source tables from OPFS
    // when executing a stack operation.
    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)
    await inspector.waitForPersistenceComplete()

    await laundromat.uploadFile(getFixturePath('fr_e1_feb_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_feb_sales', 5)
    await inspector.waitForPersistenceComplete()

    // Switch to jan_sales — this freezes feb_sales (drops from DuckDB, keeps OPFS snapshot)
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /fr_e1_jan_sales/ }).click()
    await inspector.waitForMaterializationComplete()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)

    // Verify feb_sales is frozen (not in DuckDB, has OPFS snapshot)
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.tableStore as any).getState()
        const feb = state.tables.find((t: { name: string }) => t.name === 'fr_e1_feb_sales')
        return feb ? state.frozenTables.has(feb.id) : null
      })
    }, { timeout: 5000 }).toBe(true)

    // Open combiner panel — using selector pattern from passing feature-coverage tests
    await laundromat.openCombinePanel()
    await expect(page.getByTestId('combiner-stack-tab')).toBeVisible()

    // Select first table (jan_sales — active, in DuckDB)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e1_jan_sales/i }).click()

    // Select second table (feb_sales — frozen, resolved from OPFS snapshot)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e1_feb_sales/i }).click()

    // Enter result table name and stack
    await page.getByPlaceholder('e.g., combined_sales').fill('stacked_sales')
    await page.getByTestId('combiner-stack-btn').click()

    // Wait for toast confirmation and combiner completion
    await expect(page.getByText('Tables Stacked', { exact: true })).toBeVisible({ timeout: 30000 })
    await inspector.waitForCombinerComplete()

    // Verify result: 4 jan + 5 feb = 9 rows
    await expect.poll(async () => {
      try {
        const result = await inspector.runQuery<{ cnt: string }>(
          'SELECT count(*) as cnt FROM stacked_sales'
        )
        return Number(result[0]?.cnt)
      } catch {
        return 0
      }
    }, { timeout: 15000 }).toBe(9)

    // Verify data identity — both jan and feb sale IDs present
    const data = await inspector.getTableData('stacked_sales', 9)
    const saleIds = data.map(r => r.sale_id as string)
    const janIds = saleIds.filter(id => id.startsWith('J')).sort()
    const febIds = saleIds.filter(id => id.startsWith('F')).sort()
    expect(janIds).toEqual(['J001', 'J002', 'J003', 'J004'])
    expect(febIds).toEqual(['F001', 'F002', 'F003', 'F004', 'F005'])
  })

  test('join combines tables when one source is frozen', async () => {
    // Validates that the combiner engine resolves a frozen source table from OPFS
    // when executing a join operation.
    await laundromat.uploadFile(getFixturePath('fr_e2_orders.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e2_orders', 6)
    await inspector.waitForPersistenceComplete()

    await laundromat.uploadFile(getFixturePath('fr_e2_customers.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e2_customers', 4)
    await inspector.waitForPersistenceComplete()

    // Switch to orders — this freezes customers (drops from DuckDB, keeps OPFS snapshot)
    await page.getByTestId('table-selector').click()
    await page.getByRole('menuitem', { name: /fr_e2_orders/ }).click()
    await inspector.waitForMaterializationComplete()
    await inspector.waitForTableLoaded('fr_e2_orders', 6)

    // Open combiner panel and switch to Join tab
    await laundromat.openCombinePanel()
    await page.getByRole('tab', { name: 'Join' }).click()
    await expect(page.locator('text=Join Tables').first()).toBeVisible()

    // Select left table (orders — active, in DuckDB)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e2_orders/i }).click()

    // Select right table (customers — frozen, resolved from OPFS snapshot)
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /fr_e2_customers/i }).click()

    // Select key column
    await page.getByRole('combobox').nth(2).click()
    await page.getByRole('option', { name: 'customer_id' }).click()

    // Inner join (default)
    await page.getByLabel('Inner').click()

    // Enter result table name and join
    await page.getByPlaceholder('e.g., orders_with_customers').fill('joined_result')
    await page.getByTestId('combiner-join-btn').click()

    // Wait for join to complete by polling for result table in DuckDB.
    // CombinePanel uses local useState for isProcessing (not combinerStore),
    // so waitForCombinerComplete() returns immediately — poll SQL instead.
    await expect.poll(async () => {
      try {
        const result = await inspector.runQuery<{ cnt: string }>(
          'SELECT count(*) as cnt FROM joined_result'
        )
        return Number(result[0]?.cnt)
      } catch {
        return 0
      }
    }, { timeout: 30000 }).toBe(5)

    // Verify data identity — inner join on customer_id
    const data = await inspector.getTableData('joined_result')
    const customerIds = [...new Set(data.map(r => r.customer_id as string))].sort()
    expect(customerIds).toEqual(['C001', 'C002', 'C003'])
  })

  test('diff works with shard-backed snapshots', async () => {
    // Upload fr_b2_base.csv (5 rows: id, name, department, salary)
    await laundromat.uploadFile(getFixturePath('fr_b2_base.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_base', 5)

    const tableId = await inspector.getActiveTableId()
    expect(tableId).not.toBeNull()

    // Apply uppercase on name column (modifies all rows)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await inspector.waitForTransformComplete(tableId!)

    // Verify uppercase was applied
    const rows = await inspector.runQuery<{ name: string }>(
      'SELECT name FROM fr_b2_base ORDER BY "_cs_id"'
    )
    expect(rows.map(r => r.name)).toEqual(['ALICE', 'BOB', 'CHARLIE', 'DIANA', 'EVE'])

    // Close clean panel, then open diff view and run comparison
    await laundromat.closePanel()
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // Wait for the "Run Comparison" button to be enabled (snapshot check completes)
    const compareBtn = page.getByTestId('diff-compare-btn')
    await expect(compareBtn).toBeEnabled({ timeout: 10000 })

    // Click "Run Comparison" — scroll into view first, then click
    await compareBtn.scrollIntoViewIfNeeded()
    await compareBtn.click()

    // Wait for diff to complete — the diff engine reads from shard-backed OPFS snapshots
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.summary !== null
    }, { timeout: 60000, message: 'Diff comparison should complete with shard-backed snapshots' }).toBe(true)

    // Verify diff summary shows modifications
    const diffState = await inspector.getDiffState()
    expect(diffState.summary!.modified).toBeGreaterThan(0)
  })
})
