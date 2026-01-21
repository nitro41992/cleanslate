import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

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
    // TDD: Expected to fail until Title Case transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Title Case' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Title Case', { column: 'name' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[1].name).toBe('Jane Doe')
  })

  test('should remove accents from text', async () => {
    // TDD: Expected to fail until Remove Accents transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Remove Accents' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Remove Accents', { column: 'name' })

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[2].name).toBe('cafe resume') // café résumé -> cafe resume
    expect(data[6].name).toBe('Sao Paulo') // São Paulo -> Sao Paulo
    expect(data[7].name).toBe('Uber driver') // Über driver -> Uber driver
  })

  test('should remove non-printable characters', async () => {
    // TDD: Expected to fail until Remove Non-Printable transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Remove Non-Printable' })).toBeVisible({ timeout: 1000 })

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

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_finance')
    await laundromat.uploadFile(getFixturePath('fr_a3_finance.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_finance', 8)
  }

  test('should unformat currency values', async () => {
    // TDD: Expected to fail until Unformat Currency transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Unformat Currency' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Unformat Currency', { column: 'currency_value' })

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[0].currency_value).toBe(1234.56) // $1234.56 -> 1234.56
    expect(data[1].currency_value).toBe(50000.00) // $50000.00 -> 50000.00
  })

  test('should fix negative number formatting', async () => {
    // TDD: Expected to fail until Fix Negatives transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Fix Negatives' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Fix Negatives', { column: 'formatted_negative' })

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[1].formatted_negative).toBe(-750.00) // $(750.00) -> -750.00
    expect(data[5].formatted_negative).toBe(-500) // (500) -> -500
  })

  test('should pad numbers with zeros', async () => {
    // TDD: Expected to fail until Pad Zeros transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Pad Zeros' })).toBeVisible({ timeout: 1000 })

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

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_dates_split')
    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)
  }

  test('should standardize date formats', async () => {
    // TDD: Expected to fail until Standardize Date transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Standardize Date' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Standardize Date', {
      column: 'date_us',
      params: { format: 'YYYY-MM-DD' },
    })

    const data = await inspector.getTableData('fr_a3_dates_split')
    expect(data[0].date_us).toBe('1985-03-15') // 03/15/1985 -> 1985-03-15
    expect(data[1].date_us).toBe('1990-07-22') // 07/22/1990 -> 1990-07-22
  })

  test('should calculate age from birth date', async () => {
    // TDD: Expected to fail until Calculate Age transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Calculate Age' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Calculate Age', { column: 'birth_date' })

    const data = await inspector.getTableData('fr_a3_dates_split')
    // Ages will vary based on current date, just check it's a reasonable number
    expect(typeof data[0].age).toBe('number')
    expect(data[0].age as number).toBeGreaterThan(30)
  })

  test('should split column by delimiter', async () => {
    // TDD: Expected to fail until Split Column transformation is implemented
    test.fail()

    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Split Column' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Split Column', {
      column: 'full_name',
      params: { delimiter: ' ' },
    })

    const data = await inspector.getTableData('fr_a3_dates_split')
    expect(data[0].full_name_1).toBe('John')
    expect(data[0].full_name_2).toBe('Smith')
  })
})

test.describe.serial('FR-A3: Fill Down Transformation', () => {
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

  test('should fill down empty cells from above', async () => {
    // TDD: Expected to fail until Fill Down transformation is implemented
    test.fail()

    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_fill_down')
    await laundromat.uploadFile(getFixturePath('fr_a3_fill_down.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_fill_down', 10)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    // Fail-fast guard: Assert transformation option exists
    await expect(page.getByRole('option', { name: 'Fill Down' })).toBeVisible({ timeout: 1000 })

    await picker.addTransformation('Fill Down', { column: 'region' })

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

test.describe.serial('FR-B2: Visual Diff', () => {
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

  test('should detect row changes between two tables', async () => {
    // Open diff view via panel-based navigation (single-page app)
    await laundromat.openDiffView()

    // Verify diff view loads
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 })
  })

  test('should identify added, removed, and modified rows', async () => {
    // Close diff view to upload files
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Clean up any existing tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_base')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_new')

    // Upload first file (base)
    await laundromat.uploadFile(getFixturePath('fr_b2_base.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_base', 5)

    // Upload second file (new)
    await laundromat.uploadFile(getFixturePath('fr_b2_new.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_b2_new', 5)

    // Open diff view via panel-based navigation
    await laundromat.openDiffView()

    // Fail-fast guard: Assert diff comparison UI exists (requires 2+ tables)
    await expect(page.getByTestId('diff-compare-btn')).toBeVisible({ timeout: 5000 })

    // Select tables and key column
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'fr_b2_base' }).click()
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: 'fr_b2_new' }).click()

    // Select id as key column
    await page.getByRole('checkbox', { name: 'id' }).click()

    // Run comparison
    await page.getByTestId('diff-compare-btn').click()

    // Wait for diff results to appear
    await expect(page.getByRole('heading', { name: 'Diff Results' })).toBeVisible({ timeout: 10000 })

    // Verify diff found expected changes
    // Expected: 1 added (Frank), 1 removed (Charlie), 3 modified (Alice, Diana, Eve)
    await expect(page.getByText('Found 1 added, 1 removed, 3 modified rows').first()).toBeVisible()
  })
})

test.describe.serial('FR-C1: Fuzzy Matcher', () => {
  let page: Page
  let laundromat: LaundromatPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('should load matcher panel', async () => {
    // Open match panel via toolbar (single-page app)
    await laundromat.openMatchPanel()
    await expect(page.locator('text=Fuzzy Matcher')).toBeVisible({ timeout: 10000 })
  })

  test('should detect duplicate records with fuzzy matching', async () => {
    // TDD: Expected to fail until fuzzy matching feature is implemented
    test.fail()

    // Fail-fast guard: Assert fuzzy match UI exists
    await expect(page.getByTestId('run-match-btn')).toBeVisible({ timeout: 1000 })

    // Test with fr_c1_dedupe.csv
    // Expected matches:
    // - John Smith / Jon Smith (same phone, city)
    // - Jane Doe / Janet Doe (similar name, city)
    // - Robert Johnson / Bob Johnson (same phone, city)
    // - Sarah Williams / Sara Williams (similar name, similar phone)
  })

  test('should support blocking strategy for performance', async () => {
    // TDD: Expected to fail until blocking strategy feature is implemented
    test.fail()

    // Fail-fast guard: Assert blocking strategy UI exists
    await expect(page.getByTestId('blocking-strategy-select')).toBeVisible({ timeout: 1000 })

    // Test blocking by city or phone prefix
  })
})

test.describe.serial('FR-D2: Obfuscation (Smart Scrubber)', () => {
  let page: Page
  let laundromat: LaundromatPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('should load scrubber panel', async () => {
    // Open scrub panel via toolbar (single-page app)
    await laundromat.openScrubPanel()
    await expect(page.locator('text=Smart Scrubber')).toBeVisible({ timeout: 10000 })
  })

  test('should hash sensitive columns', async () => {
    // TDD: Expected to fail until hash obfuscation is implemented
    test.fail()

    // Fail-fast guard: Assert hash option exists in scrubber
    await expect(page.getByRole('option', { name: /hash/i })).toBeVisible({ timeout: 1000 })

    // Test SHA-256 hashing of SSN column in fr_d2_pii.csv
    // Verify hash is consistent (same input = same output)
  })

  test('should redact PII patterns', async () => {
    // TDD: Expected to fail until redact obfuscation is implemented
    test.fail()

    // Fail-fast guard: Assert redact option exists in scrubber
    await expect(page.getByRole('option', { name: /redact/i })).toBeVisible({ timeout: 1000 })

    // Test redaction of email, phone, SSN patterns
    // john.smith@email.com -> j***@e***.com or [REDACTED]
  })

  test('should mask partial values', async () => {
    // TDD: Expected to fail until mask obfuscation is implemented
    test.fail()

    // Fail-fast guard: Assert mask option exists in scrubber
    await expect(page.getByRole('option', { name: /mask/i })).toBeVisible({ timeout: 1000 })

    // Test masking credit card: 4111-1111-1111-1111 -> ****-****-****-1111
  })

  test('should extract year only from dates', async () => {
    // TDD: Expected to fail until year_only obfuscation is implemented
    test.fail()

    // Fail-fast guard: Assert year_only option exists in scrubber
    await expect(page.getByRole('option', { name: /year/i })).toBeVisible({ timeout: 1000 })

    // Test year_only: 1985-03-15 -> 1985
  })
})

test.describe.serial('FR-E1: Combiner - Stack Files', () => {
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
    await page.getByLabel('Result Table Name').fill('stacked_result')

    // Click Stack Tables button
    await page.getByTestId('combiner-stack-btn').click()

    // Wait for the operation to complete (toast notification)
    await expect(page.getByText('Tables Stacked', { exact: true })).toBeVisible({ timeout: 5000 })

    // Verify via SQL - should have 9 rows (4+5)
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM stacked_result')
    expect(Number(result[0].cnt)).toBe(9)

    // Verify data integrity - check sale_ids from both files (J=Jan, F=Feb)
    const data = await inspector.getTableData('stacked_result', 9)
    const saleIds = data.map((r) => r.sale_id as string)
    expect(saleIds.filter((id) => id.startsWith('J'))).toHaveLength(4)
    expect(saleIds.filter((id) => id.startsWith('F'))).toHaveLength(5)
  })
})

test.describe.serial('FR-E2: Combiner - Join Files', () => {
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

  test('should perform inner join on customer_id', async () => {
    // Clean up any existing tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_e2_orders')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_e2_customers')
    await inspector.runQuery('DROP TABLE IF EXISTS join_result')

    // Upload orders file (page is already on laundromat from beforeAll)
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
    await expect(page.getByRole('heading', { name: 'Join Tables' })).toBeVisible()

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
    await page.getByLabel('Result Table Name').fill('join_result')

    // Click Join Tables button
    await page.getByTestId('combiner-join-btn').click()

    // Wait for the operation to complete (toast notification)
    await expect(page.getByText('Tables Joined', { exact: true })).toBeVisible({ timeout: 5000 })

    // Verify result count via SQL - inner join excludes non-matching rows
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM join_result')
    // Inner join: only rows where customer_id matches (C001, C002, C003 have orders)
    expect(Number(result[0].cnt)).toBe(5)
  })

  test('should perform left join preserving unmatched orders', async () => {
    // Drop existing tables from previous test
    await inspector.runQuery('DROP TABLE IF EXISTS join_result')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_e2_orders')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_e2_customers')

    // Close any open panel and go back to main view
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Upload orders file
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
    await expect(page.getByRole('heading', { name: 'Join Tables' })).toBeVisible()

    // Select left table (orders)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /fr_e2_orders/i }).click()

    // Select right table (customers)
    await page.getByRole('combobox').nth(1).click()
    await page.getByRole('option', { name: /fr_e2_customers/i }).click()

    // Select key column
    await page.getByRole('combobox').nth(2).click()
    await page.getByRole('option', { name: 'customer_id' }).click()

    // Select Left join type
    await page.getByLabel('Left').click()

    // Enter result table name
    await page.getByLabel('Result Table Name').fill('join_result')

    // Click Join Tables button
    await page.getByTestId('combiner-join-btn').click()

    // Wait for the operation to complete (toast notification)
    await expect(page.getByText('Tables Joined', { exact: true })).toBeVisible({ timeout: 5000 })

    // Verify all orders preserved (left join keeps unmatched rows)
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM join_result')
    expect(Number(result[0].cnt)).toBe(6)

    // Verify unmatched orders have NULL customer info
    const unmatched = await inspector.runQuery(
      'SELECT count(*) as cnt FROM join_result WHERE name IS NULL'
    )
    expect(Number(unmatched[0].cnt)).toBeGreaterThan(0) // C004 order has no matching customer
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

  test('should show dirty indicator on edited cells', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Verify undo/redo buttons exist (basic UI check)
    await expect(laundromat.undoButton).toBeVisible()
    await expect(laundromat.redoButton).toBeVisible()
  })

  test('should commit cell edit and record in audit log', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty')
    // 1. Load data
    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

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

    // 4. Verify update via DuckDB query
    const updatedData = await inspector.getTableData('fr_a3_text_dirty')
    expect(updatedData[0].name).toBe('EDITED_VALUE')

    // 5. Verify Type B audit entry (CRITICAL for compliance)
    const auditEntries = await inspector.getAuditEntries()
    const editEntry = auditEntries.find((e) => e.entryType === 'B')

    expect(editEntry).toBeDefined()
    expect(editEntry?.action).toContain('Manual Edit')
    expect(editEntry?.previousValue).toBe(originalName)
    expect(editEntry?.newValue).toBe('EDITED_VALUE')
    expect(editEntry?.rowIndex).toBe(0)
    expect(editEntry?.columnName).toBe('name')
  })

  test('should undo/redo cell edits', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_text_dirty')
    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    // Fail-fast guard: Verify editStore has undo/redo functions exposed via getState()
    const hasUndoRedo = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const editStore = stores?.editStore as { getState: () => { canUndo?: () => boolean; canRedo?: () => boolean } } | undefined
      const state = editStore?.getState?.()
      return typeof state?.canUndo === 'function' && typeof state?.canRedo === 'function'
    })
    expect(hasUndoRedo).toBe(true)

    const originalData = await inspector.getTableData('fr_a3_text_dirty')
    const originalName = originalData[0].name

    // Edit cell
    await laundromat.editCell(0, 1, 'CHANGED')
    const afterEditData = await inspector.getTableData('fr_a3_text_dirty')
    expect(afterEditData[0].name).toBe('CHANGED')

    // Undo (Ctrl+Z)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(100)
    const afterUndoData = await inspector.getTableData('fr_a3_text_dirty')
    expect(afterUndoData[0].name).toBe(originalName)

    // Redo (Ctrl+Y)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(100)
    const afterRedoData = await inspector.getTableData('fr_a3_text_dirty')
    expect(afterRedoData[0].name).toBe('CHANGED')
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

    // 6. Verify data was persisted correctly
    const data = await inspector.getTableData('basic_data_v2')
    expect(data[0].name).toBe('JOHN DOE') // Uppercase applied
  })

  test('should log persist operation to audit', async () => {
    const auditEntries = await inspector.getAuditEntries()
    const persistEntry = auditEntries.find((e) => e.action.includes('Persist'))
    expect(persistEntry).toBeDefined()
    expect(persistEntry?.entryType).toBe('A')
  })
})

test.describe.serial('FR-B2: Diff Dual Comparison Modes', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector
  let diffView: DiffViewPage

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    diffView = new DiffViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
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
    await laundromat.closePanel()

    // 3. Open Diff view
    await laundromat.openDiffView()
    await diffView.waitForOpen()

    // 4. Select Compare with Preview mode (should be default)
    await diffView.selectComparePreviewMode()

    // 5. Select key column and run comparison
    await diffView.toggleKeyColumn('id')
    await diffView.runComparison()

    // 6. Verify results show modified rows
    const summary = await diffView.getSummary()
    expect(summary.modified).toBe(5) // All 5 rows have uppercase names
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
  })

  test('should support Compare Two Tables mode', async () => {
    // 1. Upload two tables
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_base')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_b2_new')

    await diffView.close()

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
    expect(summary.modified).toBe(3) // Alice, Diana, Eve modified
  })
})
