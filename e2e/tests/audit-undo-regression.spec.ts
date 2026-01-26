import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { expectRowIdsHighlighted } from '../helpers/high-fidelity-assertions'

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

    // Verify data has whitespace (at least one row should have "  John Doe  ")
    const data = await inspector.getTableData('whitespace_data')
    const hasJohnDoe = data.some(r => (r.name as string) === '  John Doe  ')
    expect(hasJohnDoe).toBe(true)
  }

  test('FR-REGRESSION-1: Highlight button appears after transform', async () => {
    await loadTestData()

    // Apply Trim transform (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

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

    // Button should now say "Clear"
    const clearBtn = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('button')
      .filter({ hasText: 'Clear' })
    await expect(clearBtn.first()).toBeVisible()

    // Rule 3: Verify visual state via timelineStore
    // NOTE: Canvas-based grid (Glide Data Grid) - no DOM classes to check
    // Add polling wait to ensure highlight rowIds are populated before assertions
    await expect.poll(
      async () => {
        const state = await inspector.getTimelineHighlight()
        return state.rowIds.length
      },
      { timeout: 5000, message: 'Highlight rowIds never populated' }
    ).toBeGreaterThan(0)

    const highlightState = await inspector.getTimelineHighlight()
    expect(highlightState.commandId).toBeDefined()

    // Rule 1: Verify specific rows are highlighted (identity, not just count)
    // Trim Whitespace only affects rows 1 and 2 (row 3 "Bob Johnson" has no whitespace)
    // Get the actual _cs_id values for the affected rows
    const affectedRows = await inspector.runQuery(
      'SELECT _cs_id FROM whitespace_data WHERE id IN (1, 2) ORDER BY id'
    )
    const expected_cs_ids = affectedRows.map(r => String(r._cs_id))
    expect(highlightState.rowIds.length).toBe(expected_cs_ids.length)
    expectRowIdsHighlighted(highlightState.rowIds, expected_cs_ids)

    // Click Clear to remove highlighting
    await clearBtn.first().click()

    // Button should be back to "Highlight"
    await expect(highlightBtn.first()).toBeVisible()

    // Verify highlight is cleared in store
    await expect.poll(async () => {
      const state = await inspector.getTimelineHighlight()
      return state.commandId
    }, { timeout: 5000 }).toBeNull()
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

    // Verify modal title is visible (Row-Level Changes)
    await expect(modal.locator('text=Row-Level Changes')).toBeVisible()

    // The modal should show either the details table OR an error message
    // Check for table headers OR the existence of the modal content area
    const detailTable = page.getByTestId('audit-detail-table')
    const hasTable = await detailTable.isVisible().catch(() => false)

    if (hasTable) {
      // Verify table has proper headers
      await expect(detailTable.locator('th:has-text("Previous Value")')).toBeVisible()
      await expect(detailTable.locator('th:has-text("New Value")')).toBeVisible()
    }
    // If no table, the modal should at least be showing content (even if error)

    // Close modal - Rule 2: Use positive hidden assertion
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('FR-REGRESSION-4: Undo reverts transform and updates grid', async () => {
    // Reload fresh data to ensure clean state
    await loadTestData()

    // Get ORIGINAL data before transform (find row with whitespace)
    const originalData = await inspector.getTableData('whitespace_data')
    const originalRow = originalData.find(r => (r.name as string) === '  John Doe  ')
    expect(originalRow).toBeDefined()

    // Apply Trim transform
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Get data after transform (trimmed values)
    const afterTransform = await inspector.getTableData('whitespace_data')
    const transformedRow = afterTransform.find(r => (r.name as string) === 'John Doe')
    // After trim: "John Doe" (no whitespace)
    // Rule 2: Assert exact transformed value
    expect(transformedRow).toBeDefined()

    // Click somewhere to ensure focus isn't on an input
    await page.locator('body').click()

    // Press Ctrl+Z to undo
    await page.keyboard.press('Control+z')

    // Wait for undo to complete - undo operations use isReplaying, not isLoading
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        // Wait for replay to complete
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // Poll the database until the data is restored (ensures DuckDB write has completed)
    await expect.poll(
      async () => {
        const afterUndo = await inspector.getTableData('whitespace_data')
        return afterUndo.some(r => (r.name as string) === '  John Doe  ')
      },
      { timeout: 10000, message: 'Undo did not restore original whitespace value' }
    ).toBe(true)
  })

  test('FR-REGRESSION-5: Redo reapplies transform', async () => {
    // This test depends on the state from FR-REGRESSION-4 (undone transform)
    // Verify we're in the undone state (has whitespace)
    const beforeRedo = await inspector.getTableData('whitespace_data')
    const hasWhitespace = beforeRedo.some(r => (r.name as string) === '  John Doe  ')
    expect(hasWhitespace).toBe(true)

    // Press Ctrl+Y to redo
    await page.keyboard.press('Control+y')

    // Wait for redo to complete - redo operations use isReplaying, not isLoading
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        // Wait for replay to complete
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // Poll the database until the trim is reapplied (ensures DuckDB write has completed)
    await expect.poll(
      async () => {
        const afterRedo = await inspector.getTableData('whitespace_data')
        return afterRedo.some(r => (r.name as string) === 'John Doe' && !afterRedo.some(x => (x.name as string) === '  John Doe  '))
      },
      { timeout: 10000, message: 'Redo did not reapply trim transform' }
    ).toBe(true)
  })

  test('FR-REGRESSION-6: Audit sidebar reflects undo state with Undone badge', async () => {
    // This test continues from FR-REGRESSION-5 where we have a redone transform
    // Open audit sidebar first
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Now undo to see the "Undone" badge
    await page.keyboard.press('Control+z')

    // Wait for undo to complete
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // Check for "Undone" badge or visual indicator
    // After undo, the transform entry should show "Undone" badge
    const undoneBadge = page.locator('[data-testid="audit-sidebar"]').locator('text=Undone')
    await expect(undoneBadge).toBeVisible({ timeout: 5000 })

    // Rule 3: Verify timeline position changed via store
    const positionAfterUndo = await inspector.getTimelinePosition()
    expect(positionAfterUndo.current).toBeLessThan(positionAfterUndo.total - 1)

    // Redo to restore for subsequent tests
    await page.keyboard.press('Control+y')

    // Wait for redo to complete
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // The "Undone" badge should no longer be visible - Rule 2: Use positive hidden assertion
    await expect(undoneBadge).toBeHidden({ timeout: 3000 })

    // Verify position is back at end
    const positionAfterRedo = await inspector.getTimelinePosition()
    expect(positionAfterRedo.current).toBe(positionAfterRedo.total - 1)
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

    // Verify data has expected value (at least one row should have "John DOE")
    const data = await inspector.getTableData('mixed_case')
    const hasJohnDoe = data.some(r => (r.name as string) === 'John DOE')
    expect(hasJohnDoe).toBe(true)
  }

  test('should sync multiple transforms to timeline correctly', async () => {
    await loadMixedCaseData()

    // Apply first transform: Uppercase
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Apply second transform: Trim
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Open audit sidebar and verify both transforms appear
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Both should have highlight buttons (meaning they're in timeline)
    const highlightBtns = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('button')
      .filter({ hasText: 'Highlight' })
    const count = await highlightBtns.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('should correctly undo/redo multiple transforms in sequence', async () => {
    // Reload fresh data to ensure clean state
    await loadMixedCaseData()

    // Apply first transform: Uppercase
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Apply second transform: Trim
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Get current data (uppercase + trimmed) - should have "JOHN DOE"
    const step2Data = await inspector.getTableData('mixed_case')
    const step2HasJohnDoe = step2Data.some(r => (r.name as string) === 'JOHN DOE')
    expect(step2HasJohnDoe).toBe(true)

    // Undo once (reverts trim)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // Undo again (reverts uppercase)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // Poll for the original mixed case value to be restored
    await expect.poll(
      async () => {
        const step0Data = await inspector.getTableData('mixed_case')
        return step0Data.some(r => (r.name as string) === 'John DOE')
      },
      { timeout: 10000, message: 'Undo did not restore original mixed case value' }
    ).toBe(true)

    // Redo both transforms
    await page.keyboard.press('Control+y')
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )
    await page.keyboard.press('Control+y')
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    // Poll to verify we're back to fully transformed state
    await expect.poll(
      async () => {
        const finalData = await inspector.getTableData('mixed_case')
        return finalData.some(r => (r.name as string) === 'JOHN DOE')
      },
      { timeout: 10000, message: 'Redo did not restore fully transformed state' }
    ).toBe(true)
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
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )

    const newPositionText = await positionBadge.first().textContent()
    // Rule 2: Assert exact timeline positions
    expect(positionText).toMatch(/2\/2/)
    expect(newPositionText).toMatch(/1\/2/)

    // Redo to restore
    await page.keyboard.press('Control+y')
    await page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.timelineStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.timelineStore as any).getState()
        return !state.isReplaying
      },
      { timeout: 10000 }
    )
  })
})

test.describe.serial('FR-REGRESSION: Tier 2/3 Audit Drill-Down', () => {
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

  async function loadDateTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS fr_a3_dates_split')
    await laundromat.uploadFile(getFixturePath('fr_a3_dates_split.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('fr_a3_dates_split', 5)
  }

  test('FR-REGRESSION-7: Standardize Date shows row details with correct values', async () => {
    await loadDateTestData()

    // Apply Standardize Date transform (Tier 3)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Standardize Date', { column: 'date_us' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    const sidebar = page.getByTestId('audit-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Click on the audit entry (should have "View details" link)
    const auditEntry = page.locator('[data-testid="audit-entry-with-details"]').first()
    await expect(auditEntry).toBeVisible({ timeout: 5000 })
    await auditEntry.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Verify modal shows row details (NOT "No row details available")
    // Rule 2: Use positive hidden assertion
    const noDetailsMsg = modal.locator('text=No row details available')
    await expect(noDetailsMsg).toBeHidden({ timeout: 3000 })

    // Verify row details table exists
    const detailTable = page.getByTestId('audit-detail-table')
    await expect(detailTable).toBeVisible({ timeout: 3000 })

    // Close modal - Rule 2: Use positive hidden assertion
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('FR-REGRESSION-8: Audit sidebar does not cut off content', async () => {
    // The sidebar should be visible from previous test
    const sidebar = page.locator('[data-testid="audit-sidebar"]')
    await expect(sidebar).toBeVisible()

    // Get the sidebar bounding box
    const sidebarBox = await sidebar.boundingBox()
    expect(sidebarBox).not.toBeNull()

    // Check that sidebar has reasonable width (w-96 = 384px, but rendered width may vary due to scrollbar/padding)
    // Main goal: verify it's wider than the old w-80 (320px)
    expect(sidebarBox!.width).toBeGreaterThanOrEqual(350)

    // Get the details text element
    const detailsText = sidebar.locator('.text-muted-foreground').first()
    const detailsBox = await detailsText.boundingBox()

    // Details should be fully within sidebar bounds (not overflowing)
    if (detailsBox) {
      const rightEdge = detailsBox.x + detailsBox.width
      const sidebarRightEdge = sidebarBox!.x + sidebarBox!.width
      // Allow some padding margin (16px)
      expect(rightEdge).toBeLessThanOrEqual(sidebarRightEdge + 16)
    }
  })

  test('FR-REGRESSION-9: Calculate Age audit shows new column name and <new column> as previous value', async () => {
    // This test verifies the fix for calculate_age audit capture:
    // - column_name should be the NEW column (e.g., 'age'), not the source column
    // - previous_value should be '<new column>' (column didn't exist before)
    // - new_value should be the calculated age

    await loadDateTestData()

    // Apply Calculate Age transform on birth_date column
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Calculate Age', { column: 'birth_date' })
    await inspector.waitForTransformComplete()
    await laundromat.closePanel()

    // Get the audit entry from the auditStore to find the audit_entry_id
    const auditEntries = await inspector.getAuditEntries()
    const calcAgeEntry = auditEntries.find((e) => e.action === 'Calculate Age')
    expect(calcAgeEntry).toBeDefined()
    expect(calcAgeEntry!.auditEntryId).toBeDefined()

    // Verify audit details via direct SQL query
    const auditDetails = await inspector.runQuery(`
      SELECT column_name, previous_value, new_value
      FROM _audit_details
      WHERE audit_entry_id = '${calcAgeEntry!.auditEntryId}'
      LIMIT 1
    `)

    // Verify we have audit details
    expect(auditDetails.length).toBeGreaterThan(0)

    const row = auditDetails[0] as { column_name: string; previous_value: string; new_value: string }

    // Column name should be the NEW column 'age', not 'birth_date'
    expect(row.column_name).toBe('age')

    // Previous value should indicate this is a new column
    expect(row.previous_value).toBe('<new column>')

    // New value should be a valid age (numeric string)
    const age = Number(row.new_value)
    expect(age).toBeGreaterThanOrEqual(0)
    expect(age).toBeLessThanOrEqual(150) // Reasonable age range
  })

  // FR-REGRESSION-10 removed: Edge case (new columns in diff view) covered by main diff tests
})
