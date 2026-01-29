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
   * Handles category expansion and scrolling automatically
   */
  async selectTransformation(name: string): Promise<void> {
    // Ensure the CleanPanel is open and ready for selection
    await this.page.getByTestId('panel-clean').waitFor({ state: 'visible', timeout: 5000 })

    // Wait for any previous transformation's form reset to complete
    await this.page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-testid="panel-clean"]')
        if (!panel) return false
        const applyBtn = panel.querySelector('[data-testid="apply-transformation-btn"]')
        if (applyBtn?.textContent?.includes('Applying')) return false
        return true
      },
      { timeout: 5000 }
    ).catch(() => {})

    const panel = this.page.getByTestId('panel-clean')

    // Strategy: Find the transformation button by looking for buttons that:
    // 1. Contain the transformation name (case insensitive)
    // 2. Have a LONGER text (transformation buttons include descriptions like "Replace text values")
    // 3. Category headers are short like "⬡ Find & Replace 2" (~20 chars)
    // 4. Transform buttons are longer like "🔍 Find & Replace Replace text values" (~40+ chars)

    // Use page.evaluate to find the correct button based on text length
    const buttonInfo = await this.page.evaluate((searchName) => {
      const panelEl = document.querySelector('[data-testid="panel-clean"]')
      if (!panelEl) return null

      const buttons = panelEl.querySelectorAll('button')
      let categoryButtonIndex = -1
      let transformButtonIndex = -1

      for (let i = 0; i < buttons.length; i++) {
        const text = buttons[i].textContent || ''
        if (!text.toLowerCase().includes(searchName.toLowerCase())) continue

        const trimmedText = text.trim()
        // Category headers are short (under 30 chars) and end with a number
        // Transform buttons are longer and include a description
        const isShortAndEndsWithNumber = trimmedText.length < 30 && /\d{1,2}$/.test(trimmedText)

        if (isShortAndEndsWithNumber) {
          categoryButtonIndex = i
        } else {
          transformButtonIndex = i
          break // Found the transform button, stop searching
        }
      }

      return { categoryButtonIndex, transformButtonIndex }
    }, name)

    if (!buttonInfo || buttonInfo.transformButtonIndex === -1) {
      throw new Error(`Could not find transformation button for: ${name}`)
    }

    // Get locators for the buttons we found
    const allButtons = panel.locator('button')
    const transformButton = allButtons.nth(buttonInfo.transformButtonIndex)

    // Check if the transform button is visible
    const isVisible = await transformButton.isVisible()

    if (!isVisible && buttonInfo.categoryButtonIndex !== -1) {
      // Need to expand the category first
      const categoryButton = allButtons.nth(buttonInfo.categoryButtonIndex)
      await categoryButton.scrollIntoViewIfNeeded()
      await categoryButton.click()
      // Wait for expansion animation
      await transformButton.waitFor({ state: 'visible', timeout: 3000 })
    }

    // Scroll into view and click the transformation button
    await transformButton.scrollIntoViewIfNeeded()
    await transformButton.waitFor({ state: 'visible', timeout: 5000 })
    await transformButton.click()

    // Wait for transformation form to render (placeholder text disappears)
    await this.page.waitForFunction(
      () => {
        const panelEl = document.querySelector('[data-testid="panel-clean"]')
        if (!panelEl) return false
        return !panelEl.textContent?.includes('Select a transformation from the left')
      },
      { timeout: 5000 }
    )

    // Wait for column selector if this transformation requires it
    await this.page.getByTestId('column-selector').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
      // Some transformations may not have column selector, which is OK
    })
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

    // Wait for dropdown to close after selection
    // The dropdown uses Radix UI which wraps content in a popper wrapper
    await this.page.locator('[data-radix-popper-content-wrapper]').waitFor({
      state: 'hidden',
      timeout: 2000
    }).catch(async () => {
      // If dropdown doesn't close automatically, press Escape to close it
      await this.page.keyboard.press('Escape')
    })
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
    // Wait for success indicator (toast or button state change) - state-aware
    await this.page.locator('[role="region"][aria-label*="Notifications"] [data-state="open"]')
      .waitFor({ state: 'visible', timeout: 1000 }).catch(() => {
        // Toast may not appear for all transformations, which is OK
      })

    // Wait for the form to reset (CleanPanel resets after 1.5s delay)
    // This ensures subsequent addTransformation calls work correctly
    await this.page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-testid="panel-clean"]')
        if (!panel) return false
        // Form is reset when the "Select a transformation" placeholder appears
        // OR when no transformation is currently selected (Apply button is disabled)
        const text = panel.textContent || ''
        const hasPlaceholder = text.includes('Select a transformation from the left')
        const applyBtn = panel.querySelector('[data-testid="apply-transformation-btn"]')
        const applyDisabled = applyBtn?.hasAttribute('disabled') || false
        return hasPlaceholder || applyDisabled
      },
      { timeout: 3000 }
    ).catch(() => {
      // If form doesn't reset within 3s, continue anyway (may be OK for some transformations)
    })
  }

  /**
   * Click the Apply button without waiting for completion.
   * Use this when expecting a confirmation dialog to appear.
   */
  async clickApply(): Promise<void> {
    await this.applyButton.click()
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
