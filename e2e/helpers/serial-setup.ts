import { Browser, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from './store-inspector'
import { getFixturePath } from './file-upload'

/**
 * Shared context for serial test groups.
 * Contains all page objects and inspector for a single browser context.
 */
export interface SerialTestContext {
  page: Page
  laundromat: LaundromatPage
  wizard: IngestionWizardPage
  picker: TransformationPickerPage
  inspector: StoreInspector
}

/**
 * Create a shared context for serial test groups.
 * This initializes DuckDB once and reuses the page across all tests in the group.
 *
 * @param browser - The browser instance from Playwright
 * @param route - The route to navigate to (default: '/laundromat')
 * @returns SerialTestContext with initialized page objects
 */
export async function createSerialContext(
  browser: Browser,
  route = '/laundromat'
): Promise<SerialTestContext> {
  const page = await browser.newPage()
  const laundromat = new LaundromatPage(page)
  const wizard = new IngestionWizardPage(page)
  const picker = new TransformationPickerPage(page)

  // Navigate and wait for DuckDB to initialize (only once per serial group)
  await page.goto(route)
  const inspector = createStoreInspector(page)
  await inspector.waitForDuckDBReady()

  return {
    page,
    laundromat,
    wizard,
    picker,
    inspector,
  }
}

/**
 * Load a fresh table by dropping any existing table and uploading a new file.
 * Use this between tests that modify data to ensure test isolation.
 *
 * @param ctx - The serial test context
 * @param fixture - The fixture file name (from e2e/fixtures/csv/)
 * @param tableName - The expected table name after import
 * @param expectedRows - Optional expected row count to wait for
 */
export async function loadFreshTable(
  ctx: SerialTestContext,
  fixture: string,
  tableName: string,
  expectedRows?: number
): Promise<void> {
  // Drop existing table to ensure clean state
  await ctx.inspector.runQuery(`DROP TABLE IF EXISTS "${tableName}"`)

  // Upload and import the fixture
  await ctx.laundromat.uploadFile(getFixturePath(fixture))
  await ctx.wizard.waitForOpen()
  await ctx.wizard.import()

  // Wait for table to be loaded
  if (expectedRows !== undefined) {
    await ctx.inspector.waitForTableLoaded(tableName, expectedRows)
  } else {
    await ctx.inspector.waitForTableLoaded(tableName)
  }
}

/**
 * Reset to laundromat page if navigated away.
 * Useful for tests that navigate to other routes.
 *
 * @param ctx - The serial test context
 */
export async function resetToLaundromat(ctx: SerialTestContext): Promise<void> {
  const currentUrl = ctx.page.url()
  if (!currentUrl.includes('/laundromat')) {
    await ctx.laundromat.goto()
    await ctx.inspector.waitForDuckDBReady()
  }
}

/**
 * Clean up all tables in the database.
 * Use this at the start of a serial group to ensure clean state.
 *
 * @param ctx - The serial test context
 */
export async function cleanupAllTables(ctx: SerialTestContext): Promise<void> {
  const tables = await ctx.inspector.getTables()
  for (const table of tables) {
    await ctx.inspector.runQuery(`DROP TABLE IF EXISTS "${table.name}"`)
  }
}
