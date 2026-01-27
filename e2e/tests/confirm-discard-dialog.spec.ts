import { test, expect, Page, Browser, BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

/**
 * Confirmation Dialog Tests
 *
 * Tests the "Discard Undone Changes?" confirmation dialog that appears when
 * a user performs a new action while having undone operations (redo states).
 *
 * The dialog should appear for ANY action that would discard undone operations,
 * including transformations, merges, scrubs, standardizations, cell edits, etc.
 */

test.describe('Confirm Discard Dialog: Clean Panel Transformations', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  // Extend timeout for DuckDB-heavy tests
  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  // Use fresh CONTEXT per test for true isolation (prevents cascade failures from WASM crashes)
  // per e2e/CLAUDE.md: undo/redo operations are Tier 3 and need context isolation
  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close() // Terminates all pages + WebWorkers
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
    await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('whitespace_data', 3)
  }

  /**
   * Get a specific row by id for deterministic results.
   */
  async function getRowById(tableName: string, id: number): Promise<Record<string, unknown>> {
    const rows = await inspector.runQuery(`SELECT * FROM "${tableName}" WHERE id = ${id}`)
    return rows[0] || {}
  }

  test('should show confirmation dialog when applying transform after undo', async () => {
    await loadTestData()

    // Step 1: Apply first transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    // Verify transform applied (id=1 should be trimmed)
    await expect.poll(async () => {
      const row = await getRowById('whitespace_data', 1)
      return row.name
    }, { timeout: 10000 }).toBe('John Doe')

    // Step 2: Undo the transformation
    await page.locator('body').click() // Ensure focus
    await page.keyboard.press('Control+z')

    // Wait for undo to complete - id=1 should have whitespace again
    await expect.poll(async () => {
      const row = await getRowById('whitespace_data', 1)
      return row.name
    }, { timeout: 10000 }).toBe('  John Doe  ')

    // Verify we have future states (redo available) via timeline position
    const position = await inspector.getTimelinePosition()
    expect(position.current).toBeLessThan(position.total - 1)

    // Step 3: Attempt to apply a new transformation (use clickApply to not wait for completion)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Uppercase')
    await picker.selectColumn('name')
    await picker.clickApply()

    // Step 4: Verify confirmation dialog appears
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByText('Discard Undone Changes?')).toBeVisible()
    await expect(dialog.getByText(/\d+ undone operation/)).toBeVisible()

    // Close dialog without action for next test
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await laundromat.closePanel()
  })

  test('should preserve redo states when clicking Cancel', async () => {
    // Set up: Load data, apply transform, undo to create redo state
    await loadTestData()
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    // Undo to create redo state
    await page.locator('body').click()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => {
      const row = await getRowById('whitespace_data', 1)
      return row.name
    }, { timeout: 10000 }).toBe('  John Doe  ')

    // Verify we have redo state
    const position = await inspector.getTimelinePosition()
    expect(position.current).toBeLessThan(position.total - 1)

    // Attempt new transformation (use clickApply to not wait for completion)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Uppercase')
    await picker.selectColumn('name')
    await picker.clickApply()

    // Dialog should appear
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Click Cancel
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Verify redo state is still available
    const positionAfter = await inspector.getTimelinePosition()
    expect(positionAfter.current).toBeLessThan(positionAfter.total - 1)

    // Verify data was NOT changed (still has whitespace from undo state)
    const row = await getRowById('whitespace_data', 1)
    expect(row.name).toBe('  John Doe  ')

    await laundromat.closePanel()
  })

  test('should discard redo states and execute action when clicking Confirm', async () => {
    // Set up: Load data, apply transform, undo to create redo state
    await loadTestData()
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    // Undo to create redo state
    await page.locator('body').click()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => {
      const row = await getRowById('whitespace_data', 1)
      return row.name
    }, { timeout: 10000 }).toBe('  John Doe  ')

    // Verify we have redo state
    const positionBefore = await inspector.getTimelinePosition()
    expect(positionBefore.current).toBeLessThan(positionBefore.total - 1)

    // Attempt new transformation (use clickApply to not wait for completion)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Uppercase')
    await picker.selectColumn('name')
    await picker.clickApply()

    // Dialog should appear
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Click "Discard & Continue"
    const confirmButton = dialog.getByRole('button', { name: 'Discard & Continue' })
    await expect(confirmButton).toBeVisible()
    await confirmButton.click()
    await expect(dialog).toBeHidden()

    // Wait for transformation to complete - data should be uppercase
    await expect.poll(async () => {
      const row = await getRowById('whitespace_data', 1)
      return row.name
    }, { timeout: 10000 }).toBe('  JOHN DOE  ')

    // Verify we're now at the end (no redo states)
    const positionAfter = await inspector.getTimelinePosition()
    expect(positionAfter.current).toBe(positionAfter.total - 1)

    await laundromat.closePanel()
  })

  test('should NOT show dialog when no redo states exist', async () => {
    // Reload fresh data
    await loadTestData()

    // Verify we're at the end of history
    const position = await inspector.getTimelinePosition()
    expect(position.current).toBe(position.total - 1)

    // Apply transformation without any prior undo
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Trim Whitespace')
    await picker.selectColumn('name')
    await picker.apply()  // Full apply() works here since no dialog expected

    // Dialog should NOT appear (check immediately since apply() waited for completion)
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeHidden()

    // Verify transformation applied directly
    await expect.poll(async () => {
      const row = await getRowById('whitespace_data', 1)
      return row.name
    }, { timeout: 10000 }).toBe('John Doe')

    await laundromat.closePanel()
  })
})

test.describe('Confirm Discard Dialog: Multiple Undo States', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  // Extend timeout for DuckDB-heavy tests
  test.setTimeout(120000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  // Use fresh CONTEXT per test for true isolation (prevents cascade failures from WASM crashes)
  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close() // Terminates all pages + WebWorkers
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  async function loadTestData() {
    await inspector.runQuery('DROP TABLE IF EXISTS mixed_case')
    await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('mixed_case', 3)
  }

  /**
   * Get a specific row by id for deterministic results.
   */
  async function getRowById(tableName: string, id: number): Promise<Record<string, unknown>> {
    const rows = await inspector.runQuery(`SELECT * FROM "${tableName}" WHERE id = ${id}`)
    return rows[0] || {}
  }

  test('should show correct count when multiple redo states exist', async () => {
    await loadTestData()

    // Apply 3 transformations sequentially
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Trim Whitespace', { column: 'name' })
    await laundromat.closePanel()

    // Wait for first transform to complete
    await expect.poll(async () => {
      const row = await getRowById('mixed_case', 1)
      const name = row.name as string
      return name.trim() === name
    }, { timeout: 10000 }).toBe(true)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()

    // Wait for second transform
    await expect.poll(async () => {
      const row = await getRowById('mixed_case', 1)
      const name = row.name as string
      return name === name.toUpperCase()
    }, { timeout: 10000 }).toBe(true)

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'name' })
    await laundromat.closePanel()

    // Wait for third transform
    await expect.poll(async () => {
      const row = await getRowById('mixed_case', 1)
      const name = row.name as string
      return name === name.toLowerCase()
    }, { timeout: 10000 }).toBe(true)

    // Undo twice to create 2 redo states
    await page.locator('body').click()
    await page.keyboard.press('Control+z')

    // Wait for first undo to complete (data should no longer be lowercase)
    await expect.poll(async () => {
      const row = await getRowById('mixed_case', 1)
      const name = row.name as string
      return name !== name.toLowerCase()
    }, { timeout: 10000 }).toBe(true)

    await page.keyboard.press('Control+z')

    // Wait for second undo to complete - verify position reflects 2 future states
    await expect.poll(async () => {
      const position = await inspector.getTimelinePosition()
      return position.total - position.current - 1
    }, { timeout: 10000 }).toBe(2)

    // Attempt new action (use clickApply to not wait for completion)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.selectTransformation('Trim Whitespace')
    await picker.selectColumn('name')
    await picker.clickApply()

    // Dialog should show "2 undone operations"
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByText('2 undone operations')).toBeVisible()

    // Cancel and cleanup
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await laundromat.closePanel()
  })
})
