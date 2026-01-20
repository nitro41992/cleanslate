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
    await this.fileInput.setInputFiles(filePath)
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
}
