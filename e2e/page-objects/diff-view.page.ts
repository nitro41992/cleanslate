import { Page, Locator } from '@playwright/test'

/**
 * Page object for the DiffView full-screen overlay.
 * Handles table selection, key column configuration, running comparisons,
 * and interacting with diff results.
 */
export class DiffViewPage {
  readonly page: Page
  readonly overlay: Locator
  readonly backButton: Locator
  readonly closeButton: Locator
  readonly tableASelect: Locator
  readonly tableBSelect: Locator
  readonly compareButton: Locator
  readonly exportButton: Locator
  readonly blindModeSwitch: Locator
  readonly newComparisonButton: Locator
  readonly resultsTable: Locator
  readonly summaryPills: Locator
  // Dual comparison mode buttons
  readonly comparePreviewModeButton: Locator
  readonly compareTablesButton: Locator

  constructor(page: Page) {
    this.page = page
    this.overlay = page.getByTestId('diff-view')
    this.backButton = page.locator('button:has-text("Back to Tables")')
    this.closeButton = page.locator('[data-testid="diff-view"] button:has(svg[class*="lucide-x"])')
    this.tableASelect = page.getByTestId('diff-table-a-select')
    this.tableBSelect = page.getByTestId('diff-table-b-select')
    this.compareButton = page.getByTestId('diff-compare-btn')
    this.exportButton = page.getByTestId('diff-export-btn')
    this.blindModeSwitch = page.locator('#blind-mode')
    this.newComparisonButton = page.locator('button:has-text("New Comparison")')
    this.resultsTable = page.getByTestId('diff-results-table')
    this.summaryPills = page.locator('[data-testid^="diff-pill-"]')
    // Dual comparison mode buttons
    this.comparePreviewModeButton = page.locator('button').filter({ hasText: 'Compare with Preview' })
    this.compareTablesButton = page.locator('button').filter({ hasText: 'Compare Two Tables' })
  }

  /**
   * Wait for the DiffView overlay to open
   */
  async waitForOpen(): Promise<void> {
    await this.overlay.waitFor({ state: 'visible', timeout: 10000 })
  }

  /**
   * Wait for the DiffView overlay to close
   */
  async waitForClose(): Promise<void> {
    await this.overlay.waitFor({ state: 'hidden', timeout: 5000 })
  }

  /**
   * Close the DiffView overlay
   */
  async close(): Promise<void> {
    await this.closeButton.click()
    await this.waitForClose()
  }

  /**
   * Select Table A from the dropdown
   */
  async selectTableA(tableName: string): Promise<void> {
    await this.tableASelect.click()
    await this.page.getByRole('option', { name: new RegExp(tableName) }).click()
  }

  /**
   * Select Table B from the dropdown
   */
  async selectTableB(tableName: string): Promise<void> {
    await this.tableBSelect.click()
    await this.page.getByRole('option', { name: new RegExp(tableName) }).click()
  }

  /**
   * Toggle a key column for matching rows
   */
  async toggleKeyColumn(columnName: string): Promise<void> {
    const checkbox = this.page.locator(`label:has-text("${columnName}")`)
    await checkbox.click()
  }

  /**
   * Run the comparison
   */
  async runComparison(): Promise<void> {
    await this.compareButton.click()
    // Wait for comparison to complete
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="diff-compare-btn"]')
        return btn && !btn.textContent?.includes('Comparing')
      },
      { timeout: 30000 }
    )
    // Wait for results to appear
    await this.page.waitForTimeout(500)
  }

  /**
   * Get summary pill counts
   */
  async getSummary(): Promise<{
    added: number
    removed: number
    modified: number
    unchanged: number
  }> {
    const getPillValue = async (key: string): Promise<number> => {
      const pill = this.page.getByTestId(`diff-pill-${key}`)
      const text = await pill.locator('span').first().textContent()
      return parseInt(text?.replace(/,/g, '') || '0', 10)
    }

    return {
      added: await getPillValue('added'),
      removed: await getPillValue('removed'),
      modified: await getPillValue('modified'),
      unchanged: await getPillValue('unchanged'),
    }
  }

  /**
   * Get the number of result rows displayed
   */
  async getResultRowCount(): Promise<number> {
    const rows = this.resultsTable.locator('tbody tr')
    return await rows.count()
  }

  /**
   * Toggle blind mode
   */
  async toggleBlindMode(): Promise<void> {
    await this.blindModeSwitch.click()
  }

  /**
   * Click export and select format
   */
  async exportAs(format: 'csv' | 'json' | 'clipboard'): Promise<void> {
    await this.exportButton.click()

    const menuItem = {
      csv: 'Export as CSV',
      json: 'Export as JSON',
      clipboard: 'Copy to Clipboard',
    }[format]

    await this.page.getByRole('menuitem', { name: menuItem }).click()
  }

  /**
   * Start a new comparison (reset results)
   */
  async newComparison(): Promise<void> {
    await this.newComparisonButton.click()
  }

  /**
   * Full comparison flow helper
   */
  async compare(
    tableA: string,
    tableB: string,
    keyColumns: string[]
  ): Promise<void> {
    await this.selectTableA(tableA)
    await this.selectTableB(tableB)

    for (const col of keyColumns) {
      await this.toggleKeyColumn(col)
    }

    await this.runComparison()
  }

  /**
   * Select "Compare with Preview" mode (compares current table with its preview state)
   */
  async selectComparePreviewMode(): Promise<void> {
    await this.comparePreviewModeButton.click()
  }

  /**
   * Select "Compare Two Tables" mode (compares two different tables)
   */
  async selectCompareTablesMode(): Promise<void> {
    await this.compareTablesButton.click()
  }
}
