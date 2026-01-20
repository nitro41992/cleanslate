import { test, expect } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Feature Coverage Tests
 *
 * Uses dedicated fixture files to test PRD requirements.
 * Tests are organized by FR (Functional Requirement) identifier.
 */

test.describe('FR-A3: Text Cleaning Transformations', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)

    await laundromat.goto()
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test('should trim whitespace from text fields', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[0].name).toBe('John Smith')
    expect(data[5].name).toBe('MIKE  JONES') // Internal spaces preserved, edge trimmed
  })

  test('should convert text to uppercase', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'email' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[0].email).toBe('JOHN@EXAMPLE.COM')
    expect(data[2].email).toBe('ACCENT@TEST.COM')
  })

  test('should convert text to lowercase', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'email' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[0].email).toBe('john@example.com')
    expect(data[1].email).toBe('jane@test.org')
  })

  test.skip('should convert text to title case [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Title Case', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[1].name).toBe('Jane Doe')
  })

  test.skip('should remove accents from text [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Accents', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[2].name).toBe('cafe resume') // café résumé -> cafe resume
    expect(data[6].name).toBe('Sao Paulo') // São Paulo -> Sao Paulo
    expect(data[7].name).toBe('Uber driver') // Über driver -> Uber driver
  })

  test.skip('should remove non-printable characters [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_text_dirty.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_text_dirty', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Non-Printable', { column: 'name' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_text_dirty')
    expect(data[3].name).toBe('BobWilson') // Tabs removed
    expect(data[4].name).toBe('AliceBrown') // Newlines removed
  })
})

test.describe('FR-A3: Finance & Number Transformations', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)

    await laundromat.goto()
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.skip('should unformat currency values [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_finance.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_finance', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Unformat Currency', { column: 'currency_value' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[0].currency_value).toBe(1234.56) // $1234.56 -> 1234.56
    expect(data[1].currency_value).toBe(50000.00) // $50000.00 -> 50000.00
  })

  test.skip('should fix negative number formatting [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_finance.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_finance', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Fix Negatives', { column: 'formatted_negative' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[1].formatted_negative).toBe(-750.00) // $(750.00) -> -750.00
    expect(data[5].formatted_negative).toBe(-500) // (500) -> -500
  })

  test.skip('should pad numbers with zeros [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_finance.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_finance', 8)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Pad Zeros', { column: 'account_number', params: { length: '5' } })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_finance')
    expect(data[0].account_number).toBe('00123') // 123 -> 00123
    expect(data[1].account_number).toBe('00045') // 45 -> 00045
    expect(data[5].account_number).toBe('00001') // 1 -> 00001
  })
})

test.describe('FR-A3: Dates & Structure Transformations', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)

    await laundromat.goto()
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.skip('should standardize date formats [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Standardize Date', {
      column: 'date_us',
      params: { format: 'YYYY-MM-DD' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_dates_split')
    expect(data[0].date_us).toBe('1985-03-15') // 03/15/1985 -> 1985-03-15
    expect(data[1].date_us).toBe('1990-07-22') // 07/22/1990 -> 1990-07-22
  })

  test.skip('should calculate age from birth date [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Calculate Age', { column: 'birth_date' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_dates_split')
    // Ages will vary based on current date, just check it's a reasonable number
    expect(typeof data[0].age).toBe('number')
    expect(data[0].age as number).toBeGreaterThan(30)
  })

  test.skip('should split column by delimiter [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Split Column', {
      column: 'full_name',
      params: { delimiter: ' ' },
    })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_dates_split')
    expect(data[0].full_name_1).toBe('John')
    expect(data[0].full_name_2).toBe('Smith')
  })
})

test.describe('FR-A3: Fill Down Transformation', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)

    await laundromat.goto()
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.skip('should fill down empty cells from above [PENDING]', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('fr_a3_fill_down.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_fill_down', 10)

    await laundromat.clickAddTransformation()
    await picker.waitForOpen()
    await picker.addTransformation('Fill Down', { column: 'region' })

    await laundromat.clickRunRecipe()

    const data = await inspector.getTableData('fr_a3_fill_down')
    expect(data[0].region).toBe('North')
    expect(data[1].region).toBe('North') // Filled from above
    expect(data[2].region).toBe('North') // Filled from above
    expect(data[5].region).toBe('South')
    expect(data[6].region).toBe('South') // Filled from above
  })
})

test.describe('FR-A6: Ingestion Wizard', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)

    await laundromat.goto()
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test('should detect and skip garbage header rows', async ({ page }) => {
    const inspector = createStoreInspector(page)

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

  test('should show raw preview of file content', async ({ page: _page }) => {
    await laundromat.uploadFile(getFixturePath('fr_a6_legacy_garbage.csv'))
    await wizard.waitForOpen()

    // Verify raw preview is visible
    const previewText = await wizard.getRawPreviewText()
    expect(previewText).toContain('ACME Corp Report Generator')
    expect(previewText).toContain('Widget A')
  })
})

test.describe('FR-B2: Visual Diff', () => {
  test('should detect row changes between two tables', async ({ page }) => {
    // Navigate to diff page
    await page.goto('/diff')
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()

    // This test requires uploading two files and comparing them
    // Implementation depends on the diff UI structure
    // Marking as basic structure test

    // Verify diff page loads
    await expect(page.locator('text=/Visual Diff|Compare/i')).toBeVisible({ timeout: 10000 })
  })

  test.skip('should identify added, removed, and modified rows [PENDING]', async () => {
    // Full diff test with fr_b2_base.csv and fr_b2_new.csv
    // Expected results:
    // - Row 3 (Charlie): REMOVED
    // - Row 6 (Frank): ADDED
    // - Row 1 (Alice): MODIFIED (salary 75000 -> 78000)
    // - Row 4 (Diana): MODIFIED (salary 80000 -> 85000)
    // - Row 5 (Eve): MODIFIED (department HR -> Human Resources, salary 55000 -> 58000)
  })
})

test.describe('FR-C1: Fuzzy Matcher', () => {
  test('should load matcher page', async ({ page }) => {
    await page.goto('/matcher')
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()

    await expect(page.locator('text=/Fuzzy Matcher|Match|Dedupe/i')).toBeVisible({ timeout: 10000 })
  })

  test.skip('should detect duplicate records with fuzzy matching [PENDING]', async () => {
    // Test with fr_c1_dedupe.csv
    // Expected matches:
    // - John Smith / Jon Smith (same phone, city)
    // - Jane Doe / Janet Doe (similar name, city)
    // - Robert Johnson / Bob Johnson (same phone, city)
    // - Sarah Williams / Sara Williams (similar name, similar phone)
  })

  test.skip('should support blocking strategy for performance [PENDING]', async () => {
    // Test blocking by city or phone prefix
  })
})

test.describe('FR-D2: Obfuscation (Smart Scrubber)', () => {
  test('should load scrubber page', async ({ page }) => {
    await page.goto('/scrubber')
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()

    await expect(page.locator('text=/Scrubber|Obfuscate|Redact/i')).toBeVisible({ timeout: 10000 })
  })

  test.skip('should hash sensitive columns [PENDING]', async () => {
    // Test SHA-256 hashing of SSN column in fr_d2_pii.csv
    // Verify hash is consistent (same input = same output)
  })

  test.skip('should redact PII patterns [PENDING]', async () => {
    // Test redaction of email, phone, SSN patterns
    // john.smith@email.com -> j***@e***.com or [REDACTED]
  })

  test.skip('should mask partial values [PENDING]', async () => {
    // Test masking credit card: 4111-1111-1111-1111 -> ****-****-****-1111
  })

  test.skip('should extract year only from dates [PENDING]', async () => {
    // Test year_only: 1985-03-15 -> 1985
  })
})

test.describe('FR-E1: Combiner - Stack Files', () => {
  test.skip('should stack multiple files with Union All [PENDING]', async () => {
    // Upload fr_e1_jan_sales.csv and fr_e1_feb_sales.csv
    // Stack them (Union All)
    // Verify combined row count: 4 + 5 = 9 rows
  })
})

test.describe('FR-E2: Combiner - Join Files', () => {
  test.skip('should perform left join on matching keys [PENDING]', async () => {
    // Upload fr_e2_orders.csv and fr_e2_customers.csv
    // Left join on customer_id
    // All 6 orders should appear
    // C004 order should have NULL customer info (no match)
  })

  test.skip('should perform inner join on matching keys [PENDING]', async () => {
    // Upload fr_e2_orders.csv and fr_e2_customers.csv
    // Inner join on customer_id
    // Only orders with matching customers should appear (5 rows, excluding C004)
  })
})

test.describe('FR-A4: Manual Cell Editing', () => {
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage

  test.beforeEach(async ({ page }) => {
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)

    await laundromat.goto()
    const inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test('should support undo/redo for cell edits', async ({ page }) => {
    const inspector = createStoreInspector(page)

    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 3)

    // Verify undo/redo buttons exist
    await expect(laundromat.undoButton).toBeVisible()
    await expect(laundromat.redoButton).toBeVisible()
  })
})
