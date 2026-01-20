import { Page, Locator } from '@playwright/test'

export class LaundromatPage {
  readonly page: Page
  readonly dropzone: Locator
  readonly fileInput: Locator
  readonly exportButton: Locator
  readonly undoButton: Locator
  readonly redoButton: Locator
  readonly addTransformationButton: Locator
  readonly runRecipeButton: Locator
  readonly gridContainer: Locator
  readonly dataPreviewTab: Locator
  readonly auditLogTab: Locator

  constructor(page: Page) {
    this.page = page
    this.dropzone = page.getByTestId('file-dropzone')
    this.fileInput = page.getByTestId('file-input')
    this.exportButton = page.getByTestId('export-csv-btn')
    this.undoButton = page.locator('button[title*="Undo"]')
    this.redoButton = page.locator('button[title*="Redo"]')
    this.addTransformationButton = page.getByTestId('add-transformation-btn')
    this.runRecipeButton = page.getByTestId('run-recipe-btn')
    this.gridContainer = page.getByTestId('data-grid')
    this.dataPreviewTab = page.getByRole('tab', { name: 'Data Preview' })
    this.auditLogTab = page.getByRole('tab', { name: 'Audit Log' })
  }

  async goto(): Promise<void> {
    await this.page.goto('/laundromat')
  }

  async uploadFile(filePath: string): Promise<void> {
    // Use first() to handle both initial upload (FileDropzone) and subsequent uploads (hidden input)
    await this.fileInput.first().setInputFiles(filePath)
  }

  async getRowCount(): Promise<string | null> {
    const rowCountText = this.page.locator('text=/\\d+,?\\d* rows/')
    const text = await rowCountText.textContent()
    return text
  }

  async clickExport(): Promise<void> {
    await this.exportButton.click()
  }

  async clickAddTransformation(): Promise<void> {
    await this.addTransformationButton.click()
  }

  async clickRunRecipe(): Promise<void> {
    await this.runRecipeButton.click()
    // Wait for the run button to no longer be showing "Running..."
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="run-recipe-btn"]')
        return btn === null || !btn.textContent?.includes('Running')
      },
      { timeout: 30000 }
    )
  }

  async clickUndo(): Promise<void> {
    await this.undoButton.click()
  }

  async clickRedo(): Promise<void> {
    await this.redoButton.click()
  }

  async switchToAuditLogTab(): Promise<void> {
    await this.auditLogTab.click()
  }

  async switchToDataPreviewTab(): Promise<void> {
    await this.dataPreviewTab.click()
  }

  /**
   * Edit a cell in the data grid.
   * Glide Data Grid is canvas-based - uses keyboard navigation for reliability.
   * @param row - 0-indexed row number
   * @param col - 0-indexed column number
   * @param newValue - The new value to enter
   */
  async editCell(row: number, col: number, newValue: string): Promise<void> {
    // Wait for grid to be fully rendered
    await this.gridContainer.waitFor({ state: 'visible' })
    await this.page.waitForTimeout(200)

    // Click the grid to focus it
    await this.gridContainer.click()
    await this.page.waitForTimeout(100)

    // Navigate to home position (first cell)
    await this.page.keyboard.press('Control+Home')
    await this.page.waitForTimeout(100)

    // Navigate to target row
    for (let i = 0; i < row; i++) {
      await this.page.keyboard.press('ArrowDown')
      await this.page.waitForTimeout(20)
    }

    // Navigate to target column
    for (let i = 0; i < col; i++) {
      await this.page.keyboard.press('ArrowRight')
      await this.page.waitForTimeout(20)
    }
    await this.page.waitForTimeout(100)

    // Enter edit mode - Glide Data Grid uses F2 or just start typing
    await this.page.keyboard.press('F2')
    await this.page.waitForTimeout(150)

    // Select all and type new value
    await this.page.keyboard.press('Control+a')
    await this.page.keyboard.type(newValue, { delay: 10 })

    // Commit with Enter
    await this.page.keyboard.press('Enter')
    await this.page.waitForTimeout(200)
  }
}
