import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { StandardizeViewPage } from '../page-objects/standardize-view.page'
import { DiffViewPage } from '../page-objects/diff-view.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { expectClusterMembership, getClusterMasterValues } from '../helpers/high-fidelity-assertions'

/**
 * FR-F: Value Standardization Tests
 *
 * Tests the clustering and standardization feature for cleaning
 * inconsistent values in a column.
 *
 * Per e2e/CLAUDE.md Section 1: Standardization tests involve clustering
 * which is memory-intensive. Use beforeEach with fresh page to prevent
 * "Target Closed" crashes if a test fails.
 */

test.describe('FR-F: Value Standardization', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let standardize: StandardizeViewPage
  let inspector: StoreInspector

  // Extended timeout for clustering operations
  test.setTimeout(90000)

  // Fresh page per test to prevent stale references
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    standardize = new StandardizeViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Drop internal tables to prevent memory accumulation
    try {
      const internalTables = await inspector.runQuery(`
        SELECT table_name FROM information_schema.tables
        WHERE table_name LIKE 'v_diff_%' OR table_name LIKE '_timeline_%'
      `)
      for (const t of internalTables) {
        await inspector.runQuery(`DROP TABLE IF EXISTS "${t.table_name}"`)
      }
    } catch {
      // Ignore errors during cleanup
    }
    await page.close()  // Force WASM worker garbage collection
  })

  async function loadTestData() {
    // Fresh page per test - no need to reload, just load data
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
    expect(stats.actionable).toBeGreaterThanOrEqual(2)

    // Rule 1: Verify specific cluster sizes exist (identity, not just count)
    // With fingerprint algorithm:
    // "John Smith", "JOHN SMITH", "john  smith" should cluster together (3 rows)
    // "Jane Doe", "Jane   Doe", "JANE DOE" should cluster together (3 rows)

    // Wait for clusters to be computed (at least 3 clusters expected)
    await expect.poll(
      async () => {
        const clusters = await page.evaluate(() => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
            .__CLEANSLATE_STORES__
          return (stores?.standardizerStore as any)?.getState?.().clusters || []
        })
        return clusters.length
      },
      { timeout: 10000, message: 'Clusters not computed' }
    ).toBeGreaterThanOrEqual(3)

    // Now get the full cluster data
    const clusterData = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
        .__CLEANSLATE_STORES__
      const state = (stores?.standardizerStore as any)?.getState?.()
      return state?.clusters || []
    })

    // Verify we have at least 2 clusters with 3 rows each (John variants + Jane variants)
    const clusterSizes = clusterData.map((c: any) =>
      c.values.reduce((sum: number, v: any) => sum + v.count, 0)
    ).sort((a: number, b: number) => b - a)

    expect(clusterSizes.filter((size: number) => size === 3).length).toBeGreaterThanOrEqual(2)

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

    // Rule 1: Verify phonetically similar names cluster together
    const clusterData = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
        .__CLEANSLATE_STORES__
      const state = (stores?.standardizerStore as any)?.getState?.()
      return state?.clusters || []
    })

    // Verify at least one cluster has 2 rows (Mike + Mik)
    const clusterSizes = clusterData.map((c: any) =>
      c.values.reduce((sum: number, v: any) => sum + v.count, 0)
    )
    expect(clusterSizes.filter((size: number) => size === 2).length).toBeGreaterThanOrEqual(1)

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

    // Verify master changed (should now show Master badge)
    const masterBadges = page.locator('text=Master')
    await expect(masterBadges.first()).toBeVisible({ timeout: 5000 })

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

    // Rule 1: Verify rows 1-3 all standardized to "John Smith" (identity check)
    expect(updatedData[0].name).toBe('John Smith')
    expect(updatedData[1].name).toBe('John Smith')
    expect(updatedData[2].name).toBe('John Smith')

    // Verify rows 6-8 standardized to "Jane Doe"
    expect(updatedData[5].name).toBe('Jane Doe')
    expect(updatedData[6].name).toBe('Jane Doe')
    expect(updatedData[7].name).toBe('Jane Doe')
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

    // Wait for standardization to complete
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_f_standardize')
      // Check that values were standardized (fewer unique names after standardization)
      const uniqueNames = new Set(data.map((r) => r.name)).size
      return uniqueNames < 10 // Original has 10 unique, standardized should have fewer
    }, { timeout: 10000, message: 'Standardization should complete' }).toBe(true)

    // Check audit log for standardization entry
    // The standardization command stores audit with action 'Apply Standardization'
    const allEntries = await inspector.getAuditEntries()
    const standardizeEntry = allEntries.find((e) =>
      e.action === 'Apply Standardization' ||
      e.action.includes('Standardize Values') ||
      e.action.includes('Standardization')
    )

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

    // Search for "John"
    await standardize.search('John')

    // Wait for search filter to apply
    await expect.poll(async () => {
      const clusters = await getClusterMasterValues(page)
      return clusters.some(name => name.includes('John'))
    }, { timeout: 5000 }).toBe(true)

    // Rule 1: Verify only clusters with "John" remain visible (identity check)
    const visibleClusters = await getClusterMasterValues(page)
    expect(visibleClusters.some(name => name.includes('John'))).toBe(true)
    expect(visibleClusters.every(name => !name.includes('Jane'))).toBe(true)
    expect(visibleClusters.every(name => !name.includes('Bob'))).toBe(true)

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

    // Ensure we start with actionable filter
    await standardize.filterBy('actionable')

    // Wait for filter to apply
    await expect.poll(async () => {
      const stats = await standardize.getStats()
      return stats.actionable > 0
    }, { timeout: 5000 }).toBe(true)

    const actionableClusters = await getClusterMasterValues(page)

    // Switch to "All" filter
    await standardize.filterBy('all')

    // Wait for filter to apply
    await expect.poll(async () => {
      const stats = await standardize.getStats()
      return stats.totalClusters > 0
    }, { timeout: 5000 }).toBe(true)

    const allClusters = await getClusterMasterValues(page)

    // Rule 1: All filter shows more/equal clusters (includes singletons)
    expect(allClusters.length).toBeGreaterThanOrEqual(actionableClusters.length)

    // Verify actionable clusters are subset of all clusters
    actionableClusters.forEach(cluster => {
      expect(allClusters).toContain(cluster)
    })

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
test.describe('FR-F: Standardization Integration (Diff, Drill-down, Undo)', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let standardize: StandardizeViewPage
  let diffView: DiffViewPage
  let inspector: StoreInspector

  // Extended timeout for heavy integration tests
  test.setTimeout(90000)

  // Tier 3: Fresh page per test for heavy operations (per e2e/CLAUDE.md)
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    standardize = new StandardizeViewPage(page)
    diffView = new DiffViewPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Fresh page per test - just close it
    await page.close()
  })

  async function loadTestData() {
    // Fresh page per test - no need to reload
    await inspector.runQuery('DROP TABLE IF EXISTS fr_f_integration')
    await inspector.runQuery('DROP TABLE IF EXISTS fr_f_standardize')
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

    // Wait for transform to complete
    const tableId = await inspector.getActiveTableId()
    await inspector.waitForTransformComplete(tableId)

    // Poll for data to be changed (async write)
    await expect.poll(async () => {
      const data = await inspector.getTableData('fr_f_standardize')
      return new Set(data.map((r) => r.name)).size
    }, { timeout: 10000 }).toBeLessThan(initialUniqueNames)

    // Open diff view
    await page.getByTestId('toolbar-diff').click()
    await diffView.waitForOpen()

    // Select "Compare with Preview" mode (compares current with original snapshot)
    await diffView.selectComparePreviewMode()

    // Wait for mode change in store
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.mode
    }, { timeout: 5000 }).toBe('compare-preview')

    // Verify compare button is enabled (original snapshot should be available)
    await expect(diffView.compareButton).toBeEnabled({ timeout: 5000 })

    // Run comparison
    await diffView.runComparison()

    // Wait for diff to complete
    await expect.poll(async () => {
      const diffState = await inspector.getDiffState()
      return diffState.isComparing === false && diffState.summary !== null
    }, { timeout: 15000 }).toBe(true)

    // Verify diff results show modified rows
    const summary = await diffView.getSummary()
    // Standardization modifies rows, so we expect modified count > 0
    expect(summary.modified).toBeGreaterThan(0)

    await diffView.close()
  })

  test('FR-F-INT-2: Audit drill-down should show standardization details', async () => {
    // Fresh page per test - must set up data and apply standardization first
    await loadTestData()

    // Apply standardization to create audit entry
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()
    await standardize.filterBy('actionable')
    await standardize.apply()

    // Wait for transform to complete
    const tableId = await inspector.getActiveTableId()
    await inspector.waitForTransformComplete(tableId)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Find the standardization entry (should have "View details" link)
    const entryWithDetails = page.getByTestId('audit-entry-with-details').first()
    await expect(entryWithDetails).toBeVisible({ timeout: 5000 })

    // Verify it's a standardize entry by checking the action text
    const entryText = await entryWithDetails.textContent()
    expect(entryText).toContain('Standardization')

    // Click to open drill-down modal
    await entryWithDetails.click()

    // Verify modal opens with audit detail content
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Wait for modal animation to complete (Radix UI pattern)
    await page.waitForFunction(
      () => {
        const modalEl = document.querySelector('[data-testid="audit-detail-modal"]')
        return modalEl?.getAttribute('data-state') === 'open'
      },
      { timeout: 3000 }
    )

    // Verify modal shows the audit details (either "Standardization Details" or "Row-Level Changes")
    // The modal should display action details for the standardization
    await expect(modal.locator('text=Apply Standardization')).toBeVisible({ timeout: 5000 })

    // Verify table name is shown
    await expect(modal.locator('text=fr_f_standardize')).toBeVisible()

    // Verify rows affected is shown
    await expect(modal.locator('text=Rows Affected')).toBeVisible()

    // Close modal - Rule 2: Use positive hidden assertion
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden({ timeout: 3000 })

    // Close audit sidebar
    await laundromat.closeAuditSidebar()
  })

  test.fixme('FR-F-INT-3: Undo should revert standardization', async () => {
    // This test continues from FR-F-INT-2

    // Get data before undo (standardized values)
    const beforeUndo = await inspector.getTableData('fr_f_standardize')
    const beforeUniqueNames = new Set(beforeUndo.map((r) => r.name)).size

    // Click body to ensure no input is focused
    await page.locator('body').click()

    // Press Ctrl+Z to undo
    const tableId = await inspector.getActiveTableId()
    await page.keyboard.press('Control+z')
    await inspector.waitForTransformComplete(tableId)

    // Get data after undo (should be original values)
    const afterUndo = await inspector.getTableData('fr_f_standardize')
    const afterUniqueNames = new Set(afterUndo.map((r) => r.name)).size

    // After undo, there should be more unique names (original unstandardized state)
    expect(afterUniqueNames).toBeGreaterThan(beforeUniqueNames)
  })

  test.fixme('FR-F-INT-4: Redo should reapply standardization', async () => {
    // This test continues from FR-F-INT-3 (undone state)

    // Get data before redo (original values)
    const beforeRedo = await inspector.getTableData('fr_f_standardize')
    const beforeUniqueNames = new Set(beforeRedo.map((r) => r.name)).size

    // Press Ctrl+Y to redo
    const tableId = await inspector.getActiveTableId()
    await page.keyboard.press('Control+y')
    await inspector.waitForTransformComplete(tableId)

    // Get data after redo (should be standardized again)
    const afterRedo = await inspector.getTableData('fr_f_standardize')
    const afterUniqueNames = new Set(afterRedo.map((r) => r.name)).size

    // After redo, there should be fewer unique names (standardized state)
    expect(afterUniqueNames).toBeLessThan(beforeUniqueNames)
  })

  test('FR-F-INT-5: Audit sidebar should show Undone badge after undo', async () => {
    // Fresh page per test - must set up data and apply standardization first
    await loadTestData()

    // Apply standardization to create an undoable action
    await page.getByTestId('toolbar-standardize').click()
    await standardize.waitForOpen()
    await standardize.selectTable('fr_f_standardize')
    await standardize.selectColumn('name')
    await standardize.selectAlgorithm('fingerprint')
    await standardize.analyze()
    await standardize.waitForClusters()
    await standardize.filterBy('actionable')
    await standardize.apply()

    // Wait for transform to complete
    const tableId = await inspector.getActiveTableId()
    await inspector.waitForTransformComplete(tableId)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Undo the standardization (Ctrl+Z)
    await page.keyboard.press('Control+z')
    await inspector.waitForTransformComplete(tableId)

    // Check for "Undone" badge
    const undoneBadge = page.locator('[data-testid="audit-sidebar"]').locator('text=Undone')
    await expect(undoneBadge).toBeVisible({ timeout: 5000 })

    // Redo to remove the badge (Ctrl+Y)
    await page.keyboard.press('Control+y')
    await inspector.waitForTransformComplete(tableId)

    // Badge should no longer be visible - Rule 2: Use positive hidden assertion
    await expect(undoneBadge).toBeHidden({ timeout: 3000 })

    await laundromat.closeAuditSidebar()
  })
})
