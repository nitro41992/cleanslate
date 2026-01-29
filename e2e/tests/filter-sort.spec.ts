/**
 * E2E Tests for Data Grid Filtering and Sorting
 *
 * Tests the view-only filter and sort operations that modify SQL queries
 * without changing underlying data.
 */

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { createStoreInspector, type StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

// Use longer timeout for WASM initialization
test.setTimeout(120000)

// Type for the stores exposed on window
interface CleanSlateStores {
  tableStore: {
    getState: () => {
      tables: Array<{ id: string; name: string }>
      activeTableId: string | null
      setFilter: (id: string, filter: { column: string; operator: string; value: unknown; value2?: unknown }) => void
      removeFilter: (id: string, column: string) => void
      clearFilters: (id: string) => void
      setSort: (id: string, column: string | null, direction: 'asc' | 'desc') => void
      clearViewState: (id: string) => void
      getViewState: (id: string) => { filters: Array<{ column: string; operator: string; value: unknown }>; sortColumn: string | null; sortDirection: 'asc' | 'desc' } | undefined
    }
  }
}

test.describe('Filter and Sort', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let laundromat: LaundromatPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser: b }) => {
    browser = b
  })

  test.beforeEach(async () => {
    // Fresh context per test for WASM isolation
    context = await browser.newContext()
    page = await context.newPage()
    laundromat = new LaundromatPage(page)
    inspector = createStoreInspector(page)
    await laundromat.goto()
    await inspector.waitForDuckDBReady(30000)
  })

  test.afterEach(async () => {
    try {
      await context.close()
    } catch {
      // Ignore - context may already be closed
    }
  })

  test.describe('Text Filters', () => {
    test('should filter rows using contains operator', async () => {
      // Upload a fixture file
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      // Get the table ID using __CLEANSLATE_STORES__
      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      expect(tableId).toBeTruthy()

      // Apply filter: name contains "o" (should match "John", "Bob")
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setFilter(tid, {
          column: 'name',
          operator: 'contains',
          value: 'o'
        })
      }, tableId)

      // Verify filter is applied by polling viewState
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return 0
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.filters?.length ?? 0
        }, tableId)
      }, { timeout: 5000 }).toBe(1)

      // Verify filter details
      const viewState = await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().getViewState(tid)
      }, tableId)

      expect(viewState).toBeDefined()
      expect(viewState?.filters).toHaveLength(1)
      expect(viewState?.filters[0].column).toBe('name')
      expect(viewState?.filters[0].operator).toBe('contains')
    })
  })

  test.describe('Sorting', () => {
    test('should sort ascending', async () => {
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      // Apply ascending sort on name column
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setSort(tid, 'name', 'asc')
      }, tableId)

      // Verify sort is applied
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return null
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.sortColumn
        }, tableId)
      }, { timeout: 5000 }).toBe('name')

      const viewState = await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().getViewState(tid)
      }, tableId)

      expect(viewState?.sortDirection).toBe('asc')
    })

    test('should sort descending', async () => {
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      // Apply descending sort
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setSort(tid, 'age', 'desc')
      }, tableId)

      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return null
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.sortDirection
        }, tableId)
      }, { timeout: 5000 }).toBe('desc')
    })
  })

  test.describe('Combined Filter and Sort', () => {
    test('should apply both filter and sort', async () => {
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      // Apply filter
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setFilter(tid, {
          column: 'age',
          operator: 'gt',
          value: 25
        })
      }, tableId)

      // Apply sort
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setSort(tid, 'name', 'asc')
      }, tableId)

      // Verify both are applied
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return false
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.filters?.length === 1 && vs?.sortColumn === 'name'
        }, tableId)
      }, { timeout: 5000 }).toBe(true)
    })
  })

  test.describe('Filter Clear Operations', () => {
    test('should clear all filters', async () => {
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      // Add multiple filters
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setFilter(tid, {
          column: 'name',
          operator: 'contains',
          value: 'Test'
        })
        stores.tableStore.getState().setFilter(tid, {
          column: 'age',
          operator: 'gt',
          value: 20
        })
      }, tableId)

      // Verify filters are added
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return 0
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.filters?.length ?? 0
        }, tableId)
      }, { timeout: 5000 }).toBe(2)

      // Clear all filters
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().clearFilters(tid)
      }, tableId)

      // Verify filters are cleared
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return 0
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.filters?.length ?? 0
        }, tableId)
      }, { timeout: 5000 }).toBe(0)
    })

    test('should clear sort', async () => {
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      // Apply sort
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setSort(tid, 'name', 'asc')
      }, tableId)

      // Verify sort is applied
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return null
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.sortColumn
        }, tableId)
      }, { timeout: 5000 }).toBe('name')

      // Clear sort by setting null
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setSort(tid, null, 'asc')
      }, tableId)

      // Verify sort is cleared
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return 'NOT_NULL'
          const vs = stores.tableStore.getState().getViewState(tid)
          return vs?.sortColumn
        }, tableId)
      }, { timeout: 5000 }).toBeNull()
    })

    test('should clear all view state', async () => {
      await laundromat.uploadFile(getFixturePath('basic-data.csv'))
      const wizard = new IngestionWizardPage(page)
      await wizard.import()
      await inspector.waitForTableLoaded('basic_data', 5)

      const tableId = await page.evaluate(() => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) return null
        return stores.tableStore.getState().tables[0]?.id
      })

      // Add filter and sort
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().setFilter(tid, {
          column: 'name',
          operator: 'contains',
          value: 'Test'
        })
        stores.tableStore.getState().setSort(tid, 'age', 'desc')
      }, tableId)

      // Verify view state exists
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return false
          return stores.tableStore.getState().getViewState(tid) !== undefined
        }, tableId)
      }, { timeout: 5000 }).toBe(true)

      // Clear all view state
      await page.evaluate((tid) => {
        const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
        if (!stores?.tableStore) throw new Error('Store not available')
        stores.tableStore.getState().clearViewState(tid)
      }, tableId)

      // Verify view state is undefined
      await expect.poll(async () => {
        return page.evaluate((tid) => {
          const stores = (window as Window & { __CLEANSLATE_STORES__?: CleanSlateStores }).__CLEANSLATE_STORES__
          if (!stores?.tableStore) return 'STORE_ERROR'
          return stores.tableStore.getState().getViewState(tid)
        }, tableId)
      }, { timeout: 5000 }).toBeUndefined()
    })
  })
})
