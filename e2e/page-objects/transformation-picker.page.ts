import { Page, Locator } from '@playwright/test'

export class TransformationPickerPage {
  readonly page: Page
  readonly dialog: Locator
  readonly addToRecipeButton: Locator

  constructor(page: Page) {
    this.page = page
    this.dialog = page.locator('[role="dialog"]').filter({ hasText: 'Add Transformation' })
    this.addToRecipeButton = page.getByRole('button', { name: 'Add to Recipe' })
  }

  async waitForOpen(): Promise<void> {
    await this.dialog.waitFor({ state: 'visible', timeout: 10000 })
  }

  async waitForClose(): Promise<void> {
    await this.dialog.waitFor({ state: 'hidden', timeout: 10000 })
  }

  async selectTransformation(name: string): Promise<void> {
    // Find the button containing the transformation name in the scroll area
    const button = this.dialog.locator('button').filter({ hasText: new RegExp(name, 'i') })
    await button.click()
  }

  async selectColumn(columnName: string): Promise<void> {
    // Find the column select and click it
    const columnSelect = this.page.locator('[role="combobox"]').filter({ hasText: /Select column|Column/ })
    await columnSelect.click()
    await this.page.getByRole('option', { name: columnName }).click()
  }

  async fillParam(paramName: string, value: string): Promise<void> {
    await this.page.locator(`input[placeholder*="${paramName}" i]`).fill(value)
  }

  async selectParam(paramLabel: string, optionLabel: string): Promise<void> {
    // Find the label and then the adjacent combobox
    const labelElement = this.dialog.locator('label').filter({ hasText: paramLabel })
    const selectTrigger = labelElement.locator('..').locator('[role="combobox"]')
    await selectTrigger.click()
    await this.page.getByRole('option', { name: optionLabel }).click()
  }

  async addToRecipe(): Promise<void> {
    await this.addToRecipeButton.click()
    await this.waitForClose()
  }

  /**
   * Add a transformation with optional column, params, and select params
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

    await this.addToRecipe()
  }
}
