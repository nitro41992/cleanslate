import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

// Helper to get word wrap state from tableStore
async function getWordWrapEnabled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
    if (!stores?.tableStore) return false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (stores.tableStore as any).getState()
    const tables = state?.tables || []
    const activeTable = tables[0]
    return activeTable?.columnPreferences?.wordWrapEnabled ?? false
  })
}


test.describe('Word Wrap', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    inspector = createStoreInspector(page)
    await page.goto('/')
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test('should toggle word wrap and persist across toggle cycles', async () => {
    // Load table with content
    await laundromat.uploadFile(getFixturePath('basic-data.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('basic_data', 5)

    // Get wrap button using test-id or accessible label
    const wrapButton = page.getByRole('button').filter({ has: page.locator('svg.lucide-wrap-text') })

    // Initially wrap should be off
    const initialWrapState = await getWordWrapEnabled(page)
    expect(initialWrapState).toBe(false)

    // Enable wrap
    await wrapButton.click()

    // Verify wrap is enabled in store
    await expect.poll(async () => {
      return await getWordWrapEnabled(page)
    }, { timeout: 5000 }).toBe(true)

    // Verify button shows active state (amber highlight)
    await expect(wrapButton).toHaveClass(/bg-amber-500/)

    // Disable wrap
    await wrapButton.click()

    // Verify wrap is disabled in store
    await expect.poll(async () => {
      return await getWordWrapEnabled(page)
    }, { timeout: 5000 }).toBe(false)

    // Button should no longer have amber highlight
    await expect(wrapButton).not.toHaveClass(/bg-amber-500/)

    // Re-enable wrap (the key test - this was broken before the fix)
    await wrapButton.click()

    // Verify wrap is enabled again
    await expect.poll(async () => {
      return await getWordWrapEnabled(page)
    }, { timeout: 5000 }).toBe(true)

    // Verify button shows active state again
    await expect(wrapButton).toHaveClass(/bg-amber-500/)
  })

  test('should persist word wrap state after scrolling', async () => {
    // Load table with enough rows to enable scrolling
    await laundromat.uploadFile(getFixturePath('word-wrap-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('word_wrap_test', 15)

    const wrapButton = page.getByRole('button').filter({ has: page.locator('svg.lucide-wrap-text') })
    const grid = page.locator('[data-testid="data-grid"]').first()

    // Enable wrap
    await wrapButton.click()
    await expect.poll(() => getWordWrapEnabled(page), { timeout: 5000 }).toBe(true)

    // Scroll down in the grid
    await grid.click() // Focus the grid
    await page.keyboard.press('End') // Scroll to bottom
    await page.keyboard.press('PageDown')
    await page.keyboard.press('PageDown')

    // Verify wrap state persists after scroll
    const wrapStateAfterScrollDown = await getWordWrapEnabled(page)
    expect(wrapStateAfterScrollDown).toBe(true)

    // Scroll back up
    await page.keyboard.press('Home') // Scroll to top
    await page.keyboard.press('PageUp')

    // Verify wrap state still persists
    const wrapStateAfterScrollUp = await getWordWrapEnabled(page)
    expect(wrapStateAfterScrollUp).toBe(true)

    // Button should still show active state
    await expect(wrapButton).toHaveClass(/bg-amber-500/)
  })

  test('should work correctly after disable and re-enable cycle with scroll', async () => {
    // This is the key regression test for the bug
    await laundromat.uploadFile(getFixturePath('word-wrap-test.csv'))
    await wizard.import()
    await inspector.waitForTableLoaded('word_wrap_test', 15)

    const wrapButton = page.getByRole('button').filter({ has: page.locator('svg.lucide-wrap-text') })
    const grid = page.locator('[data-testid="data-grid"]').first()

    // Step 1: Enable wrap
    await wrapButton.click()
    await expect.poll(() => getWordWrapEnabled(page), { timeout: 5000 }).toBe(true)
    await expect(wrapButton).toHaveClass(/bg-amber-500/)

    // Step 2: Scroll down
    await grid.click()
    await page.keyboard.press('End')

    // Verify wrap still enabled after scroll
    expect(await getWordWrapEnabled(page)).toBe(true)

    // Step 3: Disable wrap while scrolled
    await wrapButton.click()
    await expect.poll(() => getWordWrapEnabled(page), { timeout: 5000 }).toBe(false)
    await expect(wrapButton).not.toHaveClass(/bg-amber-500/)

    // Step 4: Scroll back up
    await page.keyboard.press('Home')

    // Verify wrap is still disabled after scroll
    expect(await getWordWrapEnabled(page)).toBe(false)

    // Step 5: Re-enable wrap (THE KEY TEST - this was broken before)
    await wrapButton.click()
    await expect.poll(() => getWordWrapEnabled(page), { timeout: 5000 }).toBe(true)
    await expect(wrapButton).toHaveClass(/bg-amber-500/)

    // Step 6: Scroll down again and verify wrap persists
    await grid.click()
    await page.keyboard.press('End')

    const wrapStateAfterFinalScroll = await getWordWrapEnabled(page)
    expect(wrapStateAfterFinalScroll).toBe(true)

    // Button should still show active state after all the scrolling
    await expect(wrapButton).toHaveClass(/bg-amber-500/)
  })
})
