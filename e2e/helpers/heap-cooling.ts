import { Page } from '@playwright/test'
import { StoreInspector } from './store-inspector'

/**
 * Heap Cooling Utilities
 *
 * Explicit memory cleanup between Playwright tests to prevent DuckDB state accumulation.
 *
 * Problem: Serial test groups with shared page contexts accumulate memory from:
 * - DuckDB snapshots (Tier 3 commands)
 * - Internal diff tables (v_diff_*)
 * - Audit log entries
 * - Timeline state (undo/redo stack)
 * - __base columns from Tier 1 transforms
 *
 * Solution: Provide tiered cleanup strategies based on test intensity.
 */

export interface HeapCoolingOptions {
  /** Drop all DuckDB tables (user + internal) */
  dropTables?: boolean
  /** Close panels via Escape key (releases React memory) */
  closePanels?: boolean
  /** Reset diffStore state */
  clearDiffState?: boolean
  /** Reset timelineStore state (aggressive) */
  clearTimelineState?: boolean
  /** Prune audit log if > threshold entries */
  pruneAudit?: boolean
  /** Audit log entry count threshold for pruning (default: 100) */
  auditThreshold?: number
  /** Reset DuckDB connection if unhealthy (for critical test boundaries) */
  resetConnection?: boolean
}

/**
 * Aggressive cleanup for HIGH-intensity tests (joins, diffs, matcher operations).
 *
 * Usage:
 * ```typescript
 * test.afterEach(async () => {
 *   await coolHeap(page, inspector, {
 *     dropTables: true,
 *     closePanels: true,
 *     clearDiffState: true,
 *   })
 * })
 * ```
 *
 * @param page - Playwright Page instance
 * @param inspector - StoreInspector for accessing DuckDB and stores
 * @param options - Cleanup options (defaults to all enabled)
 */
export async function coolHeap(
  page: Page,
  inspector: StoreInspector,
  options: HeapCoolingOptions = {}
): Promise<void> {
  const {
    dropTables = true,
    closePanels = true,
    clearDiffState = true,
    clearTimelineState = false, // Disabled by default (too aggressive)
    pruneAudit = true,
    auditThreshold = 100,
    resetConnection = false, // Disabled by default (only for critical boundaries)
  } = options

  // 1. Drop all tables (frees DuckDB memory)
  if (dropTables) {
    try {
      const tables = await inspector.getTables()
      for (const table of tables) {
        // Drop both user tables and internal tables (v_diff_*, etc.)
        await inspector.runQuery(`DROP TABLE IF EXISTS "${table.name}"`)
      }

      // Force memory reclamation after dropping tables
      await inspector.runQuery('VACUUM')
    } catch (error) {
      console.warn('[coolHeap] Failed to drop tables:', error)
    }
  }

  // 2. Close panels (releases React component memory)
  if (closePanels) {
    try {
      // Press Escape to close any open panels/overlays (state-aware approach)
      const panelSelectors = [
        '[data-testid="panel-clean"]',
        '[data-testid="panel-combine"]',
        '[data-testid="panel-scrub"]',
        '[data-testid="match-view"]',
        '[data-testid="diff-view"]',
      ]

      for (let attempt = 0; attempt < 2; attempt++) {
        // Check if any panel is visible
        let anyPanelVisible = false
        for (const selector of panelSelectors) {
          if (await page.locator(selector).isVisible().catch(() => false)) {
            anyPanelVisible = true
            break
          }
        }

        if (!anyPanelVisible) break

        await page.keyboard.press('Escape')

        // Wait for panels to close (state-aware)
        for (const selector of panelSelectors) {
          const panel = page.locator(selector)
          if (await panel.isVisible().catch(() => false)) {
            await panel.waitFor({ state: 'hidden', timeout: 500 }).catch(() => {})
          }
        }
      }
    } catch (error) {
      console.warn('[coolHeap] Failed to close panels:', error)
    }
  }

  // 3. Reset diff store state
  if (clearDiffState) {
    try {
      await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const diffStore = stores?.diffStore as { getState: () => { reset?: () => void } } | undefined
        const state = diffStore?.getState()
        if (typeof state?.reset === 'function') {
          state.reset()
        }
      })
    } catch (error) {
      console.warn('[coolHeap] Failed to clear diff state:', error)
    }
  }

  // 4. Reset timeline store state (AGGRESSIVE - only use if needed)
  if (clearTimelineState) {
    try {
      await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        const timelineStore = stores?.timelineStore as { getState: () => { reset?: () => void } } | undefined
        const state = timelineStore?.getState()
        if (typeof state?.reset === 'function') {
          state.reset()
        }
      })
    } catch (error) {
      console.warn('[coolHeap] Failed to clear timeline state:', error)
    }
  }

  // 5. Prune audit log if too large
  if (pruneAudit) {
    try {
      const auditEntries = await inspector.getAuditEntries()
      if (auditEntries.length > auditThreshold) {
        await page.evaluate(({ threshold }) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
          const auditStore = stores?.auditStore as {
            getState: () => {
              entries: unknown[]
              pruneOldEntries?: (count: number) => void
            }
          } | undefined
          const state = auditStore?.getState()
          if (typeof state?.pruneOldEntries === 'function') {
            const entriesToRemove = state.entries.length - threshold
            if (entriesToRemove > 0) {
              state.pruneOldEntries(entriesToRemove)
            }
          }
        }, { threshold: auditThreshold })
      }
    } catch (error) {
      console.warn('[coolHeap] Failed to prune audit log:', error)
    }
  }

  // 6. Reset connection if unhealthy (for critical test boundaries)
  if (resetConnection) {
    try {
      const isHealthy = await inspector.checkConnectionHealth()
      if (!isHealthy) {
        console.warn('[coolHeap] Connection unhealthy, resetting...')
        await inspector.resetDuckDBConnection()
      }
    } catch (error) {
      console.warn('[coolHeap] Failed to reset connection:', error)
    }
  }
}

/**
 * Lightweight cleanup for LOW-intensity tests (simple transformations).
 *
 * Only closes panels - no table drops or state resets.
 * Minimal overhead for fast-running tests.
 *
 * Usage:
 * ```typescript
 * test.afterEach(async () => {
 *   await coolHeapLight(page)
 * })
 * ```
 *
 * @param page - Playwright Page instance
 */
export async function coolHeapLight(page: Page): Promise<void> {
  try {
    // Close panels via Escape key (state-aware approach)
    const panelSelectors = [
      '[data-testid="panel-clean"]',
      '[data-testid="panel-combine"]',
      '[data-testid="panel-scrub"]',
      '[data-testid="match-view"]',
      '[data-testid="diff-view"]',
    ]

    for (let attempt = 0; attempt < 2; attempt++) {
      // Check if any panel is visible
      let anyPanelVisible = false
      for (const selector of panelSelectors) {
        if (await page.locator(selector).isVisible().catch(() => false)) {
          anyPanelVisible = true
          break
        }
      }

      if (!anyPanelVisible) break

      await page.keyboard.press('Escape')

      // Wait for panels to close (state-aware)
      for (const selector of panelSelectors) {
        const panel = page.locator(selector)
        if (await panel.isVisible().catch(() => false)) {
          await panel.waitFor({ state: 'hidden', timeout: 500 }).catch(() => {})
        }
      }
    }
  } catch (error) {
    console.warn('[coolHeapLight] Failed to close panels:', error)
  }
}
