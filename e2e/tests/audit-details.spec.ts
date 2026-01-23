import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { downloadAndVerifyTXT } from '../helpers/download-helpers'

/**
 * Audit Row Details Tests
 *
 * Tests for row-level audit details capture, modal display, and export functionality.
 * These tests verify the feature that tracks individual row changes during transformations.
 */

test.describe.serial('Audit Row Details', () => {
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

  test('should set hasRowDetails and auditEntryId after transformation', async () => {
    await loadTestData()

    // Apply a transformation that affects some rows (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Find & Replace', {
      column: 'name',
      params: { Find: 'hello', 'Replace with': 'hi' },
      selectParams: { 'Case Sensitive': 'No' },
    })
    await laundromat.closePanel()

    // Verify audit entry has hasRowDetails and auditEntryId set
    const auditEntries = await inspector.getAuditEntries()
    const transformEntry = auditEntries.find((e) => e.action.includes('Find & Replace'))

    expect(transformEntry).toBeDefined()
    expect(transformEntry?.hasRowDetails).toBe(true)
    expect(transformEntry?.auditEntryId).toBeDefined()
    expect(typeof transformEntry?.auditEntryId).toBe('string')
    expect(transformEntry?.rowsAffected).toBeGreaterThan(0)
  })

  test('should store row-level changes in _audit_details table', async () => {
    // Use data from previous test (transformation already applied)
    // Query the _audit_details table directly
    const auditEntries = await inspector.getAuditEntries()
    const transformEntry = auditEntries.find((e) => e.action.includes('Find & Replace'))

    expect(transformEntry?.auditEntryId).toBeDefined()

    // Query _audit_details table for this entry
    const details = await inspector.runQuery(
      `SELECT * FROM _audit_details WHERE audit_entry_id = '${transformEntry?.auditEntryId}' ORDER BY row_index`
    )

    // Should have row-level changes captured
    expect(details.length).toBeGreaterThan(0)

    // Verify the structure of row details
    const firstDetail = details[0]
    expect(firstDetail).toHaveProperty('row_index')
    expect(firstDetail).toHaveProperty('column_name')
    expect(firstDetail).toHaveProperty('previous_value')
    expect(firstDetail).toHaveProperty('new_value')

    // Verify the transformation was applied correctly
    // "Hello" -> "hi", "hello" -> "hi", "HELLO" -> "hi", "say hello" -> "say hi"
    const nameChanges = details.filter((d) => d.column_name === 'name')
    expect(nameChanges.length).toBe(4) // All 4 rows had "hello" in some form
    // Rule 1: Verify specific before/after values
    const previousValues = nameChanges.map((c) => c.previous_value as string)
    const newValues = nameChanges.map((c) => c.new_value as string)
    expect(previousValues).toEqual(expect.arrayContaining(['Hello', 'hello', 'HELLO', 'say hello']))
    expect(newValues).toEqual(['hi', 'hi', 'hi', 'say hi'])
  })

  test('should open audit detail modal when clicking entry with details', async () => {
    // Switch to audit log tab
    await laundromat.switchToAuditLogTab()

    // Wait for audit log panel to be visible
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Click the entry with details
    const entryWithDetails = page.getByTestId('audit-entry-with-details').first()
    await expect(entryWithDetails).toBeVisible()
    await entryWithDetails.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible()

    // Verify modal title
    await expect(modal.locator('text=Row-Level Changes')).toBeVisible()
  })

  test('should display row-level changes in modal table', async () => {
    // Modal should still be open from previous test
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible()

    // Verify table is displayed
    const table = page.getByTestId('audit-detail-table')
    await expect(table).toBeVisible()

    // Verify table headers
    await expect(table.locator('th:has-text("Row #")')).toBeVisible()
    await expect(table.locator('th:has-text("Column")')).toBeVisible()
    await expect(table.locator('th:has-text("Previous Value")')).toBeVisible()
    await expect(table.locator('th:has-text("New Value")')).toBeVisible()

    // Verify rows are displayed
    const rows = page.getByTestId('audit-detail-row')
    await expect(rows.first()).toBeVisible()

    // Count rows - should have 4 changes
    const rowCount = await rows.count()
    expect(rowCount).toBe(4)
  })

  test('should export row details as CSV from modal', async () => {
    // Modal should still be open
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible()

    // Start waiting for download before clicking
    const downloadPromise = page.waitForEvent('download')

    // Click export CSV button in modal
    await page.getByTestId('audit-detail-export-csv-btn').click()

    // Wait for download
    const download = await downloadPromise

    // Verify filename pattern
    const filename = download.suggestedFilename()
    expect(filename).toMatch(/^audit_details_.*_\d+rows\.csv$/)

    // Get file content
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
      }
    }
    const content = Buffer.concat(chunks).toString('utf-8')

    // Verify CSV header
    expect(content).toContain('Row Index,Column,Previous Value,New Value')

    // Verify data rows exist
    const lines = content.trim().split('\n')
    expect(lines.length).toBeGreaterThan(1) // Header + at least one data row

    // Close the modal - Rule 2: Use positive hidden assertion
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('should include row details in full audit log export', async () => {
    // Ensure we're on audit log tab
    await laundromat.switchToAuditLogTab()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Export the full audit log as TXT
    const result = await downloadAndVerifyTXT(page, '[data-testid="audit-export-btn"]')

    // Verify filename pattern (new sidebar uses simpler filename)
    expect(result.filename).toMatch(/^audit_log.*\.txt$/)

    // Verify the content includes row details section
    expect(result.content).toContain('Row Details')
    expect(result.content).toMatch(/\d+ changes?/)

    // Verify individual row changes are listed
    expect(result.content).toContain('Row')
    expect(result.content).toContain('name')
    expect(result.content).toContain('→') // Arrow between old and new values
  })
})

test.describe.serial('Audit Row Details - Edge Cases', () => {
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

  async function loadWhitespaceData() {
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)
  }

  test('should capture row details for trim transformation', async () => {
    await loadWhitespaceData()

    // Apply trim transformation (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    // Verify audit entry has row details
    const auditEntries = await inspector.getAuditEntries()
    const trimEntry = auditEntries.find((e) => e.action.includes('Trim'))

    expect(trimEntry).toBeDefined()
    expect(trimEntry?.hasRowDetails).toBe(true)
    expect(trimEntry?.auditEntryId).toBeDefined()

    // Verify _audit_details table has the changes
    const details = await inspector.runQuery(
      `SELECT * FROM _audit_details WHERE audit_entry_id = '${trimEntry?.auditEntryId}'`
    )

    // Only rows with whitespace to trim should be captured (2 of 3)
    // Row 3 "Bob Johnson" has no whitespace, so no change recorded
    expect(details.length).toBe(2)

    // Verify previous values had whitespace
    const prevValues = details.map((d) => d.previous_value as string)
    const hasWhitespace = prevValues.some((v) => v.startsWith(' ') || v.endsWith(' '))
    expect(hasWhitespace).toBe(true)

    // Verify new values are trimmed
    const newValues = details.map((d) => d.new_value as string)
    const allTrimmed = newValues.every((v) => v === v.trim())
    expect(allTrimmed).toBe(true)
  })

  test('should capture row details for uppercase transformation', async () => {
    await loadWhitespaceData()

    // Apply uppercase transformation (direct-apply model)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    // Verify audit entry has row details
    const auditEntries = await inspector.getAuditEntries()
    const uppercaseEntry = auditEntries.find((e) => e.action.includes('Uppercase'))

    expect(uppercaseEntry).toBeDefined()
    expect(uppercaseEntry?.hasRowDetails).toBe(true)

    // Verify _audit_details table
    const details = await inspector.runQuery(
      `SELECT * FROM _audit_details WHERE audit_entry_id = '${uppercaseEntry?.auditEntryId}'`
    )

    // All rows should be uppercased
    expect(details.length).toBe(3)

    // Verify new values are uppercase
    const newValues = details.map((d) => d.new_value as string)
    const allUppercase = newValues.every((v) => v === v.toUpperCase())
    expect(allUppercase).toBe(true)
  })

  test('should show View details link for manual edit entries and open modal', async () => {
    await loadWhitespaceData()

    // Perform a manual cell edit on row 0, column 0 (id column)
    await laundromat.switchToDataPreviewTab()
    await laundromat.editCell(0, 0, '99')

    // Wait for edit to be processed
    await page.waitForTimeout(500)

    // Switch to audit log
    await laundromat.switchToAuditLogTab()
    await page.waitForSelector('[data-testid="audit-sidebar"]')

    // Wait for audit entries to be visible
    await page.waitForTimeout(300)

    // Get audit entries
    const auditEntries = await inspector.getAuditEntries()
    const manualEditEntry = auditEntries.find(
      (e) => e.action === 'Manual Edit' || e.entryType === 'B'
    )

    // Manual edit should have hasRowDetails and auditEntryId set
    expect(manualEditEntry).toBeDefined()
    expect(manualEditEntry?.hasRowDetails).toBe(true)
    expect(manualEditEntry?.auditEntryId).toBeDefined()
    expect(typeof manualEditEntry?.auditEntryId).toBe('string')

    // Find the Manual Edit entry in the UI (uses div with role="button", not actual button)
    const manualEditElement = page
      .locator('[data-testid="audit-sidebar"]')
      .locator('[data-testid="audit-entry-with-details"]')
      .filter({ hasText: 'Manual Edit' })
      .first()

    await expect(manualEditElement).toBeVisible({ timeout: 10000 })

    // This element SHOULD have the "View details" text since it now has drill-down
    await expect(manualEditElement.locator('text=View details')).toBeVisible()

    // Click to open the modal
    await manualEditElement.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible()

    // Verify modal title shows "Manual Edit Details"
    await expect(modal.locator('text=Manual Edit Details')).toBeVisible()

    // Verify ManualEditDetailView is displayed
    await expect(page.getByTestId('manual-edit-detail-view')).toBeVisible()
    await expect(page.getByTestId('manual-edit-detail-table')).toBeVisible()
    await expect(page.getByTestId('manual-edit-detail-row')).toBeVisible()

    // Close the modal - Rule 2: Use positive hidden assertion
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('should export manual edit details as CSV', async () => {
    // Perform another manual edit to have fresh data
    await loadWhitespaceData()

    await laundromat.closeAuditSidebar()
    await laundromat.editCell(1, 1, 'Modified Value')

    // Wait for edit to be processed
    await page.waitForTimeout(500)

    // Open audit sidebar
    await laundromat.openAuditSidebar()
    await page.waitForSelector('[data-testid="audit-sidebar"]')
    await page.waitForTimeout(300)

    // Find and click the Manual Edit entry - use role selector for reliability
    const sidebar = page.locator('aside[data-testid="audit-sidebar"]')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Look for the Manual Edit button within the sidebar
    const manualEditElement = sidebar.getByRole('button', { name: /Manual Edit/i }).first()
    await expect(manualEditElement).toBeVisible({ timeout: 10000 })
    await manualEditElement.click()

    // Verify modal opens
    const modal = page.getByTestId('audit-detail-modal')
    await expect(modal).toBeVisible()

    // Start waiting for download before clicking
    const downloadPromise = page.waitForEvent('download')

    // Click export CSV button in modal
    await page.getByTestId('audit-detail-export-csv-btn').click()

    // Wait for download
    const download = await downloadPromise

    // Verify filename pattern: manual_edit_*_1row.csv
    const filename = download.suggestedFilename()
    expect(filename).toMatch(/^manual_edit_.*_1row\.csv$/)

    // Get file content
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
      }
    }
    const content = Buffer.concat(chunks).toString('utf-8')

    // Verify CSV header
    expect(content).toContain('Row Index,Column,Previous Value,New Value')

    // Verify single data row exists (header + 1 data row = 2 lines)
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    // Close the modal - Rule 2: Use positive hidden assertion
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })
})
