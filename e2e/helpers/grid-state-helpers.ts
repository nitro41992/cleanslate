/**
 * Grid State Helpers for E2E Tests
 *
 * These helpers enable testing canvas grid state via store access instead of DOM inspection.
 * Glide Data Grid uses canvas rendering, making traditional DOM assertions impossible for cell content.
 *
 * Use these helpers to verify grid state (selected cell, scroll position, etc.) via the gridStore.
 *
 * See CLAUDE.md section "Canvas Grid Testing Enhancement" for usage patterns.
 */

import { Page } from '@playwright/test'

/**
 * Wait for a specific cell to be selected in the grid
 *
 * @param page Playwright page instance
 * @param row Row index (0-based)
 * @param col Column index (0-based)
 * @param timeout Max wait time in milliseconds (default: 3000)
 *
 * @example
 * // After clicking cell
 * await page.getByRole('gridcell', { name: 'Cell A1' }).click()
 * await waitForCellSelected(page, 0, 0)
 */
export async function waitForCellSelected(
  page: Page,
  row: number,
  col: number,
  timeout = 3000
): Promise<void> {
  await page.waitForFunction(
    ({ row, col }) => {
      const stores = (window as any).__CLEANSLATE_STORES__
      const gridState = stores?.gridStore?.getState?.()
      return gridState?.selectedCell?.row === row && gridState?.selectedCell?.col === col
    },
    { row, col },
    { timeout }
  )
}

/**
 * Get current grid scroll position
 *
 * @param page Playwright page instance
 * @returns Current scroll top position (row index)
 *
 * @example
 * const scrollPos = await getGridScrollPosition(page)
 * expect(scrollPos).toBeGreaterThan(0)
 */
export async function getGridScrollPosition(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const stores = (window as any).__CLEANSLATE_STORES__
    const gridState = stores?.gridStore?.getState?.()
    return gridState?.scrollTop ?? 0
  })
}

/**
 * Wait for grid to scroll to a target row (within tolerance)
 *
 * @param page Playwright page instance
 * @param targetRow Target row index to scroll to
 * @param tolerance Acceptable distance from target (default: 5 rows)
 * @param timeout Max wait time in milliseconds (default: 3000)
 *
 * @example
 * // After programmatic scroll
 * await page.keyboard.press('PageDown')
 * await waitForGridScrolled(page, 20)
 */
export async function waitForGridScrolled(
  page: Page,
  targetRow: number,
  tolerance = 5,
  timeout = 3000
): Promise<void> {
  await page.waitForFunction(
    ({ targetRow, tolerance }) => {
      const stores = (window as any).__CLEANSLATE_STORES__
      const gridState = stores?.gridStore?.getState?.()
      return Math.abs((gridState?.scrollTop ?? 0) - targetRow) < tolerance
    },
    { targetRow, tolerance },
    { timeout }
  )
}

/**
 * Get selected cell coordinates
 *
 * @param page Playwright page instance
 * @returns Selected cell coordinates {row, col} or null if no selection
 *
 * @example
 * const selected = await getSelectedCell(page)
 * expect(selected).toEqual({ row: 0, col: 1 })
 */
export async function getSelectedCell(page: Page): Promise<{ row: number; col: number } | null> {
  return await page.evaluate(() => {
    const stores = (window as any).__CLEANSLATE_STORES__
    const gridState = stores?.gridStore?.getState?.()
    return gridState?.selectedCell ?? null
  })
}

/**
 * Wait for grid to finish loading (no loading indicator)
 *
 * This is a convenience wrapper around inspector.waitForGridReady() for tests
 * that don't have direct access to the inspector instance.
 *
 * @param page Playwright page instance
 * @param timeout Max wait time in milliseconds (default: 5000)
 *
 * @example
 * await uploadFile(page, 'large-dataset.csv')
 * await waitForGridLoaded(page)
 * await page.getByRole('gridcell', { name: 'A1' }).click()
 */
export async function waitForGridLoaded(page: Page, timeout = 5000): Promise<void> {
  // Wait for tableStore.isLoading to be false
  await page.waitForFunction(
    () => {
      const stores = (window as any).__CLEANSLATE_STORES__
      const tableState = stores?.tableStore?.getState?.()
      return tableState?.isLoading === false
    },
    { timeout }
  )

  // Wait for grid component to be visible
  await page.locator('[data-testid="data-grid"]').waitFor({ state: 'visible', timeout })
}

/**
 * Get visible row range in the grid viewport
 *
 * @param page Playwright page instance
 * @returns Object with firstVisibleRow and lastVisibleRow indices
 *
 * @example
 * const visibleRange = await getVisibleRowRange(page)
 * expect(visibleRange.firstVisibleRow).toBe(10)
 * expect(visibleRange.lastVisibleRow).toBe(30)
 */
export async function getVisibleRowRange(
  page: Page
): Promise<{ firstVisibleRow: number; lastVisibleRow: number }> {
  return await page.evaluate(() => {
    const stores = (window as any).__CLEANSLATE_STORES__
    const gridState = stores?.gridStore?.getState?.()

    // These values depend on gridStore implementation
    // Adjust based on actual store structure
    const scrollTop = gridState?.scrollTop ?? 0
    const rowHeight = 32 // Default row height in Glide Data Grid
    const viewportHeight = gridState?.viewportHeight ?? 600

    const firstVisibleRow = Math.floor(scrollTop / rowHeight)
    const lastVisibleRow = Math.ceil((scrollTop + viewportHeight) / rowHeight)

    return { firstVisibleRow, lastVisibleRow }
  })
}
