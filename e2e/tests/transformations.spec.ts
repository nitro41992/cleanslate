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
 *
 * Note: With the new direct-apply transformation model, each transformation
 * is applied immediately when configured (no more recipe/run flow).
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

    // Apply trim transformation directly
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Verify via DuckDB query
    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('John Doe')
    expect(data[1].name).toBe('Jane Smith')
    expect(data[2].name).toBe('Bob Johnson')
  })

  test('should chain multiple transformations', async () => {
    await loadTestData()

    // Apply trim (directly applied)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

    // Apply uppercase (directly applied)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    const data = await inspector.getTableData('whitespace_data')
    expect(data[0].name).toBe('JOHN DOE') // Trimmed and uppercased
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')
  })

  test('should log transformations to audit log', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })

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

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })

    const data = await inspector.getTableData('mixed_case')
    expect(data[0].name).toBe('JOHN DOE')
    expect(data[1].name).toBe('JANE SMITH')
    expect(data[2].name).toBe('BOB JOHNSON')
  })

  test('should apply lowercase transformation', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'name' })

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
    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(5)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')
    await laundromat.closePanel()

    // Wait for transformation to fully propagate to DuckDB
    await page.waitForTimeout(500)

    // Verify reduced count - query DuckDB directly as store may not sync immediately
    const result = await inspector.runQuery('SELECT count(*) as cnt FROM with_duplicates')
    expect(Number(result[0].cnt)).toBe(3) // 3 unique rows
    // Rule 1: Verify specific unique rows after dedup
    const data = await inspector.getTableData('with_duplicates')
    const ids = data.map((r) => String(r.id)).sort()
    expect(ids).toEqual(['1', '2', '3'])
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

  test('should replace empty values', async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS empty_values')
    await laundromat.uploadFile(getFixturePath('empty-values.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('empty_values', 5)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Replace Empty', { column: 'name', params: { 'Replace with': 'N/A' } })

    // Row count should remain the same - values are replaced, not removed
    const tables = await inspector.getTables()
    expect(tables[0].rowCount).toBe(5)

    // Verify the replacement was applied
    const data = await inspector.getTableData('empty_values')
    const emptyRows = data.filter((row: Record<string, unknown>) => row.name === 'N/A')
    expect(emptyRows.length).toBe(2) // 2 rows had empty names
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

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
    })

    const data = await inspector.getTableData('find_replace_data')
    expect(data[0].name).toBe('hi world')
    expect(data[1].name).toBe('say hi')
    expect(data[2].name).toBe('goodbye')
  })

  test('should replace multiple occurrences in find and replace', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'description',
      params: { Find: 'hello', 'Replace with': 'hi' },
    })

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

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Rename Column', {
      column: 'name',
      params: { 'New column name': 'full_name' },
    })

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

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Cast Type', {
      column: 'amount',
      selectParams: { 'Target type': 'Integer' },
    })

    // Verify data is still accessible (cast succeeded)
    const data = await inspector.getTableData('numeric_strings')
    expect(data[0].amount).toBe(100)
    expect(data[1].amount).toBe(200)
    expect(data[2].amount).toBe(300)
  })

  test('should cast string to date', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Cast Type', {
      column: 'date_str',
      selectParams: { 'Target type': 'Date' },
    })

    // Verify data is still accessible (cast succeeded)
    const data = await inspector.getTableData('numeric_strings')
    // Date values should be present (format may vary)
    expect(data[0].date_str).toBeDefined()
    expect(data[1].date_str).toBeDefined()
    expect(data[2].date_str).toBeDefined()
  })

  test('should apply custom SQL transformation', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Custom SQL', {
      params: {
        'SQL Query':
          'CREATE OR REPLACE TABLE numeric_strings AS SELECT *, amount * 2 as doubled FROM numeric_strings',
      },
    })

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

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Case Sensitive': 'No' },
    })

    const data = await inspector.getTableData('case_sensitive_data')
    // All variations of "hello" should be replaced regardless of case
    expect(data[0].name).toBe('hi')
    expect(data[1].name).toBe('hi')
    expect(data[2].name).toBe('hi')
    expect(data[3].name).toBe('say hi')
  })

  test('should apply exact match find and replace', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Match Type': 'Exact Match' },
    })

    const data = await inspector.getTableData('case_sensitive_data')
    // Only exact match "hello" should be replaced
    expect(data[0].name).toBe('Hello') // Not replaced (different case)
    expect(data[1].name).toBe('hi') // Replaced (exact match)
    expect(data[2].name).toBe('HELLO') // Not replaced (different case)
    expect(data[3].name).toBe('say hello') // Not replaced (contains, not exact)
  })

  test('should apply case-insensitive exact match find and replace', async () => {
    await loadTestData()

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Case Sensitive': 'No', 'Match Type': 'Exact Match' },
    })

    const data = await inspector.getTableData('case_sensitive_data')
    // All exact matches regardless of case should be replaced
    expect(data[0].name).toBe('hi') // Replaced (case-insensitive exact match)
    expect(data[1].name).toBe('hi') // Replaced (exact match)
    expect(data[2].name).toBe('hi') // Replaced (case-insensitive exact match)
    expect(data[3].name).toBe('say hello') // Not replaced (contains, not exact)
  })
})

test.describe.serial('Transformations: _cs_id Lineage Preservation (Large File)', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()

    // Block unnecessary resources to reduce memory usage
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType()
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        route.abort()
      } else {
        route.continue()
      }
    })

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

  /**
   * Generate CSV with duplicates for testing remove_duplicates
   * Creates rows where some IDs repeat (duplicates)
   */
  async function generateDuplicatesCSV(totalRows: number, uniqueRows: number): Promise<string> {
    const lines = ['id,name,email']

    // Generate unique rows first
    for (let i = 1; i <= uniqueRows; i++) {
      lines.push(`${i},User ${i},user${i}@example.com`)
    }

    // Add duplicates by repeating some rows
    const duplicatesToAdd = totalRows - uniqueRows
    for (let i = 0; i < duplicatesToAdd; i++) {
      const originalId = (i % uniqueRows) + 1
      lines.push(`${originalId},User ${originalId},user${originalId}@example.com`)
    }

    return lines.join('\n')
  }

  test('should preserve _cs_id lineage through remove_duplicates (100 rows, 30 unique)', async () => {
    // Regression test for: _cs_id lineage preservation in remove_duplicates
    // Issue: remove_duplicates must use FIRST(_cs_id) to maintain row identity for diff matching
    // Goal 2: Validate functionality works correctly (minimal dataset for browser stability)

    // 1. Generate CSV with duplicates (100 rows, 30 unique after dedup)
    const csvContent = await generateDuplicatesCSV(100, 30)
    const csvSizeMB = (csvContent.length / (1024 * 1024)).toFixed(2)
    console.log(`[_cs_id Lineage Test] Generated CSV: ${csvSizeMB}MB (100 rows, 30 unique)`)

    // 2. Upload and import - write to temp file first
    await inspector.runQuery('DROP TABLE IF EXISTS dedup_large_test')

    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())
    const testFilePath = path.join(tmpDir, 'dedup_large_test.csv')
    await fs.writeFile(testFilePath, csvContent)

    await laundromat.uploadFile(testFilePath)
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('dedup_large_test', 100)

    // Cleanup temp file
    await fs.unlink(testFilePath).catch(() => {})

    // 3. Query _cs_id values before transformation (sample first 10 unique IDs)
    const beforeData = await inspector.runQuery(`
      SELECT id, _cs_id
      FROM (
        SELECT DISTINCT ON (id) id, _cs_id
        FROM dedup_large_test
        WHERE id <= 10
        ORDER BY id
      ) AS unique_ids
      ORDER BY id
    `)
    console.log('[_cs_id Lineage Test] Sample _cs_id before dedup:', beforeData.slice(0, 3))

    // Rule 1: Assert we have actual _cs_id values (not null)
    expect(beforeData.length).toBe(10)
    expect(beforeData[0]._cs_id).toBeDefined()
    expect(beforeData[0]._cs_id).not.toBeNull()

    // Store first occurrence _cs_id for each ID (these should be preserved)
    const firstOccurrenceMap = new Map<number, string>()
    const allRows = await inspector.runQuery('SELECT id, _cs_id FROM dedup_large_test ORDER BY id')
    for (const row of allRows) {
      const id = Number(row.id)
      if (!firstOccurrenceMap.has(id)) {
        firstOccurrenceMap.set(id, row._cs_id as string)
      }
    }

    // 4. Run remove_duplicates transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Remove Duplicates')
    await laundromat.closePanel()
    await page.waitForTimeout(1000)  // Allow dedup to complete

    // 5. Query _cs_id values after transformation
    const afterData = await inspector.runQuery(`
      SELECT id, _cs_id
      FROM dedup_large_test
      ORDER BY id
      LIMIT 10
    `)
    console.log('[_cs_id Lineage Test] Sample _cs_id after dedup:', afterData.slice(0, 3))

    // 6. Verify remaining rows have SAME _cs_id as before (FIRST aggregation preserved them)
    // Rule 1: Assert identity, not just cardinality
    for (const afterRow of afterData) {
      const id = Number(afterRow.id)
      const expectedCsId = firstOccurrenceMap.get(id)
      expect(afterRow._cs_id).toBe(expectedCsId)
    }

    // 7. Verify total row count is 30 (dedup worked)
    const countResult = await inspector.runQuery('SELECT COUNT(*) as cnt FROM dedup_large_test')
    const finalCount = Number(countResult[0].cnt)
    expect(finalCount).toBe(30)

    // 8. Verify _cs_id preservation was successful (core regression test)
    // The fact that we got here with matching _cs_id values proves:
    // - remove_duplicates used FIRST(_cs_id) aggregation
    // - Row identity is maintained for diff matching
    // - No new rows were created (would have new _cs_ids)

    // This test validates the fix for the regression where remove_duplicates
    // was not preserving _cs_id, causing diff to show ADDED rows instead of REMOVED

    console.log('[_cs_id Lineage Test] ✅ _cs_id preservation verified - lineage maintained through dedup')
  })
})
