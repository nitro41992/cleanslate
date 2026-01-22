import { Page, Locator } from '@playwright/test'

export class IngestionWizardPage {
  readonly page: Page
  readonly dialog: Locator
  readonly headerRowSelect: Locator
  readonly encodingSelect: Locator
  readonly delimiterSelect: Locator
  readonly importButton: Locator
  readonly cancelButton: Locator

  constructor(page: Page) {
    this.page = page
    this.dialog = page.getByTestId('ingestion-wizard')
    this.headerRowSelect = page.locator('#header-row')
    this.encodingSelect = page.locator('#encoding')
    this.delimiterSelect = page.locator('#delimiter')
    this.importButton = page.getByTestId('import-btn')
    this.cancelButton = page.getByTestId('cancel-btn')
  }

  async waitForOpen(): Promise<void> {
    await this.dialog.waitFor({ state: 'visible', timeout: 10000 })
    // Also wait for the Import button to be enabled (indicates file is loaded)
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="import-btn"]') as HTMLButtonElement
        return btn && !btn.disabled
      },
      { timeout: 15000 }
    )
  }

  async waitForClose(): Promise<void> {
    await this.dialog.waitFor({ state: 'hidden', timeout: 15000 })
  }

  /**
   * Select header row (1-indexed, matching UI display).
   * Row 1 = first row of file, Row 5 = fifth row.
   * This matches Excel/human-style row numbering shown in the UI.
   * @param row - 1-indexed row number (1-10)
   * @throws Error if row is outside valid range
   */
  async selectHeaderRow(row: number): Promise<void> {
    if (row < 1 || row > 10) {
      throw new Error(`Header row must be between 1 and 10, got: ${row}`)
    }
    await this.headerRowSelect.click()
    // Use exact match to avoid "Row 1" matching "Row 10"
    await this.page.getByRole('option', { name: `Row ${row}`, exact: true }).click()
  }

  async selectEncoding(encoding: 'utf-8' | 'latin-1'): Promise<void> {
    await this.encodingSelect.click()
    const encodingLabel = encoding === 'utf-8' ? 'UTF-8' : 'Latin-1'
    await this.page.locator(`[role="option"]`).filter({ hasText: encodingLabel }).click()
  }

  async selectDelimiter(delimiter: ',' | '\t' | '|' | ';'): Promise<void> {
    await this.delimiterSelect.click()
    const delimiterLabel = {
      ',': 'Comma',
      '\t': 'Tab',
      '|': 'Pipe',
      ';': 'Semicolon',
    }[delimiter]
    await this.page.locator(`[role="option"]`).filter({ hasText: delimiterLabel }).click()
  }

  async getDetectedColumnCount(): Promise<number> {
    const text = await this.page.locator('text=/Detected \\d+ columns/').textContent()
    const match = text?.match(/Detected (\d+) columns/)
    return match ? parseInt(match[1], 10) : 0
  }

  async import(): Promise<void> {
    await this.importButton.click()
    await this.waitForClose()
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click()
    await this.waitForClose()
  }

  async getRawPreviewText(): Promise<string> {
    const preview = this.page.getByTestId('raw-preview')
    return (await preview.textContent()) ?? ''
  }
}
