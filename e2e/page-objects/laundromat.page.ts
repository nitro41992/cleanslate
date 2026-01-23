import { Page, Locator } from '@playwright/test'

export class LaundromatPage {
  readonly page: Page
  readonly dropzone: Locator
  readonly fileInput: Locator
  readonly exportButton: Locator
  readonly undoButton: Locator
  readonly redoButton: Locator
  readonly gridContainer: Locator
  readonly dataPreviewTab: Locator
  readonly auditLogTab: Locator
  // Toolbar buttons for panels
  readonly cleanButton: Locator
  readonly matchButton: Locator
  readonly combineButton: Locator
  readonly scrubButton: Locator
  readonly diffButton: Locator

  constructor(page: Page) {
    this.page = page
    this.dropzone = page.getByTestId('file-dropzone')
    this.fileInput = page.getByTestId('file-input')
    this.exportButton = page.getByTestId('export-csv-btn')
    this.undoButton = page.getByTestId('undo-btn')
    this.redoButton = page.getByTestId('redo-btn')
    this.gridContainer = page.getByTestId('data-grid')
    this.dataPreviewTab = page.getByRole('tab', { name: 'Data Preview' })
    this.auditLogTab = page.getByRole('tab', { name: 'Audit Log' })
    // Toolbar panel buttons
    this.cleanButton = page.getByTestId('toolbar-clean')
    this.matchButton = page.getByTestId('toolbar-match')
    this.combineButton = page.getByTestId('toolbar-combine')
    this.scrubButton = page.getByTestId('toolbar-scrub')
    this.diffButton = page.getByTestId('toolbar-diff')
  }

  async goto(): Promise<void> {
    await this.page.goto('/')
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

  /**
   * Dismiss any visible toast notifications or dialogs that might block UI interactions.
   */
  async dismissOverlays(): Promise<void> {
    // Wait a moment for overlays to appear
    await this.page.waitForTimeout(200)

    // Check if any dialog overlay is visible and close it
    const dialogOverlay = this.page.locator('[data-state="open"][aria-hidden="true"]')
    const toastRegion = this.page.locator('[role="region"][aria-label*="Notifications"]')

    // Press Escape multiple times to close any stacked dialogs/toasts
    for (let i = 0; i < 3; i++) {
      await this.page.keyboard.press('Escape')
      await this.page.waitForTimeout(100)
    }

    // Wait for overlay to be hidden if it exists
    try {
      await dialogOverlay.waitFor({ state: 'hidden', timeout: 1000 })
    } catch {
      // Ignore if no overlay found
    }

    // Wait for toast to be hidden if it exists
    try {
      await toastRegion.waitFor({ state: 'hidden', timeout: 500 })
    } catch {
      // Ignore if no toast region found
    }

    await this.page.waitForTimeout(100)
  }

  async clickUndo(): Promise<void> {
    await this.undoButton.click()
  }

  async clickRedo(): Promise<void> {
    await this.redoButton.click()
  }

  /**
   * Open the audit sidebar (replaces old tab-based approach)
   */
  async openAuditSidebar(): Promise<void> {
    const toggleBtn = this.page.getByTestId('toggle-audit-sidebar')
    // Wait for toggle button to be ready (in case UI is still settling)
    await toggleBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Check if sidebar is already open by looking for the audit log panel
    const sidebarOpen = await this.page.locator('text=Audit Log').first().isVisible().catch(() => false)
    if (!sidebarOpen) {
      // Force click to bypass any potential overlay issues
      await toggleBtn.click({ force: true })
      // Wait for sidebar to open
      await this.page.waitForTimeout(500)
    }
    await this.page.locator('.text-sm:has-text("Audit Log")').waitFor({ state: 'visible', timeout: 10000 })
  }

  /**
   * Close the audit sidebar
   */
  async closeAuditSidebar(): Promise<void> {
    const sidebarOpen = await this.page.locator('aside').filter({ hasText: 'Audit Log' }).isVisible().catch(() => false)
    if (sidebarOpen) {
      await this.page.getByTestId('toggle-audit-sidebar').click()
    }
  }

  /**
   * @deprecated Use openAuditSidebar() instead - tabs no longer exist in the UI
   */
  async switchToAuditLogTab(): Promise<void> {
    await this.openAuditSidebar()
  }

  /**
   * @deprecated Use closeAuditSidebar() instead - tabs no longer exist in the UI
   */
  async switchToDataPreviewTab(): Promise<void> {
    await this.closeAuditSidebar()
  }

  /**
   * Edit a cell in the data grid.
   * Glide Data Grid is canvas-based - uses keyboard navigation for reliability.
   * @param row - 0-indexed row number
   * @param col - 0-indexed column number
   * @param newValue - The new value to enter
   */
  async editCell(row: number, col: number, newValue: string): Promise<void> {
    // Dismiss any overlays first
    await this.dismissOverlays()

    // Wait for grid to be fully rendered
    await this.gridContainer.waitFor({ state: 'visible' })
    await this.page.waitForTimeout(300)

    // Click the grid to focus it
    await this.gridContainer.click()
    await this.page.waitForTimeout(150)

    // Navigate to home position (first cell)
    await this.page.keyboard.press('Control+Home')
    await this.page.waitForTimeout(150)

    // Navigate to target row
    for (let i = 0; i < row; i++) {
      await this.page.keyboard.press('ArrowDown')
      await this.page.waitForTimeout(30)
    }

    // Navigate to target column
    for (let i = 0; i < col; i++) {
      await this.page.keyboard.press('ArrowRight')
      await this.page.waitForTimeout(30)
    }
    await this.page.waitForTimeout(150)

    // Enter edit mode - Glide Data Grid uses F2 or just start typing
    await this.page.keyboard.press('F2')
    await this.page.waitForTimeout(200)

    // Select all and wait for selection to complete
    await this.page.keyboard.press('Control+a')
    await this.page.waitForTimeout(100)

    // Type new value with slight delay between characters
    await this.page.keyboard.type(newValue, { delay: 20 })
    await this.page.waitForTimeout(100)

    // Commit with Enter
    await this.page.keyboard.press('Enter')
    await this.page.waitForTimeout(300)
  }

  // Panel navigation methods for new single-page app architecture

  /**
   * Open the Clean panel for transformations
   */
  async openCleanPanel(): Promise<void> {
    await this.closePanel()
    await this.cleanButton.click()
    await this.page.getByTestId('panel-clean').waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * Open the Match view (full-screen overlay) for duplicate detection
   */
  async openMatchView(): Promise<void> {
    await this.closePanel()
    await this.matchButton.click()
    await this.page.getByTestId('match-view').waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * @deprecated Use openMatchView() instead - Match now uses full-screen overlay
   */
  async openMatchPanel(): Promise<void> {
    await this.openMatchView()
  }

  /**
   * Open the Combine panel for stack/join operations
   */
  async openCombinePanel(): Promise<void> {
    await this.closePanel()
    await this.combineButton.click()
    await this.page.getByTestId('panel-combine').waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * Open the Scrub panel for obfuscation
   */
  async openScrubPanel(): Promise<void> {
    await this.closePanel()
    await this.scrubButton.click()
    await this.page.getByTestId('panel-scrub').waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * Open the Diff view (full-screen overlay)
   */
  async openDiffView(): Promise<void> {
    await this.closePanel()
    await this.diffButton.click()
    // Wait for the DiffView overlay to appear
    await this.page.getByTestId('diff-view').waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * Close any open panel by pressing Escape
   */
  async closePanel(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await this.page.waitForTimeout(200)
  }
}