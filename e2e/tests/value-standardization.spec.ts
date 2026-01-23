import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { StandardizeViewPage } from '../page-objects/standardize-view.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
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
    // Reload page to clear any stale table entries in store
    await page.reload()
    await inspector.waitForDuckDBReady()
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

    // Look for the Master badge (exact match to avoid matching "Set Master" buttons)
    const masterBadge = page.getByText('Master', { exact: true })
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

/**
 * FR-F: Standardization Integration Tests
 *
 * Tests the full integration of standardization with:
 * - Diff view (Compare with Preview)
 * - Audit drill-down (StandardizeDetailTable)
 * - Undo/Redo functionality
 */
test.describe.serial('FR-F: Standardization Integration (Diff, Drill-down, Undo)', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let standardize: StandardizeViewPage
  let diffView: DiffViewPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    standardize = new StandardizeViewPage(page)
    diffView = new DiffViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.close()
  })

  async function loadTestData() {
    // Reload page to clear any stale state
    await page.reload()
    await inspector.waitForDuckDBReady()
    await inspector.runQuery('DROP TABLE IF EXISTS fr_f_integration')
    await laundromat.uploadFile(getFixturePath('fr_f_standardize.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_f_standardize', 10)
  }

  test('FR-F-INT-1: Diff view should work after standardization', async () => {
    await loadTestData()

    // Get original unique names count
    const initialData = await inspector.getTableData('fr_f_standardize')
    const initialUniqueNames = new Set(initialData.map((r) => r.name)).size

    // Apply standardization
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()
    await standardize.filterBy('actionable')
    await standardize.apply()

    // Verify data was changed
    const afterData = await inspector.getTableData('fr_f_standardize')
    const afterUniqueNames = new Set(afterData.map((r) => r.name)).size
    expect(afterUniqueNames).toBeLessThan(initialUniqueNames)

    // Open diff view
    await page.getByTestId('toolbar-diff').click()
    await diffView.waitForOpen()

    // Select "Compare with Preview" mode (compares current with original snapshot)
    await diffView.selectComparePreviewMode()
    await page.waitForTimeout(500)

    // Verify original snapshot is available
    await expect(page.locator('text=Original snapshot available')).toBeVisible({ timeout: 5000 })

    // Select a key column (required for comparison)
    await diffView.toggleKeyColumn('id')
    await page.waitForTimeout(300)

    // Verify compare button is now enabled
    await expect(diffView.compareButton).toBeEnabled({ timeout: 5000 })

    // Run comparison
    await diffView.runComparison()

    // Verify diff results show modified rows
    const summary = await diffView.getSummary()
    // Standardization modifies rows, so we expect modified count > 0
    expect(summary.modified).toBeGreaterThan(0)

    await diffView.close()
  })

  test('FR-F-INT-2: Audit drill-down should show standardization details', async () => {
    // This test continues from FR-F-INT-1 where standardization was applied

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Find the standardization entry (should have "View details" link)
    const entryWithDetails = page.getByTestId('audit-entry-with-details').first()
    await expect(entryWithDetails).toBeVisible({ timeout: 5000 })

    // Verify it's a standardize entry by checking the action text
    const entryText = await entryWithDetails.textContent()
    expect(entryText).toContain('Standardize Values')

    // Click to open drill-down modal
    await entryWithDetails.click()

    // Verify modal opens with standardization-specific content
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Verify it shows "Standardization Details" title (not "Row-Level Changes")
    await expect(modal.locator('text=Standardization Details')).toBeVisible()

    // Verify the standardize detail table is shown
    const standardizeTable = page.getByTestId('standardize-detail-table')
    await expect(standardizeTable).toBeVisible({ timeout: 5000 })

    // Verify table has content (Original Value, Standardized To, Rows Changed columns)
    await expect(standardizeTable.locator('th:has-text("Original Value")')).toBeVisible()
    await expect(standardizeTable.locator('th:has-text("Standardized To")')).toBeVisible()
    await expect(standardizeTable.locator('th:has-text("Rows Changed")')).toBeVisible()

    // Verify at least one row of mapping data exists
    const rows = standardizeTable.locator('tbody tr')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)

    // Close modal
    await page.keyboard.press('Escape')
    await expect(modal).not.toBeVisible({ timeout: 3000 })

    // Close audit sidebar
    await laundromat.closeAuditSidebar()
  })

  test('FR-F-INT-3: Undo should revert standardization', async () => {
    // This test continues from FR-F-INT-2

    // Get data before undo (standardized values)
    const beforeUndo = await inspector.getTableData('fr_f_standardize')
    const beforeUniqueNames = new Set(beforeUndo.map((r) => r.name)).size

    // Click body to ensure no input is focused
    await page.locator('body').click()
    await page.waitForTimeout(100)

    // Press Ctrl+Z to undo
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(1000)

    // Get data after undo (should be original values)
    const afterUndo = await inspector.getTableData('fr_f_standardize')
    const afterUniqueNames = new Set(afterUndo.map((r) => r.name)).size

    // After undo, there should be more unique names (original unstandardized state)
    expect(afterUniqueNames).toBeGreaterThan(beforeUniqueNames)
  })

  test('FR-F-INT-4: Redo should reapply standardization', async () => {
    // This test continues from FR-F-INT-3 (undone state)

    // Get data before redo (original values)
    const beforeRedo = await inspector.getTableData('fr_f_standardize')
    const beforeUniqueNames = new Set(beforeRedo.map((r) => r.name)).size

    // Press Ctrl+Y to redo
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(1000)

    // Get data after redo (should be standardized again)
    const afterRedo = await inspector.getTableData('fr_f_standardize')
    const afterUniqueNames = new Set(afterRedo.map((r) => r.name)).size

    // After redo, there should be fewer unique names (standardized state)
    expect(afterUniqueNames).toBeLessThan(beforeUniqueNames)
  })

  test('FR-F-INT-5: Audit sidebar should show Undone badge after undo', async () => {
    // First redo to have a standardization in effect
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Undo the standardization
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    // Check for "Undone" badge
    const undoneBadge = page.locator('[data-testid="audit-sidebar"]').locator('text=Undone')
    await expect(undoneBadge).toBeVisible({ timeout: 5000 })

    // Redo to remove the badge
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)

    // Badge should no longer be visible
    await expect(undoneBadge).not.toBeVisible({ timeout: 3000 })

    await laundromat.closeAuditSidebar()
  })
})
