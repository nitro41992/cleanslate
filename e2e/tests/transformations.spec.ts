import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Transformation Tests
 *
 * Grouped by fixture file to minimize DuckDB-WASM cold start overhead.
 * Each serial group shares a page context, initializing DuckDB once.
 */

test.describe.serial('Transformations: Whitespace Data', () => {
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
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)
  }

  test('should apply trim transformation', async () => {
    await loadTestData()

    // Add trim transformation
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Run recipe
    await laundromat.clickRunRecipe()

    // Verify via DuckDB query
    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('John Doe')
    expect(data[1].name).toBe('Jane Smith')
    expect(data[2].name).toBe('Bob Johnson')
  })

  test('should chain multiple transformations', async () => {
    await loadTestData()

    // Add trim
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Add uppercase
    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('JOHN DOE') // Trimmed and uppercased
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')
  })

  test('should log transformations to audit log', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    await laundromat.clickRunRecipe()

    // Verify audit log entry
    const auditEntries = await inspector.getAuditEntries()
    const trimEntry = auditEntries.find((e) => e.action.includes('Trim'))
    expect(trimEntry).toBeDefined()
    expect(trimEntry?.entryType).toBe('A')
    // Verify rowsAffected is tracked (2 rows have whitespace to trim)
    expect(trimEntry?.rowsAffected).toBeDefined()
  })
})

test.describe.serial('Transformations: Mixed Case Data', () => {
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
    await inspector.runQuery('DROP TABLE IF EXISTS mixed_case')
    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)
  }

  test('should apply uppercase transformation', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('mixed_case')
    expect(data[0].name).toBe('JOHN DOE')
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')
  })

  test('should apply lowercase transformation', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('mixed_case')
    expect(data[0].name).toBe('john doe')
    expect(data[1].name).toBe('jane smith')
    expect(data[2].name).toBe('bob johnson')
  })
})

test.describe.serial('Transformations: Duplicates Data', () => {
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

  test('should remove duplicates', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS with_duplicates')
    await laundromat.uploadFile(getFixturePath('with-duplicates.csv'))
    await wizard.waitForOpen()
    await wizard.import()

    // Wait for table to be loaded
    await inspector.waitForTableLoaded('with_duplicates', 5)

    // Verify initial count
    let tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')

    await laundromat.clickRunRecipe()

    // Verify reduced count
    tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3) // 3 unique rows
  })
})

test.describe.serial('Transformations: Empty Values Data', () => {
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

  test('should filter empty values', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS empty_values')
    await laundromat.uploadFile(getFixturePath('empty-values.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('empty_values', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Filter Empty', { column: 'name' })

    await laundromat.clickRunRecipe()

    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(3) // Rows with empty name removed
  })
})

test.describe.serial('Transformations: Find Replace Data', () => {
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
    await inspector.runQuery('DROP TABLE IF EXISTS find_replace_data')
    await laundromat.uploadFile(getFixturePath('find-replace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('find_replace_data', 3)
  }

  test('should apply find and replace transformation', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('find_replace_data')
    expect(data[0].name).toBe('hi world')
    expect(data[1].name).toBe('say hi')
    expect(data[2].name).toBe('goodbye')
  })

  test('should replace multiple occurrences in find and replace', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'description',
      params: { Find: 'hello', 'Replace with': 'hi' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('find_replace_data')
    expect(data[0].description).toBe('hi there')
    expect(data[1].description).toBe('hi hi') // Multiple occurrences replaced
    expect(data[2].description).toBe('no match here')
  })
})

test.describe.serial('Transformations: Basic Data (Rename)', () => {
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

  test('should rename column', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS basic_data')
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Rename Column', {
      column: 'name',
      params: { 'New column name': 'full_name' },
    })

    await laundromat.clickRunRecipe()

    // Verify column was renamed by querying the data
    const data = await inspector.getTableData('basic_data')
    expect(data[0].full_name).toBeDefined()
    expect(data[0].name).toBeUndefined()
  })
})

test.describe.serial('Transformations: Numeric Strings Data', () => {
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
    await inspector.runQuery('DROP TABLE IF EXISTS numeric_strings')
    await laundromat.uploadFile(getFixturePath('numeric-strings.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('numeric_strings', 3)
  }

  test('should cast string to integer', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Cast Type', {
      column: 'amount',
      selectParams: { 'Target type': 'Integer' },
    })

    await laundromat.clickRunRecipe()

    // Verify data is still accessible (cast succeeded)
    const data = await inspector.getTableData('numeric_strings')
    expect(data[0].amount).toBe(100)
    expect(data[1].amount).toBe(200)
    expect(data[2].amount).toBe(300)
  })

  test('should cast string to date', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Cast Type', {
      column: 'date_str',
      selectParams: { 'Target type': 'Date' },
    })

    await laundromat.clickRunRecipe()

    // Verify data is still accessible (cast succeeded)
    const data = await inspector.getTableData('numeric_strings')
    // Date values should be present (format may vary)
    expect(data[0].date_str).toBeDefined()
    expect(data[1].date_str).toBeDefined()
    expect(data[2].date_str).toBeDefined()
  })

  test('should apply custom SQL transformation', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Custom SQL', {
      params: {
        'SQL Query':
          'CREATE OR REPLACE TABLE numeric_strings AS SELECT *, amount * 2 as doubled FROM numeric_strings',
      },
    })

    await laundromat.clickRunRecipe()

    // Verify new column was created with correct values
    // Note: DuckDB may return BigInt for integer calculations
    const data = await inspector.getTableData('numeric_strings')
    expect(Number(data[0].doubled)).toBe(200)
    expect(Number(data[1].doubled)).toBe(400)
    expect(Number(data[2].doubled)).toBe(600)
  })
})

test.describe.serial('Transformations: Case Sensitive Data', () => {
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
    await inspector.runQuery('DROP TABLE IF EXISTS case_sensitive_data')
    await laundromat.uploadFile(getFixturePath('case-sensitive-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('case_sensitive_data', 4)
  }

  test('should apply case-insensitive find and replace', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Case Sensitive': 'No' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('case_sensitive_data')
    // All variations of "hello" should be replaced regardless of case
    expect(data[0].name).toBe('hi')
    expect(data[1].name).toBe('hi')
    expect(data[2].name).toBe('hi')
    expect(data[3].name).toBe('say hi')
  })

  test('should apply exact match find and replace', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Match Type': 'Exact Match' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('case_sensitive_data')
    // Only exact match "hello" should be replaced
    expect(data[0].name).toBe('Hello') // Not replaced (different case)
    expect(data[1].name).toBe('hi') // Replaced (exact match)
    expect(data[2].name).toBe('HELLO') // Not replaced (different case)
    expect(data[3].name).toBe('say hello') // Not replaced (contains, not exact)
  })

  test('should apply case-insensitive exact match find and replace', async () => {
    await loadTestData()

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Case Sensitive': 'No', 'Match Type': 'Exact Match' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('case_sensitive_data')
    // All exact matches regardless of case should be replaced
    expect(data[0].name).toBe('hi') // Replaced (case-insensitive exact match)
    expect(data[1].name).toBe('hi') // Replaced (exact match)
    expect(data[2].name).toBe('hi') // Replaced (case-insensitive exact match)
    expect(data[3].name).toBe('say hello') // Not replaced (contains, not exact)
  })
})
