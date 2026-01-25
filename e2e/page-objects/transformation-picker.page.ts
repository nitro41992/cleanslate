import { Page, Locator } from '@playwright/test'

/**
 * Page object for the inline transformation picker in CleanPanel.
 * The new UI has transformation tiles displayed in a grid, with configuration
 * appearing inline below the selected tile.
 */
export class TransformationPickerPage {
  readonly page: Page
  readonly applyButton: Locator

  constructor(page: Page) {
    this.page = page
    this.applyButton = page.getByTestId('apply-transformation-btn')
  }

  /**
   * Wait for the CleanPanel to be visible and interactive
   */
  async waitForOpen(): Promise<void> {
    // Wait for the panel container to be visible
    await this.page.getByTestId('panel-clean').waitFor({ state: 'visible', timeout: 10000 })
    // Wait for transformation tiles to be visible
    await this.page.locator('button:has-text("Trim Whitespace")').waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * Select a transformation tile by its label
   * Skips category buttons (which have a count badge) and clicks the actual transformation button
   */
  async selectTransformation(name: string): Promise<void> {
    // First, ensure the category is expanded if needed
    // Category buttons have format "⬡ Category N" with a number at the end
    const categoryButton = this.page.locator('button').filter({
      hasText: new RegExp(`${name}\\s+"?\\d+"?$`, 'i')
    }).first()

    // Check if category exists and expand it
    const categoryExists = await categoryButton.count() > 0
    if (categoryExists) {
      const isExpanded = await categoryButton.getAttribute('data-state').then(state => state === 'open').catch(() => false)
      if (!isExpanded) {
        await categoryButton.click()
        // Wait for submenu to appear
        await this.page.waitForTimeout(300)
      }
    }

    // Now click the actual transformation button
    // Key difference: transformation buttons don't have a number badge at the end
    // Find all buttons with the name, then filter out category buttons (those with numbers at end)
    const allButtons = this.page.locator('button').filter({
      hasText: new RegExp(name, 'i')
    })

    // Get the button that doesn't end with a number (i.e., not a category button)
    const transformButton = allButtons.filter({
      hasNotText: /\d+$/  // Exclude buttons ending with digits
    }).first()

    await transformButton.waitFor({ state: 'visible', timeout: 5000 })
    await transformButton.click()
    // Wait for transformation form to render
    await this.page.waitForTimeout(300)
  }

  /**
   * Select a column from the "Target Column" dropdown
   */
  async selectColumn(columnName: string): Promise<void> {
    // Wait for column selector to be visible (renders after transformation selected)
    const columnSelect = this.page.getByTestId('column-selector')
    await columnSelect.waitFor({ state: 'visible', timeout: 10000 })
    await columnSelect.click()

    // Wait for dropdown to open and option to be available
    const option = this.page.getByRole('option', { name: columnName })
    await option.waitFor({ state: 'visible', timeout: 5000 })
    await option.click()
  }

  /**
   * Fill a text input parameter (supports both <input> and <textarea>)
   */
  async fillParam(paramName: string, value: string): Promise<void> {
    // Try placeholder-based selector first
    let input = this.page.locator(`input[placeholder*="${paramName}" i], textarea[placeholder*="${paramName}" i]`)

    // Check if found, otherwise fall back to generic textarea/input
    // (needed for Custom SQL which has a dynamic placeholder)
    const count = await input.count()
    if (count === 0) {
      // Fallback: look for any visible textarea or input in the transformation form
      input = this.page.locator('textarea:visible, input[type="text"]:visible').first()
    }

    // Wait for input to be visible before filling (prevents timeout in long test sequences)
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill(value)
  }

  /**
   * Select an option from a dropdown parameter
   */
  async selectParam(paramLabel: string, optionLabel: string): Promise<void> {
    // Find the label and then the adjacent combobox
    const labelElement = this.page.locator('label').filter({ hasText: paramLabel })
    const selectTrigger = labelElement.locator('..').locator('[role="combobox"]')
    await selectTrigger.click()
    await this.page.getByRole('option', { name: optionLabel }).click()
  }

  /**
   * Click the Apply Transformation button and wait for completion
   */
  async apply(): Promise<void> {
    await this.applyButton.click()
    // Wait for the button to return to normal state (not showing "Applying...")
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="apply-transformation-btn"]')
        return btn && !btn.textContent?.includes('Applying')
      },
      { timeout: 30000 }
    )
    // Wait for toast to appear indicating success
    await this.page.waitForTimeout(300)
  }

  /**
   * Add and apply a transformation with optional column, params, and select params.
   * This is the main convenience method for tests.
   */
  async addTransformation(
    type: string,
    options?: {
      column?: string
      params?: Record<string, string>
      selectParams?: Record<string, string>
    }
  ): Promise<void> {
    await this.selectTransformation(type)

    if (options?.column) {
      await this.selectColumn(options.column)
    }

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        await this.fillParam(key, value)
      }
    }

    if (options?.selectParams) {
      for (const [label, option] of Object.entries(options.selectParams)) {
        await this.selectParam(label, option)
      }
    }

    await this.apply()
  }
}
