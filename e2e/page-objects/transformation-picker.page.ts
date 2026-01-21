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
   */
  async selectTransformation(name: string): Promise<void> {
    const button = this.page.locator('button').filter({ hasText: new RegExp(`^${name}$|^.*${name}.*$`, 'i') }).first()
    await button.click()
  }

  /**
   * Select a column from the "Target Column" dropdown
   */
  async selectColumn(columnName: string): Promise<void> {
    const columnSelect = this.page.locator('[role="combobox"]').filter({ hasText: /Select column/ })
    await columnSelect.click()
    await this.page.getByRole('option', { name: columnName }).click()
  }

  /**
   * Fill a text input parameter
   */
  async fillParam(paramName: string, value: string): Promise<void> {
    await this.page.locator(`input[placeholder*="${paramName}" i]`).fill(value)
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
