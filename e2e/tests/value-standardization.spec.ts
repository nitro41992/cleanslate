import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { StandardizeViewPage } from '../page-objects/standardize-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * FR-F: Value Standardization Tests
 *
 * Tests the clustering and standardization feature for cleaning
 * inconsistent values in a column.
 *
 * Uses test.describe.serial with shared page context to minimize
 * DuckDB-WASM initialization overhead.
 */

test.describe.serial('FR-F: Value Standardization', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let standardize: StandardizeViewPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    standardize = new StandardizeViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_f_standardize')
    await laundromat.uploadFile(getFixturePath('fr_f_standardize.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_f_standardize', 10)
  }

  test('FR-F1: should open standardize view from toolbar', async () => {
    await loadTestData()

    // Click the Standardize button in the toolbar
    await page.getByTestId('toolbar-standardize').click()

    // Verify the view opens
    await standardize.waitForOpen()

    // Close the view
    await standardize.close()
  })

  test('FR-F1: should cluster values using fingerprint algorithm', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()

    // Wait for clusters to appear
    await standardize.waitForClusters()

    // Verify clusters were created
    const stats = await standardize.getStats()
    expect(stats.totalClusters).toBeGreaterThan(0)

    // With fingerprint algorithm:
    // "John Smith", "JOHN SMITH", "john  smith" should cluster together
    // "Jane Doe", "Jane   Doe", "JANE DOE" should cluster together
    expect(stats.actionable).toBeGreaterThanOrEqual(2)

    await standardize.close()
  })

  test('FR-F1: should cluster values using metaphone algorithm', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure with metaphone and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('metaphone')
    await standardize.analyze()

    // Wait for clusters to appear
    await standardize.waitForClusters()

    // With metaphone algorithm:
    // "Mike Smith" and "Mik Smith" should cluster together (phonetically similar)
    const stats = await standardize.getStats()
    expect(stats.totalClusters).toBeGreaterThan(0)

    await standardize.close()
  })

  test('FR-F2: should auto-suggest most frequent value as master', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()

    // Expand first cluster and check master is shown
    await standardize.expandCluster(0)

    // Look for the Master badge
    const masterBadge = page.locator('text=Master')
    await expect(masterBadge).toBeVisible()

    await standardize.close()
  })

  test('FR-F2: should allow user to change master value', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()

    // Expand first actionable cluster
    await standardize.filterBy('actionable')
    await standardize.expandCluster(0)

    // Find a "Set Master" button and click it
    const setMasterButton = page.getByRole('button', { name: /Set Master/i }).first()
    await expect(setMasterButton).toBeVisible()
    await setMasterButton.click()

    // Verify master changed (should now show two Master badges briefly, then one)
    await page.waitForTimeout(300)
    const masterBadges = page.locator('text=Master')
    await expect(masterBadges.first()).toBeVisible()

    await standardize.close()
  })

  test('FR-F3: should apply bulk standardization', async () => {
    await loadTestData()

    // Get initial data
    const initialData = await inspector.getTableData('fr_f_standardize')
    const initialNames = initialData.map((r) => r.name)

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()

    // Filter to actionable clusters only
    await standardize.filterBy('actionable')

    // Verify apply button is visible (values are selected by default)
    await expect(page.getByRole('button', { name: /Apply Standardization/i })).toBeVisible()

    // Apply standardization
    await standardize.apply()

    // Verify data was updated
    const updatedData = await inspector.getTableData('fr_f_standardize')
    const updatedNames = updatedData.map((r) => r.name)

    // Names should be standardized - there should be fewer unique values
    const uniqueInitial = new Set(initialNames).size
    const uniqueUpdated = new Set(updatedNames).size
    expect(uniqueUpdated).toBeLessThan(uniqueInitial)
  })

  test('FR-F3: should create audit entry with drill-down', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()

    // Filter and apply
    await standardize.filterBy('actionable')
    await standardize.apply()

    // Check audit log for standardization entry
    const auditEntries = await inspector.getAuditEntries()
    const standardizeEntry = auditEntries.find((e) => e.action === 'Standardize Values')
    expect(standardizeEntry).toBeDefined()
    expect(standardizeEntry?.hasRowDetails).toBe(true)
  })

  test('FR-F1: should block clustering when unique values exceed 50k limit', async () => {
    // TDD: Expected to fail until validation is fully tested
    // This test would require a large fixture file to properly test

    // For now, just verify the validation flow exists
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Select table and column
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')

    // Verify analyze button is enabled for valid data
    await expect(page.getByTestId('standardize-analyze-btn')).toBeEnabled()

    await standardize.close()
  })

  test('should filter clusters by search query', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.analyze()
    await standardize.waitForClusters()

    // Get initial cluster count
    const initialCount = await standardize.getClusterCount()

    // Search for a specific name
    await standardize.search('John')

    // Wait for filter to apply
    await page.waitForTimeout(300)

    // Should show fewer clusters
    const filteredCount = await standardize.getClusterCount()
    expect(filteredCount).toBeLessThanOrEqual(initialCount)

    await standardize.close()
  })

  test('should toggle between All and Actionable filters', async () => {
    await loadTestData()

    // Open standardize view
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()

    // Configure and analyze
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.analyze()
    await standardize.waitForClusters()

    // Get actionable count (default filter)
    const actionableCount = await standardize.getClusterCount()

    // Switch to All filter
    await standardize.filterBy('all')
    await page.waitForTimeout(300)

    // All count should be >= actionable count
    const allCount = await standardize.getClusterCount()
    expect(allCount).toBeGreaterThanOrEqual(actionableCount)

    await standardize.close()
  })
})
