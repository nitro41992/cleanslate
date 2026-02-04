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
    // Target the heading row count specifically to avoid ambiguity with filter bar
    const rowCountText = this.page.getByRole('heading').locator('text=/\\d+,?\\d* rows/')
    const text = await rowCountText.textContent()
    return text
  }

  async clickExport(): Promise<void> {
    await this.exportButton.click()
  }

  /**
   * Dismiss any visible toast notifications or dialogs that might block UI interactions.
   * Uses state-aware dismissal instead of fixed waits for CI reliability.
   */
  async dismissOverlays(): Promise<void> {
    // Dialog overlay selector (Radix UI pattern)
    const dialogOverlay = this.page.locator('[data-state="open"][aria-hidden="true"]')
    // Toast region selector
    const toastRegion = this.page.locator('[role="region"][aria-label*="Notifications"]')

    // State-aware dismissal: only press Escape if overlays are visible
    for (let attempt = 0; attempt < 3; attempt++) {
      const dialogVisible = await dialogOverlay.first().isVisible().catch(() => false)
      const toastVisible = await toastRegion.first().isVisible().catch(() => false)

      if (!dialogVisible && !toastVisible) {
        break // No overlays to dismiss
      }

      await this.page.keyboard.press('Escape')

      // Wait for overlay to be hidden (state-aware, not fixed timeout)
      if (dialogVisible) {
        await dialogOverlay.first().waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {})
      }
      if (toastVisible) {
        await toastRegion.first().waitFor({ state: 'hidden', timeout: 500 }).catch(() => {})
      }
    }
  }

  async clickUndo(): Promise<void> {
    await this.undoButton.click()
  }

  async clickRedo(): Promise<void> {
    await this.redoButton.click()
  }

  /**
   * Alias for clickUndo() - triggers undo and waits for undo button state to stabilize
   */
  async undo(): Promise<void> {
    await this.clickUndo()
  }

  /**
   * Alias for clickRedo() - triggers redo and waits for redo button state to stabilize
   */
  async redo(): Promise<void> {
    await this.clickRedo()
  }

  /**
   * Open the audit sidebar (replaces old tab-based approach)
   */
  async openAuditSidebar(): Promise<void> {
    await this.dismissOverlays()
    const toggleBtn = this.page.getByTestId('toggle-audit-sidebar')
    const sidebar = this.page.getByTestId('audit-sidebar')

    // Wait for toggle button to be ready (in case UI is still settling after applyMerges)
    await toggleBtn.waitFor({ state: 'visible', timeout: 10000 })

    // Check if sidebar is already open
    const sidebarOpen = await sidebar.isVisible().catch(() => false)
    if (sidebarOpen) {
      return
    }

    // Try clicking the toggle button with retries (state-aware waits)
    for (let attempt = 0; attempt < 3; attempt++) {
      await toggleBtn.click({ force: true })

      // Wait for sidebar to become visible (state-aware, not fixed timeout)
      try {
        await sidebar.waitFor({ state: 'visible', timeout: 1500 })
        break // Success
      } catch {
        // Sidebar didn't open, dismiss overlays and retry
        await this.page.keyboard.press('Escape')
        await this.dismissOverlays()
      }
    }

    await sidebar.waitFor({ state: 'visible', timeout: 15000 })
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
   * Alias for openAuditSidebar() for test compatibility
   */
  async openAuditLogPanel(): Promise<void> {
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
  /**
   * Edit a cell in the data grid.
   * Glide Data Grid is canvas-based - uses keyboard navigation for reliability.
   *
   * IMPORTANT: Canvas grids require minimal delays between keyboard events for canvas
   * repainting and event processing. These are NOT arbitrary waits - they're necessary
   * for the canvas rendering pipeline to complete before the next event is processed.
   *
   * @param row - 0-indexed row number
   * @param col - 0-indexed column number
   * @param newValue - The new value to enter
   */
  async editCell(row: number, col: number, newValue: string): Promise<void> {
    // Dismiss any overlays first
    await this.dismissOverlays()

    // Wait for grid to be fully rendered and data loaded (comprehensive check)
    await this.gridContainer.waitFor({ state: 'visible' })
    await this.page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (stores.tableStore as any).getState()
        // Ensure not loading AND has tables loaded
        return state?.isLoading === false && state?.tables?.length > 0
      },
      { timeout: 10000 }
    )

    // Detect platform for keyboard shortcuts
    const isMac = process.platform === 'darwin'

    // Ensure we're not in edit mode from a previous edit
    await this.page.keyboard.press('Escape')
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))

    // Click on a data cell (not header) to focus the grid
    // The header row is typically 36px, so click at y+60 to hit the first data row
    const gridBox = await this.gridContainer.boundingBox()
    if (gridBox) {
      // Click at position that lands on first data row (after header)
      await this.page.mouse.click(gridBox.x + 100, gridBox.y + 60)
    } else {
      await this.gridContainer.click()
    }
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    // Navigate to home position using platform-appropriate shortcuts
    // On Mac: Cmd+Up then Cmd+Left. On Windows/Linux: Ctrl+Home
    if (isMac) {
      // Go to first row
      await this.page.keyboard.press('Meta+ArrowUp')
      await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
      // Go to first column
      await this.page.keyboard.press('Meta+ArrowLeft')
      await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    } else {
      await this.page.keyboard.press('Control+Home')
      await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }

    // Navigate to target row (canvas needs time to repaint selection after each navigation)
    for (let i = 0; i < row; i++) {
      await this.page.keyboard.press('ArrowDown')
      // Wait for canvas repaint - one frame is usually enough for arrow key navigation
      await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    }

    // Navigate to target column (canvas needs time to repaint selection after each navigation)
    for (let i = 0; i < col; i++) {
      await this.page.keyboard.press('ArrowRight')
      // Wait for canvas repaint - one frame is usually enough for arrow key navigation
      await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    }

    // Wait for final canvas repaint after navigation completes
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    // Enter edit mode - Glide Data Grid uses F2 or just start typing
    await this.page.keyboard.press('F2')
    // Wait for edit overlay to render (canvas transitions to edit mode)
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    // Select all existing content using platform-appropriate shortcut
    if (isMac) {
      await this.page.keyboard.press('Meta+a')
    } else {
      await this.page.keyboard.press('Control+a')
    }
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))

    // Type new value with slight delay between characters
    await this.page.keyboard.type(newValue, { delay: 20 })
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))

    // Commit with Enter
    await this.page.keyboard.press('Enter')

    // Check if "Discard Undone Changes?" dialog appears (when editing after undo)
    // This dialog uses Radix AlertDialog which has role="alertdialog"
    const dialog = this.page.getByRole('alertdialog')
    const dialogVisible = await dialog.isVisible().catch(() => false)

    if (dialogVisible) {
      // Click "Discard & Continue" to proceed with the edit
      const confirmButton = dialog.getByRole('button', { name: 'Discard & Continue' })
      await confirmButton.waitFor({ state: 'visible', timeout: 2000 })
      await confirmButton.click()
      await dialog.waitFor({ state: 'hidden', timeout: 2000 })
    }

    // Wait for the edit command to complete by checking tableStore (semantic wait)
    await this.page.waitForFunction(
      () => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return false
        const state = (stores.tableStore as { getState: () => { isLoading: boolean } }).getState()
        // After edit:cell command completes, isLoading should be false
        return state?.isLoading === false
      },
      { timeout: 5000 }
    )
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
   * @deprecated Scrub panel was removed. Privacy functionality moved to Clean panel Privacy group.
   * This method will fail as the toolbar-scrub button no longer exists.
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

    // Wait for panels to close (state-aware, not fixed timeout)
    // Check for common panel test IDs
    const panelLocators = [
      this.page.getByTestId('panel-clean'),
      this.page.getByTestId('panel-combine'),
      this.page.getByTestId('panel-scrub'),
      this.page.getByTestId('match-view'),
      this.page.getByTestId('diff-view'),
    ]

    // Wait for any visible panel to close (with short timeout per panel)
    for (const panel of panelLocators) {
      const isVisible = await panel.isVisible().catch(() => false)
      if (isVisible) {
        await panel.waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {})
        break // Only one panel should be open at a time
      }
    }
  }
}