import { test, expect, Page, Browser } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { MatchViewPage } from '../page-objects/match-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { coolHeap, coolHeapLight } from '../helpers/heap-cooling'

/**
 * Shared helper to configure and run Find Duplicates with proper thresholds.
 * Uses "Compare All" blocking strategy and lowers threshold to 60% for test data.
 */
async function runFindDuplicatesHelper(
  page: Page,
  matchView: MatchViewPage,
  inspector: StoreInspector,
  config?: { tableName?: string; columnName?: string }
) {
  const tableName = config?.tableName ?? 'fr_c1_dedupe'
  const columnName = config?.columnName ?? 'first_name'

  // Select table and column
  await matchView.selectTable(tableName)
  await matchView.selectColumn(columnName)

  // Use "Compare All" strategy (no blocking)
  await page.getByRole('radio', { name: /Compare All/i }).click()
  await inspector.waitForBlockingStrategy('none')

  // Lower maybeThreshold to 60% for test data
  await page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stores?.matcherStore as any)?.setState({ maybeThreshold: 60 })
  })

  // Click Find Duplicates and wait for completion
  await page.getByTestId('find-duplicates-btn').click()
  await inspector.waitForMergeComplete()

  // Wait for pairs to be populated
  await expect.poll(async () => {
    const state = await inspector.getMatcherState()
    return state.pairs.length
  }, { timeout: 15000 }).toBeGreaterThan(0)
}

/**
 * Feature Coverage Tests
 *
 * Uses dedicated fixture files to test PRD requirements.
 * Tests are organized by FR (Functional Requirement) identifier.
 *
 * Optimized for DuckDB-WASM cold start by using test.describe.serial
 * with shared page context - DuckDB initializes once per serial group.
 */

test.describe.serial('FR-A3: Text Cleaning Transformations', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty')
    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)
  }

  test('should trim whitespace from text fields', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[0].name).toBe('John Smith')
    expect(data[5].name).toBe('MIKE  JONES') // Internal spaces preserved, edge trimmed
  })

  test('should convert text to uppercase', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'email' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[0].email).toBe('JOHN@EXAMPLE.COM')
    expect(data[2].email).toBe('ACCENT@TEST.COM')
  })

  test('should convert text to lowercase', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'email' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[0].email).toBe('john@example.com')
    expect(data[1].email).toBe('jane@test.org')
  })

  test('should convert text to title case', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Title Case', { column: 'name' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[1].name).toBe('Jane Doe')
  })

  test('should remove accents from text', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Remove Accents', { column: 'name' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[2].name).toBe('cafe resume') // café résumé -> cafe resume
    expect(data[6].name).toBe('Sao Paulo') // São Paulo -> Sao Paulo
    expect(data[7].name).toBe('Uber driver') // Über driver -> Uber driver
  })

  test('should remove non-printable characters', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Remove Non-Printable', { column: 'name' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[3].name).toBe('BobWilson') // Tabs removed
    expect(data[4].name).toBe('AliceBrown') // Newlines removed
  })
})

test.describe.serial('FR-A3: Finance & Number Transformations', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_finance')
    await laundromat.uploadFile(getFixturePath('fr_a3_finance.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_finance', 8)
  }

  test('should unformat currency values', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Unformat Currency', { column: 'currency_value' })

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[0].currency_value).toBe(1234.56) // $1234.56 -> 1234.56
    expect(data[1].currency_value).toBe(50000.00) // $50000.00 -> 50000.00
  })

  test('should fix negative number formatting', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Fix Negatives', { column: 'formatted_negative' })

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[1].formatted_negative).toBe(-750.00) // $(750.00) -> -750.00
    expect(data[5].formatted_negative).toBe(-500) // (500) -> -500
  })

  test('should pad numbers with zeros', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Pad Zeros', { column: 'account_number', params: { length: '5' } })

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[0].account_number).toBe('00123') // 123 -> 00123
    expect(data[1].account_number).toBe('00045') // 45 -> 00045
    expect(data[5].account_number).toBe('00001') // 1 -> 00001
  })
})

test.describe.serial('FR-A3: Dates & Structure Transformations', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_dates_split')
    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)
  }

  test('should standardize date formats', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Standardize Date', {
      column: 'date_us',
      selectParams: { 'Target format': 'ISO (YYYY-MM-DD)' },
    })

    const data = await inspector.getTableData('fr_a3_dates_split')
    expect(data[0].date_us).toBe('1985-03-15') // 03/15/1985 -> 1985-03-15
    expect(data[1].date_us).toBe('1990-07-22') // 07/22/1990 -> 1990-07-22
  })

  test('should calculate age from birth date', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Calculate Age', { column: 'birth_date' })

    const data = await inspector.getTableData('fr_a3_dates_split')
    // Ages will vary based on current date, just check it's a reasonable number
    // DuckDB returns bigint for DATE_DIFF, so accept both number and bigint
    expect(['number', 'bigint']).toContain(typeof data[0].age)
    expect(Number(data[0].age)).toBeGreaterThan(30)
  })

  test('should split column by delimiter', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Split Column', {
      column: 'full_name',
      params: { delimiter: ' ' },
    })

    const data = await inspector.getTableData('fr_a3_dates_split')
    expect(data[0].full_name_1).toBe('John')
    expect(data[0].full_name_2).toBe('Smith')
  })
})

test.describe('FR-A3: Fill Down Transformation', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  // Use beforeEach with fresh page for better isolation (prevents cascade failures)
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)

    // MUST navigate BEFORE creating inspector (inspector references window.__CLEANSLATE_STORES__)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Close page to force WASM worker garbage collection
    // Check if page is already closed to prevent cascade failures
    if (!page.isClosed()) {
      try {
        await page.close()
      } catch {
        // Ignore close errors - page may already be closed
      }
    }
  })

  test('should fill down empty cells from above', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_fill_down')
    await laundromat.uploadFile(getFixturePath('fr_a3_fill_down.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_fill_down', 10)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    await picker.addTransformation('Fill Down', { column: 'region' })

    // Wait for transform to complete
    const tables = await inspector.getTables()
    const tableId = tables.find(t => t.name === 'fr_a3_fill_down')?.id
    if (tableId) {
      await inspector.waitForTransformComplete(tableId ?? undefined)
    }

    const data = await inspector.getTableData('fr_a3_fill_down')
    expect(data[0].region).toBe('North')
    expect(data[1].region).toBe('North') // Filled from above
    expect(data[2].region).toBe('North') // Filled from above
    expect(data[5].region).toBe('South')
    expect(data[6].region).toBe('South') // Filled from above
  })
})

test.describe.serial('FR-A6: Ingestion Wizard', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  test('should show raw preview of file content', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a6_legacy_garbage')
    await laundromat.uploadFile(getFixturePath('fr_a6_legacy_garbage.csv'))
    await wizard.waitForOpen()

    // Fail-fast guard: Assert raw-preview element exists before proceeding
    await expect(page.getByTestId('raw-preview')).toBeVisible({ timeout: 1000 })

    // Verify raw preview content
    const previewText = await wizard.getRawPreviewText()
    expect(previewText).toContain('ACME Corp Report Generator')
    expect(previewText).toContain('Widget A')

    await wizard.cancel()
  })

  test('should detect and skip garbage header rows', async () => {
    // Refresh page to ensure clean state after wizard cancel
    await laundromat.goto()
    await inspector.waitForDuckDBReady()

    await inspector.runQuery('DROP TABLE IF EXISTS fr_a6_legacy_garbage')
    await laundromat.uploadFile(getFixturePath('fr_a6_legacy_garbage.csv'))
    await wizard.waitForOpen()

    // Wizard should show preview - user can select header row
    // Header is on row 5 (0-indexed: row 4)
    await wizard.selectHeaderRow(5)
    await wizard.import()

    await inspector.waitForTableLoaded('fr_a6_legacy_garbage', 5)

    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(5)

    // Verify column names come from correct header row
    const columns = tables[0].columns.map((c) => c.name)
    expect(columns).toContain('id')
    expect(columns).toContain('product')
    expect(columns).toContain('quantity')
  })

  test('should handle Row 1 header selection (boundary)', async () => {
    // Refresh page to ensure clean state
    await laundromat.goto()
    await inspector.waitForDuckDBReady()

    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty')
    // Upload file where row 1 IS the header (standard CSV)
    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.selectHeaderRow(1) // Boundary: first row is header
    await wizard.import()

    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    // Verify header parsed correctly from row 1
    const tables = await inspector.getTables()
    const textDirtyTable = tables.find((t) => t.name === 'fr_a3_text_dirty')
    expect(textDirtyTable).toBeDefined()
    expect(textDirtyTable!.columns.map((c) => c.name)).toContain('id')
    expect(textDirtyTable!.columns.map((c) => c.name)).toContain('name')
    expect(textDirtyTable!.columns.map((c) => c.name)).toContain('email')
  })
})

test.describe.serial('FR-C1: Fuzzy Matcher', () => {
  let browser: Browser
  let context: import('@playwright/test').BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let matchView: MatchViewPage
  let inspector: StoreInspector

  // Prevent DuckDB cold start timeout + allow time for matcher operations
  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Create fresh CONTEXT for each test - provides true isolation including WASM module state
    // See: https://playwright.dev/docs/browser-contexts
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    matchView = new MatchViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Wrap cleanup in try-catch - if page crashed, still close context
    try {
      // Aggressive cleanup for memory-intensive matcher tests
      await coolHeap(page, inspector, {
        dropTables: true,
        closePanels: true,
        clearDiffState: true,
        pruneAudit: true,
      })

      // Also clear matcherStore state explicitly
      await page.evaluate(() => {
        const stores = (window as any).__CLEANSLATE_STORES__
        const matcherStore = stores?.matcherStore?.getState?.()
        if (matcherStore?.reset) {
          matcherStore.reset()
        }
      })
    } catch (error) {
      console.warn('[FR-C1 afterEach] Cleanup failed (page may have crashed):', error)
    }

    // Close CONTEXT (not just page) to fully release WASM memory
    await context.close()
  })

  async function loadDedupeData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_c1_dedupe')
    await laundromat.uploadFile(getFixturePath('fr_c1_dedupe.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_c1_dedupe', 8)
  }

  /**
   * Configure matcher and run find duplicates.
   * Sets maybeThreshold to 60% to match test data (John/Jon=75%, Jane/Janet=60%, Sarah/Sara=80%).
   */
  async function runFindDuplicates(config?: { tableName?: string; columnName?: string }) {
    await runFindDuplicatesHelper(page, matchView, inspector, config)
  }

  test('should open match view and find duplicates with similarity percentages', async () => {
    await loadDedupeData()

    // Open match view via toolbar (full-screen overlay)
    await laundromat.openMatchView()
    await matchView.waitForOpen()

    // Verify match view is open with correct title
    await expect(page.getByText('DUPLICATE FINDER')).toBeVisible()

    // Run find duplicates using helper
    await runFindDuplicates()

    // Verify pairs are displayed with similarity percentages (use store instead of DOM)
    const matcherState = await inspector.getMatcherState()
    expect(matcherState.pairs.length).toBeGreaterThanOrEqual(2) // Expect John/Jon, Jane/Janet, Sarah/Sara

    // Verify "% Similar" format is displayed in UI
    await expect(page.locator('text=/\\d+% Similar/').first()).toBeVisible()
    // Verify pair contains expected matches
    await expect(page.locator('text=/John/').first()).toBeVisible()
  })

  test('should mark pairs as merged and display apply bar', async () => {
    // Independent test: Load data and find duplicates
    await loadDedupeData()
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates()

    // Get initial stats (use store instead of DOM scraping)
    const initialState = await inspector.getMatcherState()
    expect(initialState.stats.merged).toBe(0)

    // Mark first pair as merged
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      return state.stats.merged
    }, { timeout: 5000 }).toBe(1)

    // Verify stats updated
    const afterMergeState = await inspector.getMatcherState()
    expect(afterMergeState.stats.merged).toBe(1)

    // Verify Apply Merges bar is visible
    const hasApplyBar = await matchView.hasApplyMergesBar()
    expect(hasApplyBar).toBe(true)
  })

  test('should apply merges and refresh DataGrid row count', async () => {
    // Independent test: Load data, find duplicates, and merge
    await loadDedupeData()
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates()

    // Get initial row count
    const tablesBefore = await inspector.getTables()
    const dedupeTableBefore = tablesBefore.find((t) => t.name === 'fr_c1_dedupe')
    const initialRowCount = dedupeTableBefore?.rowCount || 0
    expect(initialRowCount).toBe(8)

    // Mark first pair as merged
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      const stats = state.stats
      return stats.merged
    }, { timeout: 5000 }).toBe(1)

    // Apply merges (will close the match view)
    await matchView.applyMerges()
    await inspector.waitForMergeComplete()

    // Verify table row count decreased
    const tablesAfter = await inspector.getTables()
    const dedupeTableAfter = tablesAfter.find((t) => t.name === 'fr_c1_dedupe')
    const newRowCount = dedupeTableAfter?.rowCount || 0

    // Should have removed 1 row (the merged duplicate)
    expect(newRowCount).toBeLessThan(initialRowCount)
    expect(newRowCount).toBe(7) // 8 - 1 merged pair = 7

    // Verify DataGrid refresh - this tests the bug fix (rowCount dependency)
    await inspector.waitForGridReady()
    const rowCountText = await laundromat.getRowCount()
    expect(rowCountText).toContain('7')
  })

  test('should log merge operations to audit', async () => {
    // Independent test: Load data, find duplicates, merge, and apply
    await loadDedupeData()
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates()
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      const stats = state.stats
      return stats.merged
    }, { timeout: 5000 }).toBe(1)
    await matchView.applyMerges()
    await inspector.waitForMergeComplete()

    // Wait for match panel to fully close and UI to stabilize
    await expect(page.getByText('Merges Applied')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('data-grid')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('match-view')).toBeHidden({ timeout: 5000 })
    await inspector.waitForGridReady()

    // Open audit sidebar to verify the merge was logged
    await laundromat.openAuditSidebar()
    const auditSidebar = page.locator('[data-testid="audit-sidebar"]')
    await expect(auditSidebar).toBeVisible({ timeout: 5000 })

    // Rule 1: Assert exact action text, not regex pattern (high-fidelity)
    const mergeAuditEntry = page.getByText('Merge Duplicates', { exact: true })
    await expect(mergeAuditEntry).toBeVisible({ timeout: 5000 })

    // Rule 3: Verify it has row details indicator (visual validation)
    const entryWithDetails = auditSidebar.locator('.cursor-pointer').filter({ hasText: 'Merge Duplicates' })
    await expect(entryWithDetails).toBeVisible()

    // Close audit sidebar
    await laundromat.closeAuditSidebar()
  })
})

test.describe.serial('FR-C1: Merge Audit Drill-Down', () => {
  let browser: Browser
  let context: import('@playwright/test').BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let matchView: MatchViewPage
  let inspector: StoreInspector

  // Prevent DuckDB cold start timeout + allow time for matcher operations
  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Create fresh CONTEXT for each test - provides true isolation including WASM module state
    // See: https://playwright.dev/docs/browser-contexts
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    matchView = new MatchViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Wrap cleanup in try-catch - if page crashed, still close context
    try {
      // Aggressive cleanup for memory-intensive matcher tests
      await coolHeap(page, inspector, {
        dropTables: true,
        closePanels: true,
        clearDiffState: true,
        pruneAudit: true,
      })

      // Also clear matcherStore state explicitly
      await page.evaluate(() => {
        const stores = (window as any).__CLEANSLATE_STORES__
        const matcherStore = stores?.matcherStore?.getState?.()
        if (matcherStore?.reset) {
          matcherStore.reset()
        }
      })
    } catch (error) {
      console.warn('[FR-C1 Merge afterEach] Cleanup failed (page may have crashed):', error)
    }

    // Close CONTEXT (not just page) to fully release WASM memory
    await context.close()
  })

  async function runFindDuplicates(config?: { tableName?: string; columnName?: string }) {
    await runFindDuplicatesHelper(page, matchView, inspector, config)
  }

  async function loadDedupeData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_c1_dedupe')
    await laundromat.uploadFile(getFixturePath('fr_c1_dedupe.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_c1_dedupe', 8)
  }

  test('should display row data in merge audit drill-down', async () => {
    // Note: This test depends on the Fuzzy Matcher finding duplicates.
    // If FR-C1: Fuzzy Matcher tests are failing, this test will also fail.
    // The code fix (escapeForSql) is verified by the _merge_audit_details table structure test.

    // Load dedupe data
    await loadDedupeData()

    // Open match view and find duplicates
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates()

    // Merge a pair
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      const stats = state.stats
      return stats.merged
    }, { timeout: 5000 }).toBe(1)

    // Apply merges
    await matchView.applyMerges()
    await inspector.waitForMergeComplete()

    // Wait for success toast to appear
    await expect(page.getByText('Merges Applied')).toBeVisible({ timeout: 5000 })

    // Ensure we're back at the main view by checking the grid is visible
    await expect(page.getByTestId('data-grid')).toBeVisible({ timeout: 5000 })

    // Wait for match view to be fully closed
    await expect(page.getByTestId('match-view')).toBeHidden({ timeout: 5000 })
    await inspector.waitForGridReady()

    // Debug: Check if audit entry was created
    const auditEntries = await inspector.getAuditEntries()
    // console.log('Audit entries:', auditEntries.length)
    const mergeEntry = auditEntries.find(e => e.action === 'Merge Duplicates')
    // console.log('Merge entry:', mergeEntry)
    expect(mergeEntry).toBeDefined()
    expect(mergeEntry?.hasRowDetails).toBe(true)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    const auditSidebar = page.locator('[data-testid="audit-sidebar"]')
    await expect(auditSidebar).toBeVisible({ timeout: 5000 })

    // Click on the Apply Merges audit entry (it has row details)
    await page.locator('[data-testid="audit-entry-with-details"]').first().click()

    // Wait for the modal to open
    await expect(page.getByTestId('audit-detail-modal')).toBeVisible({ timeout: 5000 })

    // Wait for modal animation to complete (Radix UI pattern)
    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // Verify KEPT and DELETED sections are visible with actual data
    await expect(page.getByText('KEPT')).toBeVisible()
    await expect(page.getByText('DELETED')).toBeVisible()

    // Verify column data is rendered (proves data parsing worked)
    await expect(page.locator('text=/first_name:/').first()).toBeVisible({ timeout: 5000 })

    // Close modal
    await page.keyboard.press('Escape')
    await laundromat.closeAuditSidebar()
  })

  test('should handle special characters in merge audit', async () => {
    // Load special characters fixture
    await inspector.runQuery('DROP TABLE IF EXISTS fr_c1_special_chars')
    await laundromat.uploadFile(getFixturePath('fr_c1_special_chars.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_c1_special_chars', 4)

    // Open match view and find duplicates
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates({ tableName: 'fr_c1_special_chars', columnName: 'name' })

    // Merge a pair (O'Brien / O'Brian should match)
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      const stats = state.stats
      return stats.merged
    }, { timeout: 5000 }).toBe(1)

    // Apply merges
    await matchView.applyMerges()
    await inspector.waitForMergeComplete()

    // Open audit sidebar and drill-down
    await laundromat.openAuditSidebar()
    const auditSidebar = page.locator('[data-testid="audit-sidebar"]')
    await expect(auditSidebar).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="audit-entry-with-details"]').first().click()
    await expect(page.getByTestId('audit-detail-modal')).toBeVisible({ timeout: 5000 })

    // Wait for modal animation to complete (Radix UI pattern)
    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // Verify data with special characters (quotes) is displayed correctly
    // The merged pairs are "John "Jack" Smith" and "Jon "Jackie" Smyth"
    await expect(page.locator('text=/Smith|Smyth/').first()).toBeVisible({ timeout: 5000 })

    // Close modal
    await page.keyboard.press('Escape')
    await laundromat.closeAuditSidebar()
  })

  test('should export merge details as CSV', async () => {
    // Independent test: Load data, find duplicates, merge, and apply
    await loadDedupeData()
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates()
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      const stats = state.stats
      return stats.merged
    }, { timeout: 5000 }).toBe(1)
    await matchView.applyMerges()
    await inspector.waitForMergeComplete()

    // Wait for merge to complete and return to main view
    await expect(page.getByText('Merges Applied')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('data-grid')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('match-view')).toBeHidden({ timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await inspector.waitForGridReady()

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    const auditSidebar = page.locator('[data-testid="audit-sidebar"]')
    await expect(auditSidebar).toBeVisible({ timeout: 5000 })

    // Click on an audit entry with details
    await page.locator('[data-testid="audit-entry-with-details"]').first().click()
    await expect(page.getByTestId('audit-detail-modal')).toBeVisible({ timeout: 5000 })

    // Wait for modal animation to complete (Radix UI pattern)
    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // Setup download listener
    const downloadPromise = page.waitForEvent('download')

    // Click Export CSV button
    await page.getByTestId('audit-detail-export-csv-btn').click()

    // Wait for download
    const download = await downloadPromise
    const filename = download.suggestedFilename()

    // Verify filename pattern
    expect(filename).toMatch(/merge_details_.*\.csv/)

    // Close modal
    await page.keyboard.press('Escape')
    await laundromat.closeAuditSidebar()
  })

  test('should store valid JSON in _merge_audit_details table', async () => {
    // Independent test: Load data, find duplicates, merge, and apply
    await loadDedupeData()
    await laundromat.openMatchView()
    await matchView.waitForOpen()
    await runFindDuplicates()
    await matchView.mergePair(0)
    await expect.poll(async () => {
      const state = await inspector.getMatcherState()
      const stats = state.stats
      return stats.merged
    }, { timeout: 5000 }).toBe(1)
    await matchView.applyMerges()
    await inspector.waitForMergeComplete()

    // Wait for merge to complete
    await expect(page.getByText('Merges Applied')).toBeVisible({ timeout: 5000 })

    // Query the merge audit details table directly
    const auditDetails = await inspector.runQuery(`
      SELECT kept_row_data, deleted_row_data
      FROM _merge_audit_details
      LIMIT 1
    `)

    // Verify we have data
    expect(auditDetails.length).toBeGreaterThan(0)

    // Verify JSON is valid by parsing it
    const row = auditDetails[0] as { kept_row_data: string; deleted_row_data: string }
    let keptData: Record<string, unknown> | null = null
    let deletedData: Record<string, unknown> | null = null

    try {
      keptData = JSON.parse(row.kept_row_data)
      deletedData = JSON.parse(row.deleted_row_data)
    } catch (e) {
      // If parse fails, test fails
      expect(e).toBeNull()
    }

    // Verify the parsed data has columns
    expect(Object.keys(keptData!).length).toBeGreaterThan(0)
    expect(Object.keys(deletedData!).length).toBeGreaterThan(0)
  })
})
test.describe('FR-D2: Obfuscation (Smart Scrubber)', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // Use beforeEach with fresh page for better isolation (Tier 2 scrubber operations)
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)

    // MUST navigate BEFORE creating inspector (inspector references window.__CLEANSLATE_STORES__)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Skip cleanup if page is already closed (prevents cascade failures)
    if (page.isClosed()) {
      return
    }

    // Aggressive cleanup with page close for WASM garbage collection
    try {
      await coolHeap(page, inspector, {
        dropTables: true,
        closePanels: true,
        clearDiffState: true,
      })
    } catch {
      // Ignore cleanup errors to prevent cascade failures
    }

    try {
      await page.close()
    } catch {
      // Ignore close errors - page may already be closed
    }
  })

  async function loadPIIData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_d2_pii')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_d2_pii_scrubbed')
    await laundromat.uploadFile(getFixturePath('fr_d2_pii.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_d2_pii', 5)
  }

  test('should load scrubber panel', async () => {
    // Load test data
    await loadPIIData()

    // Open scrub panel via toolbar (single-page app)
    await laundromat.openScrubPanel()
    await expect(page.getByRole('heading', { name: 'Scrub Data' })).toBeVisible()
  })

  test('should hash sensitive columns', async () => {
    // Load fresh data for this test
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('panel-scrub')).toBeHidden({ timeout: 2000 }).catch(() => {})
    await loadPIIData()

    // Open scrub panel
    await laundromat.openScrubPanel()
    await expect(page.getByRole('heading', { name: 'Scrub Data' })).toBeVisible()

    // Select the table (use first() to avoid strict mode issues with duplicates)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_d2_pii/i }).first().click()
    await expect(page.getByTestId('method-select-ssn')).toBeVisible()

    // Select hash method for SSN column using data-testid
    await page.getByTestId('method-select-ssn').click()
    await page.getByRole('option', { name: /Hash/i }).first().click()
    await expect(page.getByPlaceholder(/secret/i)).toBeVisible()

    // Enter project secret
    await page.getByPlaceholder(/secret/i).fill('test-secret-123')

    // Apply scrubbing (now modifies in-place via command pattern)
    await page.getByRole('button', { name: /Apply Scrub Rules/i }).click()

    // Wait for scrubbing to complete by polling for hashed data
    // (waitForTransformComplete doesn't work for scrub operations)
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_d2_pii')
      return data[0]?.ssn
    }, { timeout: 15000 }).toMatch(/^[a-f0-9]{32}$/)

    // Verify hash format (32-char hex from MD5)
    const data = await inspector.getTableData('fr_d2_pii')
    expect(data.length).toBeGreaterThan(0)

    // Rule 2: Assert specific hash format for both and explicit uniqueness check
    const hash0 = data[0].ssn as string
    const hash1 = data[1].ssn as string
    expect(hash0).toMatch(/^[a-f0-9]{32}$/)
    expect(hash1).toMatch(/^[a-f0-9]{32}$/)
    // Row 0 and Row 1 have different SSNs so hashes should be different
    expect(hash0 !== hash1).toBe(true)
  })

  test('should redact PII patterns', async () => {
    // Load fresh data for this test
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('panel-scrub')).toBeHidden({ timeout: 2000 }).catch(() => {})
    await loadPIIData()

    // Open scrub panel
    await laundromat.openScrubPanel()
    await expect(page.getByRole('heading', { name: 'Scrub Data' })).toBeVisible()

    // Select the table (use first() to avoid strict mode issues with duplicates)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_d2_pii/i }).first().click()
    await expect(page.getByTestId('method-select-email')).toBeVisible()

    // Select redact method for email column
    await page.getByTestId('method-select-email').click()
    await page.getByRole('option', { name: /Redact/i }).first().click()
    await expect(page.getByPlaceholder(/secret/i)).toBeVisible()

    // Enter project secret (needed for the panel to enable Apply button)
    await page.getByPlaceholder(/secret/i).fill('test-secret-123')

    // Apply scrubbing (now modifies in-place via command pattern)
    await page.getByRole('button', { name: /Apply Scrub Rules/i }).click()

    // Wait for scrubbing to complete by polling for redacted data
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_d2_pii')
      return data[0]?.email
    }, { timeout: 15000 }).toBe('[REDACTED]')

    // Verify redaction (same table, modified in-place)
    const data = await inspector.getTableData('fr_d2_pii')
    expect(data.length).toBeGreaterThan(0)
    expect(data[1].email).toBe('[REDACTED]')
  })

  test('should mask partial values', async () => {
    // Load fresh data for this test
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('panel-scrub')).toBeHidden({ timeout: 2000 }).catch(() => {})
    await loadPIIData()

    // Open scrub panel
    await laundromat.openScrubPanel()
    await expect(page.getByRole('heading', { name: 'Scrub Data' })).toBeVisible()

    // Select the table (use first() to avoid strict mode issues with duplicates)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_d2_pii/i }).first().click()
    await expect(page.getByTestId('method-select-full_name')).toBeVisible()

    // Select mask method for full_name column
    await page.getByTestId('method-select-full_name').click()
    await page.getByRole('option', { name: /Mask/i }).first().click()
    await expect(page.getByPlaceholder(/secret/i)).toBeVisible()

    // Enter project secret (needed for the panel to enable Apply button)
    await page.getByPlaceholder(/secret/i).fill('test-secret-123')

    // Apply scrubbing (now modifies in-place via command pattern)
    await page.getByRole('button', { name: /Apply Scrub Rules/i }).click()

    // Wait for scrubbing to complete by polling for masked data
    // "John Smith" should become something like "J*******h"
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_d2_pii')
      return data[0]?.full_name
    }, { timeout: 15000 }).toMatch(/^J\*+h$/)

    // Verify masking complete
    const data = await inspector.getTableData('fr_d2_pii')
    expect(data.length).toBeGreaterThan(0)
  })

  test('should extract year only from dates', async () => {
    // Load fresh data for this test
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('panel-scrub')).toBeHidden({ timeout: 2000 }).catch(() => {})
    await loadPIIData()

    // Open scrub panel
    await laundromat.openScrubPanel()
    await expect(page.getByRole('heading', { name: 'Scrub Data' })).toBeVisible()

    // Select the table (use first() to avoid strict mode issues with duplicates)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_d2_pii/i }).first().click()
    await expect(page.getByTestId('method-select-birth_date')).toBeVisible()

    // Select year_only method for birth_date column
    await page.getByTestId('method-select-birth_date').click()
    await page.getByRole('option', { name: /Year Only/i }).first().click()
    await expect(page.getByPlaceholder(/secret/i)).toBeVisible()

    // Enter project secret (needed for the panel to enable Apply button)
    await page.getByPlaceholder(/secret/i).fill('test-secret-123')

    // Apply scrubbing (now modifies in-place via command pattern)
    await page.getByRole('button', { name: /Apply Scrub Rules/i }).click()

    // Wait for scrubbing to complete by polling for year_only data
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_d2_pii')
      return data[0]?.birth_date
    }, { timeout: 15000 }).toBe('1985-01-01')

    // Verify year_only: 1985-03-15 -> 1985-01-01
    const data = await inspector.getTableData('fr_d2_pii')
    expect(data.length).toBeGreaterThan(0)
    expect(data[1].birth_date).toBe('1990-01-01') // Original: 1990-07-22
  })
})

test.describe('FR-E1: Combiner - Stack Files', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // Extended timeout for combiner operations (Tier 2 tests)
  test.setTimeout(90000)

  // Fresh page per test - required for Tier 2 (combiner) tests per e2e/CLAUDE.md
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    await coolHeapLight(page)
    await page.close() // Force WASM worker garbage collection
  })

  test('should stack two CSV files with Union All', async () => {
    // Clean up any existing tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_e1_jan_sales')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_e1_feb_sales')
    await inspector.runQuery('DROP TABLE IF EXISTS stacked_result')

    // Upload first file (page is already on laundromat from beforeAll)
    await laundromat.uploadFile(getFixturePath('fr_e1_jan_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_jan_sales', 4)

    // Upload second file
    await laundromat.uploadFile(getFixturePath('fr_e1_feb_sales.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e1_feb_sales', 5)

    // Open combine panel via toolbar (single-page app)
    await laundromat.openCombinePanel()
    await expect(page.locator('text=Stack').first()).toBeVisible()

    // Select Stack tab (should be default)
    await expect(page.getByTestId('combiner-stack-tab')).toBeVisible()

    // Add first table
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e1_jan_sales/i }).click()
    await page.getByRole('button', { name: 'Add' }).click()

    // Add second table
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e1_feb_sales/i }).click()
    await page.getByRole('button', { name: 'Add' }).click()

    // Enter result table name
    await page.getByPlaceholder('e.g., combined_sales').fill('stacked_result')

    // Click Stack Tables button
    await page.getByTestId('combiner-stack-btn').click()

    // Wait for the operation to complete (toast notification)
    await expect(page.getByText('Tables Stacked', { exact: true })).toBeVisible({ timeout: 5000 })

    // Verify via SQL - should have 9 rows (4+5)
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM stacked_result')
    expect(Number(result[0].cnt)).toBe(9)

    // Verify data integrity - check sale_ids from both files (J=Jan, F=Feb)
    // Rule 1: Verify exact sale_id values
    const data = await inspector.getTableData('stacked_result', 9)
    const saleIds = data.map((r) => r.sale_id as string)
    const janIds = saleIds.filter((id) => id.startsWith('J')).sort()
    const febIds = saleIds.filter((id) => id.startsWith('F')).sort()
    expect(janIds).toEqual(['J001', 'J002', 'J003', 'J004'])
    expect(febIds).toEqual(['F001', 'F002', 'F003', 'F004', 'F005'])
  })
})

test.describe('FR-E2: Combiner - Join Files', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  // Extended timeout for join operations (Tier 2 tests)
  test.setTimeout(90000)

  // Fresh page per test - required for Tier 2 (join) tests per e2e/CLAUDE.md
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Full cleanup with page close for WASM garbage collection
    await coolHeap(page, inspector, {
      dropTables: true,
      closePanels: true,
      clearDiffState: true,
      pruneAudit: true,
      auditThreshold: 30
    })
    await page.close()
  })

  test('should perform inner join on customer_id', async () => {
    // Upload orders file (page is already on laundromat from beforeAll)
    // CREATE OR REPLACE TABLE will handle any existing tables
    await laundromat.uploadFile(getFixturePath('fr_e2_orders.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e2_orders', 6)

    // Upload customers file
    await laundromat.uploadFile(getFixturePath('fr_e2_customers.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e2_customers', 4)

    // Open combine panel via toolbar (single-page app)
    await laundromat.openCombinePanel()
    await expect(page.locator('text=Stack').first()).toBeVisible()

    // Switch to Join tab and wait for it to be active
    await page.getByRole('tab', { name: 'Join' }).click()
    await expect(page.locator('text=Join Tables').first()).toBeVisible()

    // Select left table (orders)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e2_orders/i }).click()

    // Select right table (customers)
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /fr_e2_customers/i }).click()

    // Select key column
    await page.getByRole('combobox').nth(2).click()
    await page.getByRole('option', { name: 'customer_id' }).click()

    // Inner join should be default, but let's make sure
    await page.getByLabel('Inner').click()

    // Enter result table name
    await page.getByPlaceholder('e.g., orders_with_customers').fill('join_result')

    // Click Join Tables button
    await page.getByTestId('combiner-join-btn').click()

    // Wait for combiner operation to fully complete
    await inspector.waitForCombinerComplete()

    // Wait for the operation to complete (toast notification)
    await expect(page.getByText('Tables Joined', { exact: true })).toBeVisible({ timeout: 5000 })

    // Verify result count via SQL - inner join excludes non-matching rows
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM join_result')
    // Inner join: only rows where customer_id matches (C001, C002, C003 have orders)
    expect(Number(result[0].cnt)).toBe(5)
    // Rule 1: Verify specific customer IDs in join
    const data = await inspector.getTableData('join_result')
    const customerIds = [...new Set(data.map((r) => r.customer_id as string))].sort()
    expect(customerIds).toEqual(['C001', 'C002', 'C003'])

    // Close panel to prevent state pollution
    await laundromat.closePanel()
  })

  test('should perform left join preserving unmatched orders', async () => {
    // Upload orders file
    // CREATE OR REPLACE TABLE will handle any existing tables from previous test
    await laundromat.uploadFile(getFixturePath('fr_e2_orders.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e2_orders', 6)

    // Upload customers file
    await laundromat.uploadFile(getFixturePath('fr_e2_customers.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_e2_customers', 4)

    // Wait for grid to be ready before opening panel
    await inspector.waitForGridReady()

    // Open combine panel via page object (consistent with first test)
    await laundromat.openCombinePanel()
    await expect(page.locator('text=Stack').first()).toBeVisible()

    // Switch to Join tab and wait for it to be active
    await page.getByRole('tab', { name: 'Join' }).click()
    await expect(page.locator('text=Join Tables').first()).toBeVisible()
    await expect(page.getByRole('combobox').first()).toBeVisible()

    // Select left table (orders) - use .first() to handle duplicate entries from previous tests
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e2_orders/i }).first().click()
    await expect(page.getByRole('combobox').nth(1)).toBeVisible()

    // Select right table (customers)
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /fr_e2_customers/i }).first().click()
    await expect(page.getByRole('combobox').nth(2)).toBeVisible()

    // Select key column
    await page.getByRole('combobox').nth(2).click()
    await page.getByRole('option', { name: 'customer_id' }).click()
    await expect(page.getByLabel(/left/i)).toBeVisible()

    // The dropdown should auto-close after selection, no need to press Escape
    // Just verify Join tab is still visible
    await expect(page.locator('text=Join Tables').first()).toBeVisible()

    // Select Left join type - click directly without pressing Escape first
    const leftRadio = page.getByLabel(/left/i)
    await expect(leftRadio).toBeVisible({ timeout: 5000 })
    await leftRadio.click({ force: true })
    await expect(page.getByPlaceholder('e.g., orders_with_customers')).toBeVisible()

    // Enter result table name
    await page.getByPlaceholder('e.g., orders_with_customers').fill('join_result')

    // Click Join Tables button
    await page.getByTestId('combiner-join-btn').click()

    // Wait for combiner operation to fully complete
    await inspector.waitForCombinerComplete()

    // Wait for the operation to complete (toast notification)
    await expect(page.getByText('Tables Joined', { exact: true })).toBeVisible({ timeout: 5000 })

    // Verify all orders preserved (left join keeps unmatched rows)
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM join_result')
    expect(Number(result[0].cnt)).toBe(6)

    // Rule 1: Assert identity, not just cardinality
    const unmatched = await inspector.runQuery(`
      SELECT order_id, customer_id, product, name, email
      FROM join_result
      WHERE name IS NULL
      ORDER BY order_id
    `)

    // Exact count
    expect(unmatched.length).toBe(1)

    // Exact identity - verify which order is unmatched
    expect(unmatched[0].order_id).toBe('O005')
    expect(unmatched[0].customer_id).toBe('C004')
    expect(unmatched[0].product).toBe('Headphones')
    expect(unmatched[0].name).toBeNull()
    expect(unmatched[0].email).toBeNull()
  })
})

test.describe.serial('FR-A4: Manual Cell Editing', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  async function loadTestData() {
    // IMPORTANT: Reload to ensure clean state - prevents getting stuck in previous screen
    await page.reload()
    await inspector.waitForDuckDBReady()

    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty')
    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)
  }

  test('should show dirty indicator on edited cells', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Verify undo/redo buttons exist (basic UI check)
    await expect(laundromat.undoButton).toBeVisible()
    await expect(laundromat.redoButton).toBeVisible()

    // Rule 3: Actually perform a cell edit and verify dirty state in store
    await laundromat.editCell(0, 1, 'EDITED_VALUE')

    // Wait for edit to complete by polling the store
    await expect.poll(async () => {
      const dirtyState = await inspector.getEditDirtyState()
      return dirtyState.hasDirtyEdits
    }, { timeout: 5000 }).toBe(true)

    // Verify dirty state via store inspection (canvas grid has no DOM dirty indicators)
    const dirtyState = await inspector.getEditDirtyState()
    expect(dirtyState.hasDirtyEdits).toBe(true)
    expect(dirtyState.dirtyCount).toBeGreaterThan(0)
  })

  test('should commit cell edit and record in audit log', async () => {
    // Load data using helper to ensure clean state
    await loadTestData()

    // Fail-fast guard: Verify editStore has recordEdit function exposed
    const hasEditStore = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      return !!stores?.editStore
    })
    expect(hasEditStore).toBe(true)

    // 2. Get original value via SQL
    const originalData = await inspector.getTableData('fr_a3_text_dirty')
    const originalName = originalData[0].name

    // 3. Edit cell [row 0, col 1 (name column)]
    await laundromat.editCell(0, 1, 'EDITED_VALUE')

    // 4. Wait for edit to be committed to DuckDB, then verify via query
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_a3_text_dirty')
      return data[0].name
    }, { timeout: 10000 }).toBe('EDITED_VALUE')

    const updatedData = await inspector.getTableData('fr_a3_text_dirty')
    expect(updatedData[0].name).toBe('EDITED_VALUE')

    // 5. Verify Type B audit entry (CRITICAL for compliance)
    const auditEntries = await inspector.getAuditEntries()
    const editEntry = auditEntries.find((e) => e.entryType === 'B')

    expect(editEntry).toBeDefined()
    expect(editEntry?.action).toContain('Manual Edit')
    expect(editEntry?.previousValue).toBe(originalName)
    expect(editEntry?.newValue).toBe('EDITED_VALUE')
    // Implementation uses csId (stable cell identifier) instead of rowIndex
    expect(editEntry?.csId).toBeDefined()
    expect(editEntry?.columnName).toBe('name')
  })

  test('should undo/redo cell edits', async () => {
    // Load data using helper to ensure clean state
    await loadTestData()

    // Fail-fast guard: Verify timelineStore has undo/redo functions exposed via getState()
    const hasUndoRedo = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const timelineStore = stores?.timelineStore as { getState: () => { canUndo?: (tableId: string) => boolean; canRedo?: (tableId: string) => boolean } } | undefined
      const state = timelineStore?.getState?.()
      return typeof state?.canUndo === 'function' && typeof state?.canRedo === 'function'
    })
    expect(hasUndoRedo).toBe(true)

    const originalData = await inspector.getTableData('fr_a3_text_dirty')
    const originalName = originalData[0].name

    // Get the tableId for this table (needed for timeline checks)
    // Note: tableStore.tables is an array of TableInfo objects, not a Map
    const tableId = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableStore = stores?.tableStore as any
      const state = tableStore?.getState?.()
      const tables = state?.tables as Array<{ id: string; name: string }> | undefined
      if (!tables) return null
      const table = tables.find(t => t.name === 'fr_a3_text_dirty')
      return table?.id ?? null
    })
    expect(tableId).not.toBeNull()

    // Edit cell - wait for edit to be committed to DuckDB
    await laundromat.editCell(0, 1, 'CHANGED')
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_a3_text_dirty')
      return data[0].name
    }, { timeout: 10000 }).toBe('CHANGED')

    // Wait for the timeline to be updated with the cell edit command
    await expect.poll(async () => {
      const timelineInfo = await page.evaluate((tblId: string) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timelineStore = stores?.timelineStore as any
        const state = timelineStore?.getState?.()
        const timelines = state?.timelines as Map<string, { commands: unknown[] }> | undefined
        const timeline = timelines?.get(tblId)
        return timeline?.commands.length ?? 0
      }, tableId as string)
      return timelineInfo
    }, { timeout: 10000, message: 'Timeline command was not added' }).toBeGreaterThan(0)

    // Verify undo button is enabled (canUndo should be true)
    await expect(laundromat.undoButton).toBeEnabled()

    // Click undo button to undo the cell edit
    await laundromat.undoButton.click()

    // Wait for position change - polling for the undo to complete
    await expect.poll(async () => {
      const position = await page.evaluate((tblId: string) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timelineStore = stores?.timelineStore as any
        const state = timelineStore?.getState?.()
        const timelines = state?.timelines as Map<string, { currentPosition: number }> | undefined
        const timeline = timelines?.get(tblId)
        return timeline?.currentPosition ?? null
      }, tableId as string)
      return position
    }, { timeout: 5000, message: 'Undo did not change timeline position from 0 to -1' }).toBe(-1)

    // Poll for data change since Fast Path (inverse SQL) doesn't use isReplaying flag
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_a3_text_dirty')
      return data[0].name
    }, { timeout: 15000, message: 'Undo did not restore original value' }).toBe(originalName)

    // Click redo button to redo the cell edit
    await laundromat.redoButton.click()

    // Poll for data change
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_a3_text_dirty')
      return data[0].name
    }, { timeout: 15000, message: 'Redo did not reapply edited value' }).toBe('CHANGED')
  })
})

test.describe.serial('Persist as Table', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.afterEach(async () => {
    // Lightweight cleanup (no table drops for fast tests)
    await coolHeapLight(page)
  })

  test('should create duplicate table with new name', async () => {
    // 1. Load and transform data
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data_v2')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // 2. Apply transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    // 3. Click Persist button
    await page.getByTestId('persist-table-btn').click()

    // 4. Enter new table name in dialog
    await page.getByLabel(/table name/i).fill('basic_data_v2')
    await page.getByRole('button', { name: /create/i }).click()

    // 5. Verify new table created
    await inspector.waitForTableLoaded('basic_data_v2', 5)
    const tables = await inspector.getTables()
    expect(tables.some((t) => t.name === 'basic_data_v2')).toBe(true)

    // 6. Verify data was persisted correctly with uppercase transformation
    const data = await inspector.getTableData('basic_data_v2')
    const names = data.map(r => r.name as string).sort()
    expect(names).toContain('JOHN DOE') // Verify uppercase applied
    expect(names).toContain('JANE SMITH')
    expect(names).toContain('BOB JOHNSON')
  })

  test('should log persist operation to audit', async () => {
    // Independent test: Load data, transform, and persist
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data_v3')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Apply transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    // Persist table
    await page.getByTestId('persist-table-btn').click()
    await page.getByLabel(/table name/i).fill('basic_data_v3')
    await page.getByRole('button', { name: /create/i }).click()
    await inspector.waitForTableLoaded('basic_data_v3', 5)

    // Verify audit entry was created (use polling - audit writes are async)
    // The action name is 'Table Persisted' (see App.tsx addAuditEntry call)
    await expect.poll(async () => {
      const entries = await inspector.getAuditEntries()
      return entries.find((e) => e.action === 'Table Persisted')
    }, { timeout: 10000 }).toBeDefined()

    const auditEntries = await inspector.getAuditEntries()
    const persistEntry = auditEntries.find((e) => e.action === 'Table Persisted')
    expect(persistEntry?.entryType).toBe('A')
  })
})
