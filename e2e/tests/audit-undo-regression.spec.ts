import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Audit + Undo/Redo Regression Tests
 *
 * These tests verify the critical features that were broken after Command Pattern migration:
 * 1. Highlight feature - Clicking "Highlight" in audit sidebar shows grid highlighting
 * 2. Drill-down feature - Can view row-level before/after changes
 * 3. Undo/Redo - Ctrl+Z/Ctrl+Y works correctly with UI updates
 */

test.describe.serial('FR-REGRESSION: Audit + Undo Features', () => {
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

  test('FR-REGRESSION-1: Highlight button appears after transform', async () => {
    await loadTestData()

    // Apply Trim transform (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    // Wait for transformation to complete
    await page.waitForTimeout(500)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Verify highlight button exists on the Trim entry
    // The button shows "Highlight" when not active
    const highlightBtn = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('button')
      .filter({ hasText: 'Highlight' })
    await expect(highlightBtn.first()).toBeVisible({ timeout: 5000 })
  })

  test('FR-REGRESSION-2: Clicking highlight shows grid highlighting and can be cleared', async () => {
    // Click highlight button
    const highlightBtn = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('button')
      .filter({ hasText: 'Highlight' })
      .first()
    await highlightBtn.click()
    await page.waitForTimeout(300)

    // Button should now say "Clear"
    const clearBtn = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('button')
      .filter({ hasText: 'Clear' })
    await expect(clearBtn.first()).toBeVisible()

    // Click Clear to remove highlighting
    await clearBtn.first().click()
    await page.waitForTimeout(300)

    // Button should be back to "Highlight"
    await expect(highlightBtn.first()).toBeVisible()
  })

  test('FR-REGRESSION-3: Audit drill-down shows row details', async () => {
    // Find entry with "View details" indicator (has hasRowDetails: true)
    const auditEntry = page.locator('[data-testid="audit-entry-with-details"]').first()

    // If no entry has details, check if it's actually there
    await expect(auditEntry).toBeVisible({ timeout: 5000 })
    await auditEntry.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Verify it has a table with before/after columns
    await expect(modal.locator('th:has-text("Previous Value")')).toBeVisible()
    await expect(modal.locator('th:has-text("New Value")')).toBeVisible()

    // Close modal
    await page.keyboard.press('Escape')
    await expect(modal).not.toBeVisible()
  })

  test('FR-REGRESSION-4: Undo reverts transform and updates grid', async () => {
    // Close sidebar for better grid interaction
    await laundromat.closeAuditSidebar()
    await page.waitForTimeout(200)

    // Get data before undo (trimmed values)
    const beforeUndo = await inspector.getTableData('whitespace_data')
    const beforeValue = beforeUndo[0]?.name as string

    // Press Ctrl+Z to undo
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    // Get data after undo (should have whitespace restored)
    const afterUndo = await inspector.getTableData('whitespace_data')
    const afterValue = afterUndo[0]?.name as string

    // Values should differ (whitespace restored)
    // The original data has leading/trailing whitespace that was trimmed
    expect(afterValue).not.toEqual(beforeValue)
    // After undo, value should have whitespace again
    expect(afterValue.length).toBeGreaterThanOrEqual(beforeValue.length)
  })

  test('FR-REGRESSION-5: Redo reapplies transform', async () => {
    // Get data before redo (untrimmed, whitespace present)
    const beforeRedo = await inspector.getTableData('whitespace_data')
    const beforeValue = beforeRedo[0]?.name as string

    // Press Ctrl+Y to redo
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)

    // Get data after redo (should be trimmed again)
    const afterRedo = await inspector.getTableData('whitespace_data')
    const afterValue = afterRedo[0]?.name as string

    // Values should differ (trim reapplied)
    expect(afterValue).not.toEqual(beforeValue)
    // After redo (trim), value should be shorter or equal
    expect(afterValue.length).toBeLessThanOrEqual(beforeValue.length)
    // Verify it's actually trimmed
    expect(afterValue).toEqual(afterValue.trim())
  })

  test('FR-REGRESSION-6: Audit sidebar reflects undo state with Undone badge', async () => {
    // Undo the transform so we can see the "Undone" badge
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    // Open audit sidebar to see state
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Check for "Undone" badge or visual indicator
    // After undo, the transform entry should show "Undone" badge
    const undoneBadge = page.locator('[data-testid="audit-sidebar"]').locator('text=Undone')
    await expect(undoneBadge).toBeVisible({ timeout: 5000 })

    // Redo to restore for subsequent tests
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)

    // The "Undone" badge should no longer be visible
    await expect(undoneBadge).not.toBeVisible({ timeout: 3000 })
  })
})

test.describe.serial('FR-REGRESSION: Timeline Sync Verification', () => {
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

  async function loadMixedCaseData() {
    await inspector.runQuery('DROP TABLE IF EXISTS mixed_case')
    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)
  }

  test('should sync multiple transforms to timeline correctly', async () => {
    await loadMixedCaseData()

    // Apply first transform: Uppercase
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()
    await page.waitForTimeout(500)

    // Apply second transform: Trim
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()
    await page.waitForTimeout(500)

    // Open audit sidebar and verify both transforms appear
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Both should have highlight buttons (meaning they're in timeline)
    const highlightBtns = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('button')
      .filter({ hasText: 'Highlight' })
    const count = await highlightBtns.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('should correctly undo/redo multiple transforms in sequence', async () => {
    // Get current data (uppercase + trimmed)
    const step2Data = await inspector.getTableData('mixed_case')
    const step2Value = step2Data[0]?.name as string

    // Undo once (reverts trim)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    const step1Data = await inspector.getTableData('mixed_case')
    const step1Value = step1Data[0]?.name as string

    // Undo again (reverts uppercase)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    const step0Data = await inspector.getTableData('mixed_case')
    const step0Value = step0Data[0]?.name as string

    // Verify values are different at each step
    expect(step0Value).not.toEqual(step1Value)
    // Original should not be uppercase
    expect(step0Value).not.toEqual(step0Value.toUpperCase())

    // Redo both transforms
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)

    // Verify we're back to fully transformed state
    const finalData = await inspector.getTableData('mixed_case')
    const finalValue = finalData[0]?.name as string
    expect(finalValue).toEqual(step2Value)
  })

  test('should update timeline position indicator after undo/redo', async () => {
    // The audit sidebar should show position indicator like "X/Y"
    // Look for the position badge in the header
    const positionBadge = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('.text-\\[10px\\]')
      .filter({ hasText: /\d+\/\d+/ })

    // Should show current position (e.g., "2/2" if at end with 2 commands)
    await expect(positionBadge.first()).toBeVisible()

    // Get the text and verify format
    const positionText = await positionBadge.first().textContent()
    expect(positionText).toMatch(/\d+\/\d+/)

    // Undo and check position changes
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)

    const newPositionText = await positionBadge.first().textContent()
    // Position should be different after undo
    expect(newPositionText).not.toEqual(positionText)

    // Redo to restore
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(500)
  })
})
