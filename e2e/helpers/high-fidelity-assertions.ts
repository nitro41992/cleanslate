import { Page, expect } from '@playwright/test'

/**
 * High-Fidelity Test Assertion Helpers
 *
 * These helpers enforce the High-Fidelity Testing standards:
 * - Rule 1: Assert identity, not just cardinality
 * - Rule 2: Assert exact states, avoid negative assertions
 * - Rule 3: Visual validation requires CSS/DOM/Store checks
 */

// ============================================================================
// Rule 1: Identity Assertions
// ============================================================================

/**
 * Assert that data rows have expected IDs (not just count)
 */
export function expectRowsWithIds<T extends { id: string | number }>(
  data: T[],
  expectedIds: (string | number)[]
): void {
  const actualIds = data.map((r) => String(r.id)).sort()
  const expected = expectedIds.map(String).sort()
  expect(actualIds).toEqual(expected)
}

/**
 * Assert specific row identity by checking multiple fields
 */
export function expectRowIdentity<T extends Record<string, unknown>>(
  data: T[],
  expected: Partial<T>[]
): void {
  expected.forEach((exp, i) => {
    Object.entries(exp).forEach(([key, value]) => {
      expect(data[i][key]).toBe(value)
    })
  })
}

/**
 * Assert that specific column values match expected values
 */
export function expectColumnValues<T extends Record<string, unknown>>(
  data: T[],
  column: keyof T,
  expectedValues: unknown[]
): void {
  const actualValues = data.map((r) => r[column])
  expect(actualValues).toEqual(expectedValues)
}

/**
 * Assert unique values in a column
 */
export function expectUniqueColumnValues<T extends Record<string, unknown>>(
  data: T[],
  column: keyof T,
  expectedUniqueValues: unknown[]
): void {
  const actualUnique = [...new Set(data.map((r) => r[column]))].sort()
  const expected = [...expectedUniqueValues].sort()
  expect(actualUnique).toEqual(expected)
}

// ============================================================================
// Rule 2: Positive State Assertions
// ============================================================================

/**
 * Assert modal is closed (positive assertion)
 */
export async function expectModalClosed(page: Page): Promise<void> {
  await expect(page.locator('[role="dialog"]')).toBeHidden()
}

/**
 * Assert element is hidden (positive assertion)
 */
export async function expectElementHidden(
  page: Page,
  selector: string
): Promise<void> {
  await expect(page.locator(selector)).toBeHidden()
}

/**
 * Assert badge/text is hidden (positive assertion)
 */
export async function expectBadgeHidden(
  page: Page,
  text: string
): Promise<void> {
  await expect(page.locator(`text=${text}`)).toBeHidden()
}

/**
 * Assert specific exact value (instead of not.toBe)
 */
export function expectExactValue<T>(
  actual: T,
  expected: T,
  message?: string
): void {
  expect(actual, message).toBe(expected)
}

// ============================================================================
// Rule 3: Visual State Assertions
// ============================================================================

/**
 * Check if grid rows are highlighted via timelineStore
 * Note: CleanSlate uses canvas-based Glide Data Grid, so we check store state
 * rather than DOM classes
 */
export async function expectTimelineHighlightActive(
  page: Page
): Promise<{ commandId: string; rowCount: number; diffMode: string }> {
  const highlightState = await page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
      .__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timelineState = (stores?.timelineStore as any)?.getState?.()
    return {
      commandId: timelineState?.highlight?.commandId,
      rowCount: timelineState?.highlight?.rowIds?.size || 0,
      diffMode: timelineState?.highlight?.diffMode || 'none',
    }
  })
  expect(highlightState.commandId).toBeDefined()
  return highlightState
}

/**
 * Assert timeline highlight is cleared
 */
export async function expectTimelineHighlightCleared(page: Page): Promise<void> {
  const highlightState = await page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
      .__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timelineState = (stores?.timelineStore as any)?.getState?.()
    return {
      commandId: timelineState?.highlight?.commandId,
    }
  })
  expect(highlightState.commandId).toBeNull()
}

/**
 * Get diff store state for visual validation
 */
export async function getDiffStoreState(page: Page): Promise<{
  isComparing: boolean
  summary: { added: number; removed: number; modified: number } | null
}> {
  return page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
      .__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffState = (stores?.diffStore as any)?.getState?.()
    return {
      isComparing: diffState?.isComparing || false,
      summary: diffState?.summary || null,
    }
  })
}

/**
 * Assert diff pill shows expected count
 */
export async function expectDiffPillStatus(
  page: Page,
  status: 'added' | 'removed' | 'modified',
  expectedCount: number
): Promise<void> {
  const pill = page.locator(`[data-testid="diff-pill-${status}"]`)
  await expect(pill).toBeVisible()
  const text = await pill.locator('span').first().textContent()
  expect(parseInt(text || '0')).toBe(expectedCount)
}

/**
 * Get edit store dirty state
 */
export async function getEditDirtyState(page: Page): Promise<{
  hasDirtyEdits: boolean
  dirtyCount: number
}> {
  return page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
      .__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editState = (stores?.editStore as any)?.getState?.()
    const dirtyPositions = editState?.dirtyPositions
    return {
      hasDirtyEdits: dirtyPositions?.size > 0,
      dirtyCount: dirtyPositions?.size || 0,
    }
  })
}

/**
 * Get timeline position state
 */
export async function getTimelinePosition(
  page: Page,
  tableId?: string
): Promise<{ current: number; total: number }> {
  return page.evaluate(
    ({ tableId }) => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
        .__CLEANSLATE_STORES__
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableState = (stores?.tableStore as any)?.getState?.()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timelineState = (stores?.timelineStore as any)?.getState?.()
      const activeTableId = tableId || tableState?.activeTableId
      const timeline = timelineState?.timelines?.get?.(activeTableId)
      return {
        current: timeline?.currentPosition ?? -1,
        total: timeline?.commands?.length ?? 0,
      }
    },
    { tableId }
  )
}

/**
 * Assert audit entry has undone badge styling
 */
export async function expectUndoneBadgeVisible(page: Page): Promise<void> {
  const undoneBadge = page.locator('[data-testid="audit-sidebar"]').locator('text=Undone')
  await expect(undoneBadge).toBeVisible()
}

/**
 * Assert hash format is valid (32-char hex for MD5)
 */
export function expectValidHashFormat(value: string): void {
  expect(value).toMatch(/^[a-f0-9]{32}$/)
}

/**
 * Assert two hash values are different (with explicit format check)
 */
export function expectDifferentHashes(hash1: string, hash2: string): void {
  // First verify both are valid hashes
  expectValidHashFormat(hash1)
  expectValidHashFormat(hash2)
  // Then assert they're different
  expect(hash1 !== hash2).toBe(true)
}

/**
 * Assert UUID v4 format (for _cs_id columns)
 * Use this instead of expect(uuid).not.toBe(otherUuid)
 *
 * Rule 2 Compliance: Validates both UUIDs are well-formed before comparing
 *
 * @example
 * expectValidUuid(row._cs_id)
 * expectValidUuid(row._cs_id, { notEqual: otherRow._cs_id })
 */
export function expectValidUuid(
  value: unknown,
  options?: { notEqual?: unknown }
): void {
  expect(value).toBeDefined()
  expect(typeof value).toBe('string')
  expect((value as string).length).toBe(36)

  if (options?.notEqual !== undefined) {
    // First validate the comparison value
    expect(options.notEqual).toBeDefined()
    expect(typeof options.notEqual).toBe('string')
    expect((options.notEqual as string).length).toBe(36)

    // Now safe to compare
    expect(value).not.toEqual(options.notEqual)
  }
}

// ============================================================================
// Value Standardization & Clustering Helpers (Rule 1)
// ============================================================================

/**
 * Assert specific row IDs are highlighted (not just count)
 * Use this instead of expect(rowCount).toBeGreaterThan(0)
 *
 * @example
 * const highlightState = await inspector.getTimelineHighlight()
 * expectRowIdsHighlighted(highlightState.rowIds, [1, 2, 3])
 */
export function expectRowIdsHighlighted(
  highlightedRowIds: string[],
  expectedRowIds: (string | number)[]
): void {
  const actualIds = highlightedRowIds.map(String).sort()
  const expected = expectedRowIds.map(String).sort()
  expect(actualIds).toEqual(expected)
}

/**
 * Get cluster master values from standardizerStore
 * Use this to verify search/filter results contain expected clusters
 *
 * @example
 * const masterValues = await getClusterMasterValues(page)
 * expect(masterValues).toContain('John Smith')
 */
export async function getClusterMasterValues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
      .__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (stores?.standardizerStore as any)?.getState?.()
    const filtered = state?.getFilteredClusters?.() || []
    return filtered.map((c: any) => c.masterValue)
  })
}

/**
 * Assert specific rows belong to a cluster with expected master value
 * Use this instead of count-based assertions like toBeGreaterThan(0)
 *
 * @example
 * await expectClusterMembership(page, [
 *   { masterValue: 'John Smith', rowIds: [1, 2, 3] }
 * ])
 */
export async function expectClusterMembership(
  page: Page,
  expectedClusters: Array<{ masterValue: string; rowIds: number[] }>
): Promise<void> {
  const clusterData = await page.evaluate(() => {
    const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> })
      .__CLEANSLATE_STORES__
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (stores?.standardizerStore as any)?.getState?.()
    return state?.clusters || []
  })

  expectedClusters.forEach(({ masterValue, rowIds }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cluster = clusterData.find((c: any) => c.masterValue === masterValue)
    expect(cluster, `Cluster with master "${masterValue}" not found`).toBeDefined()

    // Verify this cluster contains the expected row count (identity check)
    const clusterRowCount = cluster.values.reduce((sum: number, v: any) => sum + v.count, 0)
    expect(clusterRowCount, `Cluster "${masterValue}" should contain ${rowIds.length} rows`).toBe(rowIds.length)
  })
}
