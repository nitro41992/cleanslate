import { Page, Locator, expect } from '@playwright/test'

export class StandardizeViewPage {
  readonly page: Page
  readonly container: Locator
  readonly backButton: Locator
  readonly closeButton: Locator
  readonly analyzeButton: Locator
  readonly applyButton: Locator
  readonly newAnalysisButton: Locator

  constructor(page: Page) {
    this.page = page
    this.container = page.getByTestId('standardize-view')
    this.backButton = page.getByRole('button', { name: /Back to Tables/i })
    this.closeButton = page.locator('[data-testid="standardize-view"] header button').last()
    this.analyzeButton = page.getByTestId('standardize-analyze-btn')
    this.applyButton = page.getByRole('button', { name: /Apply Standardization/i })
    this.newAnalysisButton = page.getByRole('button', { name: /New Analysis/i })
  }

  /**
   * Wait for the standardize view to open
   */
  async waitForOpen(): Promise<void> {
    await expect(this.container).toBeVisible({ timeout: 10000 })
    await expect(this.page.getByText('VALUE STANDARDIZER')).toBeVisible()
  }

  /**
   * Close the standardize view
   */
  async close(): Promise<void> {
    await this.backButton.click()
    await expect(this.container).not.toBeVisible({ timeout: 5000 })
  }

  /**
   * Select a table to standardize
   */
  async selectTable(tableName: string): Promise<void> {
    const tableSelect = this.page.getByTestId('standardize-table-select')
    await tableSelect.click()
    await this.page.getByRole('option', { name: new RegExp(tableName) }).click()
  }

  /**
   * Select a column to standardize
   */
  async selectColumn(columnName: string): Promise<void> {
    const columnSelect = this.page.getByTestId('standardize-column-select')
    await columnSelect.click()
    await this.page.getByRole('option', { name: columnName }).click()
  }

  /**
   * Select a clustering algorithm
   */
  async selectAlgorithm(algorithm: 'fingerprint' | 'metaphone'): Promise<void> {
    const algorithmSelect = this.page.getByTestId('standardize-algorithm-select')
    await algorithmSelect.click()
    const optionName = algorithm === 'fingerprint' ? /Fingerprint/i : /Metaphone/i
    await this.page.getByRole('option', { name: optionName }).click()
  }

  /**
   * Click the Analyze Values button
   */
  async analyze(): Promise<void> {
    await expect(this.analyzeButton).toBeEnabled()
    await this.analyzeButton.click()
    // Wait for analysis to start by checking button state or loading indicator
    await Promise.race([
      this.page.waitForFunction(
        () => {
          const btn = document.querySelector('[data-testid="standardize-analyze-btn"]')
          return !btn || btn.textContent?.includes('Analyzing')
        },
        { timeout: 5000 }
      ),
      this.page.locator('[data-testid="standardize-view"]').locator('text=/Analyzing/').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    ])
  }

  /**
   * Wait for clusters to appear
   */
  async waitForClusters(): Promise<void> {
    // Wait for at least one cluster card to appear
    await expect(this.page.getByTestId('cluster-card').first()).toBeVisible({ timeout: 30000 })
  }

  /**
   * Get the number of clusters
   */
  async getClusterCount(): Promise<number> {
    const clusterCards = this.page.getByTestId('cluster-card')
    return await clusterCards.count()
  }

  /**
   * Get the stats from the header
   */
  async getStats(): Promise<{ totalClusters: number; actionable: number; selected: number }> {
    await expect(this.container).toBeVisible({ timeout: 5000 })
    const statsText = await this.page.locator('[data-testid="standardize-view"] header').textContent() || ''

    const clustersMatch = statsText.match(/(\d+) clusters/)
    const actionableMatch = statsText.match(/(\d+) actionable/)
    const selectedMatch = statsText.match(/(\d+) selected/)

    return {
      totalClusters: clustersMatch ? parseInt(clustersMatch[1], 10) : 0,
      actionable: actionableMatch ? parseInt(actionableMatch[1], 10) : 0,
      selected: selectedMatch ? parseInt(selectedMatch[1], 10) : 0,
    }
  }

  /**
   * Expand a cluster by index
   */
  async expandCluster(index: number): Promise<void> {
    const clusterCards = this.page.getByTestId('cluster-card')
    const cluster = clusterCards.nth(index)
    await cluster.locator('button').first().click()
  }

  /**
   * Set master value for a cluster (by value ID)
   */
  async setMaster(valueId: string): Promise<void> {
    await this.page.getByTestId(`set-master-${valueId}`).click()
  }

  /**
   * Filter clusters by type
   */
  async filterBy(filter: 'all' | 'actionable'): Promise<void> {
    await this.page.getByTestId(`filter-${filter}`).click()
  }

  /**
   * Search for values
   */
  async search(query: string): Promise<void> {
    await this.page.getByTestId('cluster-search').fill(query)
  }

  /**
   * Click Apply Standardization
   */
  async apply(): Promise<void> {
    await expect(this.applyButton).toBeVisible()
    await this.applyButton.click()
    // Wait for apply to complete and view to close
    await expect(this.container).not.toBeVisible({ timeout: 10000 })
  }

  /**
   * Check if Apply button is visible
   */
  async hasApplyButton(): Promise<boolean> {
    return await this.applyButton.isVisible()
  }

  /**
   * Click New Analysis to reset
   */
  async newAnalysis(): Promise<void> {
    await this.newAnalysisButton.click()
    await expect(this.analyzeButton).toBeVisible()
  }

  /**
   * Get validation error message if any
   */
  async getValidationError(): Promise<string | null> {
    const errorAlert = this.page.locator('[role="alert"]')
    if (await errorAlert.isVisible()) {
      return await errorAlert.textContent()
    }
    return null
  }
}
