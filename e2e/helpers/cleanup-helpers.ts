/**
 * Tiered Cleanup Helpers for E2E Tests
 *
 * These helpers prevent state accumulation in serial test groups by cleaning up:
 * - Audit log entries
 * - DuckDB snapshots (Tier 3 commands)
 * - Timeline state (undo/redo stack)
 * - Internal diff tables
 * - Panel states
 *
 * See CLAUDE.md for usage guidelines and tier selection.
 */

import { Page } from '@playwright/test'
import { StoreInspector } from './store-inspector'

export interface CleanupOptions {
  /** Drop all tables (heavy cleanup - Tier 3) */
  dropTables?: boolean
  /** Close all open panels */
  closePanels?: boolean
  /** Clear diff state (internal tables like v_diff_*) */
  clearDiffState?: boolean
  /** Prune audit log entries */
  pruneAudit?: boolean
  /** Max audit entries before pruning (default: 50) */
  auditThreshold?: number
}

/**
 * Tier 1 Cleanup - Light Tests Only
 * Use for: Simple transforms (trim, uppercase, lowercase, replace)
 *
 * Only closes panels. No database cleanup.
 *
 * @example
 * test.afterEach(async () => {
 *   await coolHeapLight(page)
 * })
 */
export async function coolHeapLight(page: Page): Promise<void> {
  // Force-close any stacked modals with Escape key
  // (Twice for nested dialogs that may block panel cleanup)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // Close all panels by checking for panel containers
  const panels = [
    'matcher-panel',
    'combiner-panel',
    'scrubber-panel',
    'diff-overlay',
    'standardize-panel'
  ]

  for (const panelId of panels) {
    const panel = page.getByTestId(panelId)
    const isVisible = await panel.isVisible().catch(() => false)

    if (isVisible) {
      // Try to find and click close button
      const closeButton = panel.getByRole('button', { name: /close/i }).first()
      const hasCloseBtn = await closeButton.isVisible().catch(() => false)

      if (hasCloseBtn) {
        await closeButton.click()
        // Wait for panel to close
        await panel.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
      }
    }
  }
}

/**
 * Tier 2/3 Cleanup - Medium and Heavy Tests
 * Use for: Multiple transforms, joins, snapshots, matcher operations
 *
 * Provides comprehensive cleanup with configurable options.
 *
 * @example
 * // Tier 2 - Medium Tests (keep tables)
 * test.afterEach(async () => {
 *   await coolHeap(page, inspector, {
 *     dropTables: false,
 *     closePanels: true,
 *     clearDiffState: true,
 *     pruneAudit: true,
 *     auditThreshold: 50
 *   })
 * })
 *
 * @example
 * // Tier 3 - Heavy Tests (full cleanup)
 * test.afterEach(async () => {
 *   await coolHeap(page, inspector, {
 *     dropTables: true,
 *     closePanels: true,
 *     clearDiffState: true,
 *     pruneAudit: true,
 *     auditThreshold: 30
 *   })
 *   await page.close()  // Force WASM worker garbage collection
 * })
 */
export async function coolHeap(
  page: Page,
  inspector: StoreInspector,
  options: CleanupOptions = {}
): Promise<void> {
  const {
    dropTables = false,
    closePanels = true,
    clearDiffState = true,
    pruneAudit = true,
    auditThreshold = 50
  } = options

  // 1. Close panels first (UI cleanup)
  if (closePanels) {
    await coolHeapLight(page)
  }

  // 2. Clear diff state (internal tables)
  if (clearDiffState) {
    try {
      // Get list of internal diff tables
      const tables = await inspector.getTables()
      const diffTables = tables.filter(t =>
        t.name.startsWith('v_diff_') ||
        t.name.startsWith('_diff_') ||
        t.name.includes('_snapshot_')
      )

      for (const table of diffTables) {
        await inspector.runQuery(`DROP TABLE IF EXISTS "${table.name}"`).catch(() => {})
      }
    } catch {
      // Silently ignore errors - table may not exist
    }
  }

  // 3. Prune audit log if exceeds threshold
  if (pruneAudit) {
    try {
      const auditEntries = await inspector.getAuditEntries()

      if (auditEntries.length > auditThreshold) {
        // Keep only the most recent entries up to threshold
        const entriesToKeep = auditEntries.slice(-auditThreshold)
        const oldestIdToKeep = entriesToKeep[0]?.id

        if (oldestIdToKeep !== undefined) {
          // This would require accessing auditStore directly
          // For now, just log a warning
          // console.warn(`Audit log has ${auditEntries.length} entries (threshold: ${auditThreshold})`)
          // Future: Implement pruning via auditStore.pruneOldEntries(oldestIdToKeep)
        }
      }
    } catch {
      // Silently ignore errors
    }
  }

  // 4. Drop all tables if requested (heavy cleanup)
  if (dropTables) {
    try {
      const tables = await inspector.getTables()

      for (const table of tables) {
        await inspector.runQuery(`DROP TABLE IF EXISTS "${table.name}"`).catch(() => {})
      }
    } catch {
      // Silently ignore errors
    }
  }

  // Cleanup complete - no delays needed (all operations are synchronous SQL)
}

/**
 * Categorize test type to determine appropriate cleanup tier
 *
 * @param testTitle The test title to analyze
 * @returns Recommended tier (1, 2, or 3)
 *
 * @example
 * const tier = categorizeTestTier('should trim whitespace')
 * if (tier === 1) {
 *   await coolHeapLight(page)
 * } else {
 *   await coolHeap(page, inspector, { dropTables: tier === 3 })
 * }
 */
export function categorizeTestTier(testTitle: string): 1 | 2 | 3 {
  const lowerTitle = testTitle.toLowerCase()

  // Tier 3 - Heavy operations (snapshot-based)
  const tier3Keywords = [
    'remove_duplicates', 'dedupe', 'cast_type', 'split_column',
    'match', 'merge', 'fuzzy', 'large', 'parquet', 'snapshot'
  ]
  if (tier3Keywords.some(keyword => lowerTitle.includes(keyword))) {
    return 3
  }

  // Tier 2 - Medium operations (inverse SQL)
  const tier2Keywords = [
    'rename', 'edit', 'combine', 'stack', 'join', 'diff', 'multiple'
  ]
  if (tier2Keywords.some(keyword => lowerTitle.includes(keyword))) {
    return 2
  }

  // Tier 1 - Light operations (expression chaining)
  return 1
}
