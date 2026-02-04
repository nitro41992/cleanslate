/**
 * E2E Tests for Recipe Functionality
 *
 * Tests the full recipe workflow including:
 * - Creating recipes from audit sidebar
 * - Exporting/importing recipes as JSON
 * - Applying recipes with column mapping
 * - Secret handling for hash operations
 * - Step management (enable/disable, reorder, remove)
 * - Persistence across page reloads
 *
 * Isolation Strategy: Tier 2 with fresh browser context per test
 * (recipes persist to OPFS)
 */

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'
import { downloadRecipeJSON } from '../helpers/download-helpers'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const JSON_FIXTURES_PATH = path.resolve(__dirname, '../fixtures/json')

/**
 * Get path to JSON fixture file
 */
function getJSONFixturePath(filename: string): string {
  return path.join(JSON_FIXTURES_PATH, filename)
}

test.describe('Recipe Functionality', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.setTimeout(90000)

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    inspector = createStoreInspector(page)
    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed from crash
    }
  })

  // ==================== GROUP A: Recipe Creation ====================

  test.describe('A: Recipe Creation', () => {
    test('A1: should create recipe from single transform via audit sidebar', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Apply a transform
      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })

      // Open audit sidebar
      await laundromat.openAuditSidebar()

      // Click "Export as Recipe" button
      await page.getByTestId('export-as-recipe-btn').click()

      // Fill in recipe name
      await page.getByLabel('Recipe Name').fill('Single Transform Recipe')

      // Click Create Recipe
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Wait for dialog to close
      await expect(page.getByRole('dialog')).toBeHidden()

      // Verify recipe was created via store inspection
      const recipeState = await inspector.getRecipeState()
      expect(recipeState.recipes).toHaveLength(1)
      expect(recipeState.recipes[0].name).toBe('Single Transform Recipe')
      expect(recipeState.recipes[0].steps).toHaveLength(1)
      expect(recipeState.recipes[0].steps[0].type).toBe('transform:uppercase')
      expect(recipeState.recipes[0].requiredColumns).toContain('name')
    })

    test('A2: should create recipe from multiple transforms', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Apply multiple transforms (must close/reopen panel between transforms)
      // Use Uppercase on all columns since it will always affect rows (data starts as mixed case)
      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'email' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'city' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      // Open audit sidebar and export
      await laundromat.openAuditSidebar()
      await page.getByTestId('export-as-recipe-btn').click()
      await page.getByLabel('Recipe Name').fill('Multi Transform Recipe')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Verify recipe has all 3 steps in correct order
      const recipeState = await inspector.getRecipeState()
      expect(recipeState.recipes).toHaveLength(1)
      expect(recipeState.recipes[0].steps).toHaveLength(3)
      expect(recipeState.recipes[0].steps[0].type).toBe('transform:uppercase')
      expect(recipeState.recipes[0].steps[1].type).toBe('transform:uppercase')
      expect(recipeState.recipes[0].steps[2].type).toBe('transform:uppercase')

      // Verify all required columns captured
      expect(recipeState.recipes[0].requiredColumns).toContain('name')
      expect(recipeState.recipes[0].requiredColumns).toContain('email')
      expect(recipeState.recipes[0].requiredColumns).toContain('city')
    })

    test('A3: should exclude non-compatible commands from recipe', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Apply a transform
      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })

      // Make a manual cell edit (edit:cell is NOT recipe-compatible)
      await laundromat.closePanel()
      await inspector.waitForGridReady()
      await laundromat.editCell(0, 1, 'Manually Edited')
      await inspector.flushEditBatch()
      await inspector.waitForEditBatchFlush()

      // Open audit sidebar - should only show 1 recipe-compatible transform
      await laundromat.openAuditSidebar()

      // The button tooltip should show count
      const exportBtn = page.getByTestId('export-as-recipe-btn')
      await exportBtn.click()

      // Create the recipe
      await page.getByLabel('Recipe Name').fill('Transform Only Recipe')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Verify only the transform was included, not the cell edit
      const recipeState = await inspector.getRecipeState()
      expect(recipeState.recipes).toHaveLength(1)
      expect(recipeState.recipes[0].steps).toHaveLength(1)
      expect(recipeState.recipes[0].steps[0].type).toBe('transform:uppercase')
    })
  })

  // ==================== GROUP B: Recipe Export/Import ====================

  test.describe('B: Recipe Export/Import', () => {
    test('B1: should export recipe to JSON file with correct structure', async () => {
      // Upload and create a recipe first
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openAuditSidebar()
      await page.getByTestId('export-as-recipe-btn').click()
      await page.getByLabel('Recipe Name').fill('Export Test Recipe')
      await page.getByLabel('Description').fill('Testing export functionality')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Close audit sidebar and open recipe panel via toolbar
      await laundromat.closeAuditSidebar()
      await page.getByTestId('toolbar-recipe').click()

      // Wait for recipe panel to be ready with the recipe selected
      // The export button in the recipe panel is labeled just "Export" (has text "Export")
      // Use exact: true to avoid matching the recipe list item that contains "Export" in its name
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true })).toBeVisible({ timeout: 10000 })

      // Click export button and capture download
      const result = await downloadRecipeJSON(page, async () => {
        await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click()
      })

      // Verify JSON structure
      expect(result.filename).toContain('Export_Test_Recipe')
      expect(result.filename.endsWith('.json')).toBe(true)

      const content = result.content as Record<string, unknown>
      expect(content.name).toBe('Export Test Recipe')
      expect(content.description).toBe('Testing export functionality')
      expect(content.version).toBe('1.0')
      expect(content.requiredColumns).toContain('name')
      expect(Array.isArray(content.steps)).toBe(true)
      expect((content.steps as Array<Record<string, unknown>>)[0].type).toBe('transform:uppercase')
    })

    test('B2: should import valid recipe JSON', async () => {
      // Upload test data (needed for recipe panel)
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()

      // Wait for recipe panel to be visible
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Use page.setInputFiles with file chooser
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])

      await fileChooser.setFiles(getJSONFixturePath('valid-recipe.json'))

      // Wait for import toast and verify recipe added
      await expect(page.getByText('Recipe "Test Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Verify via store
      const recipeState = await inspector.getRecipeState()
      const importedRecipe = recipeState.recipes.find((r) => r.name === 'Test Recipe')
      expect(importedRecipe).toBeDefined()
      expect(importedRecipe!.steps).toHaveLength(2)
      expect(importedRecipe!.requiredColumns).toContain('name')
      expect(importedRecipe!.requiredColumns).toContain('email')
    })

    test('B3: should reject invalid recipe JSON', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()

      // Wait for recipe panel to be visible
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Try to import invalid recipe
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])

      await fileChooser.setFiles(getJSONFixturePath('invalid-recipe.json'))

      // Should show error toast
      await expect(page.getByText('Failed to import recipe')).toBeVisible({ timeout: 5000 })

      // No new recipe should be added (if there were recipes before, count should remain same)
      const recipeState = await inspector.getRecipeState()
      const invalidRecipe = recipeState.recipes.find((r) => r.description === 'Missing name and steps - this should fail validation')
      expect(invalidRecipe).toBeUndefined()
    })
  })

  // ==================== GROUP C: Recipe Application ====================

  test.describe('C: Recipe Application', () => {
    test('C1: should apply recipe with exact column match', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Verify initial data - email should be lowercase
      const initialRows = await inspector.runQuery<{ email: string }>('SELECT email FROM basic_data ORDER BY "_cs_id" LIMIT 1')
      expect(initialRows[0].email).toBe('john@example.com')

      // Import a valid recipe with matching columns
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('valid-recipe.json'))
      await expect(page.getByText('Recipe "Test Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Recipe should auto-select after import, click on it to ensure it's selected
      const recipeDialog = page.getByRole('dialog').filter({ hasText: 'Recipe' })
      await recipeDialog.getByRole('button', { name: /Test Recipe.*steps/ }).click()

      // Wait for Apply button to be visible after recipe selection
      const applyBtn = recipeDialog.getByRole('button', { name: 'Apply to Table' })
      await expect(applyBtn).toBeVisible({ timeout: 5000 })

      // Apply the recipe using the "Apply to Table" button
      await applyBtn.click()

      // Wait for data to actually be transformed by polling SQL
      // The recipe has uppercase on email, so poll until email becomes uppercase
      await expect.poll(async () => {
        const rows = await inspector.runQuery<{ email: string }>('SELECT email FROM basic_data ORDER BY "_cs_id" LIMIT 1')
        return rows[0].email
      }, { timeout: 30000, message: 'Email should be uppercased by recipe' }).toBe('JOHN@EXAMPLE.COM')

      // Verify all emails are uppercase
      const rows = await inspector.runQuery<{ email: string }>('SELECT email FROM basic_data ORDER BY "_cs_id"')
      expect(rows[0].email).toBe('JOHN@EXAMPLE.COM')
      expect(rows[1].email).toBe('JANE@EXAMPLE.COM')
      expect(rows[2].email).toBe('BOB@EXAMPLE.COM')
    })

    test('C2: should apply recipe with case-insensitive column match', async () => {
      // Upload test data with mixed-case columns
      // mixed-case.csv has columns: id, name, status (3 rows)
      await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('mixed_case', 3)

      // Get initial value for comparison (column is lowercase 'name')
      const initialRows = await inspector.runQuery<{ name: string }>('SELECT name FROM mixed_case ORDER BY "_cs_id" LIMIT 1')
      const originalName = initialRows[0].name

      // Create a recipe via transforms
      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openAuditSidebar()
      await page.getByTestId('export-as-recipe-btn').click()
      await page.getByLabel('Recipe Name').fill('Case Test Recipe')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Wait for dialog to close
      await expect(page.getByRole('dialog')).toBeHidden()

      // Undo the transform to reset data
      await laundromat.closeAuditSidebar()
      await laundromat.undo()

      // Wait for undo to complete by polling SQL for original value
      await expect.poll(async () => {
        const rows = await inspector.runQuery<{ name: string }>('SELECT name FROM mixed_case ORDER BY "_cs_id" LIMIT 1')
        return rows[0].name
      }, { timeout: 15000, message: 'Name should be reverted after undo' }).toBe(originalName)

      // Apply the recipe - should match "name" column
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Select and apply the recipe using "Apply to Table" button
      await page.getByRole('button', { name: /Case Test Recipe/ }).click()
      await page.getByRole('button', { name: 'Apply to Table' }).click()

      // Wait for data to be transformed by polling SQL
      await expect.poll(async () => {
        const rows = await inspector.runQuery<{ name: string }>('SELECT name FROM mixed_case ORDER BY "_cs_id" LIMIT 1')
        return rows[0].name
      }, { timeout: 30000, message: 'Name should be uppercased by recipe' }).toBe(originalName.toUpperCase())
    })

    test('C3: should show column mapping dialog for non-matching columns', async () => {
      // Upload a file with different column names
      // mixed-case.csv has: id, name, status (no email column)
      // valid-recipe.json requires: name, email
      // So "email" column will need mapping
      await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('mixed_case', 3)

      // Import recipe that expects "name" and "email" columns
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('valid-recipe.json'))
      await expect(page.getByText('Recipe "Test Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Select and try to apply - should show mapping dialog because "email" column doesn't exist
      await page.getByRole('button', { name: /Test Recipe/ }).click()
      await page.getByRole('button', { name: 'Apply to Table' }).click()

      // Mapping dialog should appear
      await expect(page.getByRole('dialog').filter({ hasText: 'Column Mapping' })).toBeVisible({ timeout: 5000 })

      // Should show unmapped badge for the missing email column
      await expect(page.getByText('unmapped')).toBeVisible()
    })
  })

  // ==================== GROUP D: Secret Handling ====================

  test.describe('D: Secret Handling', () => {
    test('D1: should prompt for secret when applying recipe with hash operation', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Import recipe with hash step
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('recipe-with-hash.json'))
      await expect(page.getByText('Recipe "Hash Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Recipe is auto-selected after import, just click Apply to Table
      await page.getByRole('button', { name: 'Apply to Table' }).click()

      // Secret dialog should appear
      await expect(page.getByRole('dialog').filter({ hasText: 'Secret Required' })).toBeVisible({ timeout: 5000 })

      // Enter a valid secret and apply
      await page.getByLabel('Hash Secret').fill('testsecret123')
      await page.getByRole('dialog').getByRole('button', { name: 'Apply Recipe' }).click()

      // Wait for data to be hashed by polling SQL
      await expect.poll(async () => {
        const rows = await inspector.runQuery<{ email: string }>('SELECT email FROM basic_data ORDER BY "_cs_id" LIMIT 1')
        return rows[0].email
      }, { timeout: 30000, message: 'Email should be hashed' }).not.toBe('john@example.com')
    })

    test('D2: should disable apply button for short secrets', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Import recipe with hash step
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('recipe-with-hash.json'))
      await expect(page.getByText('Recipe "Hash Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Recipe is auto-selected after import, just click Apply to Table
      await page.getByRole('button', { name: 'Apply to Table' }).click()

      // Secret dialog should appear
      await expect(page.getByRole('dialog').filter({ hasText: 'Secret Required' })).toBeVisible({ timeout: 5000 })

      // Enter short secret (less than 5 chars)
      await page.getByLabel('Hash Secret').fill('abc')

      // Apply button should be disabled
      const applyBtn = page.getByRole('dialog').getByRole('button', { name: 'Apply Recipe' })
      await expect(applyBtn).toBeDisabled()

      // Enter valid length secret
      await page.getByLabel('Hash Secret').fill('abcdef')
      await expect(applyBtn).toBeEnabled()
    })
  })

  // ==================== GROUP E: Step Management ====================

  test.describe('E: Step Management', () => {
    test('E1: should toggle step enabled/disabled', async () => {
      // Upload and create a multi-step recipe
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'email' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openAuditSidebar()
      await page.getByTestId('export-as-recipe-btn').click()
      await page.getByLabel('Recipe Name').fill('Toggle Test Recipe')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Open recipe panel
      await laundromat.closeAuditSidebar()
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Find the toggle button for the first step (uses aria-label="Disable step" when enabled)
      const toggleBtn = page.getByRole('button', { name: 'Disable step' }).first()
      await expect(toggleBtn).toBeVisible({ timeout: 5000 })

      // Verify initially enabled via aria-pressed attribute
      await expect(toggleBtn).toHaveAttribute('aria-pressed', 'true')

      // Toggle off
      await toggleBtn.click()

      // After toggle, the button label changes to "Enable step"
      const toggleBtnAfter = page.getByRole('button', { name: 'Enable step' }).first()
      await expect(toggleBtnAfter).toHaveAttribute('aria-pressed', 'false')

      // Verify in store
      const recipeState = await inspector.getRecipeState()
      const recipe = recipeState.recipes.find((r) => r.name === 'Toggle Test Recipe')
      expect(recipe!.steps[0].enabled).toBe(false)
      expect(recipe!.steps[1].enabled).toBe(true)
    })

    test('E2: should reorder steps up/down', async () => {
      // Upload and create a multi-step recipe
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'email' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openAuditSidebar()
      await page.getByTestId('export-as-recipe-btn').click()
      await page.getByLabel('Recipe Name').fill('Reorder Test Recipe')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Open recipe panel
      await laundromat.closeAuditSidebar()
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Get initial order - capture the column for each step
      let recipeState = await inspector.getRecipeState()
      let recipe = recipeState.recipes.find((r) => r.name === 'Reorder Test Recipe')
      const originalFirstColumn = recipe!.steps[0].column
      const originalSecondColumn = recipe!.steps[1].column

      // Click "Move step down" on the first step (will swap positions)
      // Use the aria-label we added to the button
      const moveDownBtn = page.getByRole('button', { name: 'Move step down' }).first()
      await moveDownBtn.click()

      // Verify order changed by checking columns
      recipeState = await inspector.getRecipeState()
      recipe = recipeState.recipes.find((r) => r.name === 'Reorder Test Recipe')
      expect(recipe!.steps[0].column).toBe(originalSecondColumn)
      expect(recipe!.steps[1].column).toBe(originalFirstColumn)
    })

    test('E3: should remove step from recipe', async () => {
      // Upload and create a multi-step recipe
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'name' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openCleanPanel()
      await picker.waitForOpen()
      await picker.addTransformation('Uppercase', { column: 'email' })
      await inspector.waitForTransformComplete()
      await laundromat.closePanel()

      await laundromat.openAuditSidebar()
      await page.getByTestId('export-as-recipe-btn').click()
      await page.getByLabel('Recipe Name').fill('Remove Step Recipe')
      await page.getByRole('button', { name: 'Create Recipe' }).click()

      // Open recipe panel
      await laundromat.closeAuditSidebar()
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Verify initial step count
      let recipeState = await inspector.getRecipeState()
      let recipe = recipeState.recipes.find((r) => r.name === 'Remove Step Recipe')
      expect(recipe!.steps).toHaveLength(2)

      // Click "Delete step" on first step (using aria-label)
      const deleteBtn = page.getByRole('button', { name: 'Delete step' }).first()
      await deleteBtn.click()

      // Verify step removed - poll to ensure store update
      await expect.poll(async () => {
        const state = await inspector.getRecipeState()
        const r = state.recipes.find((r) => r.name === 'Remove Step Recipe')
        return r?.steps.length
      }, { timeout: 5000 }).toBe(1)

      recipeState = await inspector.getRecipeState()
      recipe = recipeState.recipes.find((r) => r.name === 'Remove Step Recipe')
      expect(recipe!.steps[0].type).toBe('transform:uppercase')
    })
  })

  // ==================== GROUP F: Error Handling ====================

  test.describe('F: Error Handling', () => {
    test('F1: should show error when applying recipe with unmapped required columns', async () => {
      // Upload a file with columns that don't match recipe requirements
      // mixed-case.csv has: id, name, status (no email column)
      // valid-recipe.json requires: name, email
      await laundromat.uploadFile(getFixturePath('mixed-case.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('mixed_case', 3)

      // Import recipe that expects columns that don't all exist
      // Open recipe panel via toolbar
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('valid-recipe.json'))
      await expect(page.getByText('Recipe "Test Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Recipe is auto-selected after import, just click Apply to Table
      await page.getByRole('button', { name: 'Apply to Table' }).click()

      // Mapping dialog should appear showing unmapped columns (email doesn't exist)
      await expect(page.getByRole('dialog').filter({ hasText: 'Column Mapping' })).toBeVisible({ timeout: 5000 })

      // Try to click Apply without mapping - should show error
      await page.getByRole('dialog').getByRole('button', { name: 'Apply Recipe' }).click()

      // Error message about unmapped columns
      await expect(page.getByText(/Please map all columns/)).toBeVisible({ timeout: 5000 })
    })
  })

  // ==================== GROUP G: Persistence ====================

  test.describe('G: Persistence', () => {
    test('G1: should persist recipes across page reload', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Import a recipe (faster than creating via transforms)
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('valid-recipe.json'))
      await expect(page.getByText('Recipe "Test Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Verify recipe exists before save
      let recipeState = await inspector.getRecipeState()
      expect(recipeState.recipes).toHaveLength(1)

      // Save app state explicitly
      await inspector.saveAppState()

      // Reload page
      await page.reload()
      await inspector.waitForDuckDBReady()

      // Verify recipe still exists after reload by polling
      await expect.poll(async () => {
        const state = await inspector.getRecipeState()
        return state.recipes.length
      }, { timeout: 15000, message: 'Recipe should persist after reload' }).toBe(1)

      recipeState = await inspector.getRecipeState()
      const persistedRecipe = recipeState.recipes.find((r) => r.name === 'Test Recipe')
      expect(persistedRecipe).toBeDefined()
      expect(persistedRecipe!.steps).toHaveLength(2)
    })

    test('G2: should persist multiple recipes across reload', async () => {
      // Upload test data
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Import two recipes from fixtures
      await page.getByTestId('toolbar-recipe').click()
      await expect(page.getByRole('button', { name: 'Import recipe' })).toBeVisible({ timeout: 5000 })

      // Import first recipe
      let [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('valid-recipe.json'))
      await expect(page.getByText('Recipe "Test Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Import second recipe (hash recipe)
      ;[fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import recipe' }).click(),
      ])
      await fileChooser.setFiles(getJSONFixturePath('recipe-with-hash.json'))
      await expect(page.getByText('Recipe "Hash Recipe" imported')).toBeVisible({ timeout: 5000 })

      // Verify both recipes exist before save
      let recipeState = await inspector.getRecipeState()
      expect(recipeState.recipes).toHaveLength(2)

      // Save app state explicitly
      await inspector.saveAppState()

      // Reload page
      await page.reload()
      await inspector.waitForDuckDBReady()

      // Verify both recipes persisted after reload by polling
      await expect.poll(async () => {
        const state = await inspector.getRecipeState()
        return state.recipes.length
      }, { timeout: 15000, message: 'Both recipes should persist after reload' }).toBe(2)

      recipeState = await inspector.getRecipeState()
      expect(recipeState.recipes.map((r) => r.name)).toContain('Test Recipe')
      expect(recipeState.recipes.map((r) => r.name)).toContain('Hash Recipe')
    })
  })
})
