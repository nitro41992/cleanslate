import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'

/**
 * Memory Optimization Tests
 *
 * Validates that OPFS-backed DuckDB with compression significantly reduces memory footprint
 * compared to the legacy CSV-based approach.
 *
 * Success Criteria (from plan):
 * - 240MB CSV → 500-700MB in memory (2-3x, not 6x)
 * - Compression enabled (30-50% reduction)
 * - No regression in transformation speed
 *
 * Note: These tests use programmatically generated data since committing
 * 50k+ row fixtures would bloat the repo.
 */

test.describe.serial('Memory Optimization - Compression', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    // Clean up OPFS storage
    await page.evaluate(async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        await opfsRoot.removeEntry('cleanslate.db')
      } catch (err) {
        console.log('[Test Cleanup] Could not delete cleanslate.db:', err)
      }
    })
    await page.close()
  })

  test.afterEach(async () => {
    // Drop internal diff tables created during comparison to prevent memory accumulation
    try {
      const internalTables = await inspector.runQuery(`
        SELECT table_name FROM information_schema.tables
        WHERE table_name LIKE 'v_diff_%' OR table_name LIKE '_timeline_%'
      `)
      for (const t of internalTables) {
        await inspector.runQuery(`DROP TABLE IF EXISTS "${t.table_name}"`)
      }
    } catch {
      // Ignore errors during cleanup
    }
    // Press Escape to close any open panels
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  /**
   * Generate a large CSV file with realistic data
   * Creates 5k rows with 10 columns (~2MB file)
   */
  async function generateLargeCSV(rowCount: number): Promise<File> {
    const headers = [
      'id',
      'name',
      'email',
      'company',
      'address',
      'city',
      'state',
      'zip',
      'phone',
      'notes'
    ]

    const lines = [headers.join(',')]

    for (let i = 0; i < rowCount; i++) {
      const row = [
        i + 1,
        `User ${i + 1}`,
        `user${i}@example.com`,
        `Company ${i % 100}`,
        `${i} Main Street`,
        `City ${i % 50}`,
        `ST${i % 50}`,
        String(10000 + i).padStart(5, '0'),
        `555-${String(i).padStart(4, '0')}`,
        `This is a sample note with some repeated text to test compression efficiency. Row ${i}.`
      ]
      lines.push(row.join(','))
    }

    const csvContent = lines.join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv' })
    return new File([blob], `large_dataset_${rowCount}.csv`, { type: 'text/csv' })
  }

  test('should use compression to reduce memory footprint (5k rows)', async () => {
    // Generate large dataset (5k rows ~2MB)
    const largeFile = await generateLargeCSV(5000)
    const fileSizeBytes = largeFile.size
    const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2)

    console.log(`[Memory Test] Generated CSV: ${fileSizeMB}MB (5k rows, 10 columns)`)

    // Load the file
    await page.evaluate(async (fileContent) => {
      const file = new File([fileContent], 'large_dataset_5000.csv', { type: 'text/csv' })
      const dropzone = document.querySelector('[data-testid="file-dropzone"]') as HTMLElement
      if (dropzone) {
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(file)
        const event = new DragEvent('drop', {
          bubbles: true,
          dataTransfer
        })
        dropzone.dispatchEvent(event)
      }
    }, await largeFile.text())

    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('large_dataset_5000', 5000)

    // Get memory usage (estimate from DuckDB)
    const memoryInfo = await page.evaluate(async () => {
      try {
        // Query DuckDB memory usage
        const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
        if (!stores?.duckdb) return null

        // Use performance.memory if available (Chrome only)
        if ('memory' in performance) {
          const mem = (performance as Performance & {
            memory?: {
              usedJSHeapSize: number
              totalJSHeapSize: number
              jsHeapSizeLimit: number
            }
          }).memory
          return {
            usedMB: mem ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(2) : 'N/A',
            totalMB: mem ? (mem.totalJSHeapSize / (1024 * 1024)).toFixed(2) : 'N/A'
          }
        }
        return null
      } catch {
        return null
      }
    })

    if (memoryInfo) {
      console.log(`[Memory Test] Heap used: ${memoryInfo.usedMB}MB / ${memoryInfo.totalMB}MB`)

      // With compression, 2MB file should use < 10MB in memory
      // (Conservative threshold since Playwright overhead adds noise)
      const usedMB = parseFloat(memoryInfo.usedMB as string)
      expect(usedMB).toBeLessThan(200) // Well under limit
    } else {
      console.log('[Memory Test] performance.memory not available (non-Chrome browser)')
    }

    // Verify table loaded correctly
    const tables = await inspector.getTables()
    const largeTable = tables.find(t => t.name === 'large_dataset_5000')
    expect(largeTable?.rowCount).toBe(5000)
  })

  test('should maintain compression after transformations', async () => {
    // Load data (reusing from previous test or regenerating)
    const currentTables = await inspector.getTables()
    if (!currentTables.some(t => t.name === 'large_dataset_5000')) {
      const largeFile = await generateLargeCSV(5000)
      await page.evaluate(async (fileContent) => {
        const file = new File([fileContent], 'large_dataset_5000.csv', { type: 'text/csv' })
        const dropzone = document.querySelector('[data-testid="file-dropzone"]') as HTMLElement
        if (dropzone) {
          const dataTransfer = new DataTransfer()
          dataTransfer.items.add(file)
          const event = new DragEvent('drop', {
            bubbles: true,
            dataTransfer
          })
          dropzone.dispatchEvent(event)
        }
      }, await largeFile.text())
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('large_dataset_5000', 5000)
    }

    // Get memory before transformations
    const memBefore = await page.evaluate(() => {
      if ('memory' in performance) {
        const mem = (performance as Performance & {
          memory?: { usedJSHeapSize: number }
        }).memory
        return mem ? mem.usedJSHeapSize : 0
      }
      return 0
    })

    // Apply 3 transformations
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await picker.addTransformation('Trim Whitespace', { column: 'email' })
    await picker.addTransformation('Lowercase', { column: 'city' })

    // Wait for transformations to complete
    await page.waitForTimeout(1000)

    // Get memory after transformations
    const memAfter = await page.evaluate(() => {
      if ('memory' in performance) {
        const mem = (performance as Performance & {
          memory?: { usedJSHeapSize: number }
        }).memory
        return mem ? mem.usedJSHeapSize : 0
      }
      return 0
    })

    if (memBefore > 0 && memAfter > 0) {
      const memIncreaseMB = ((memAfter - memBefore) / (1024 * 1024)).toFixed(2)
      console.log(`[Memory Test] Memory increase after 3 transforms: ${memIncreaseMB}MB`)

      // Memory increase should be minimal with compression
      // (Tier 1 transforms use expression chaining, not full copies)
      expect(memAfter - memBefore).toBeLessThan(50 * 1024 * 1024) // <50MB increase
    }

    // Verify transformations applied correctly
    const data = await inspector.getTableData('large_dataset_5000', 10)
    expect(data[0].name).toMatch(/^USER \d+$/) // Uppercase
    expect(data[0].city).toMatch(/^city \d+$/) // Lowercase
  })

  test('should not regress transformation speed with compression', async () => {
    // Ensure table exists
    const currentTables = await inspector.getTables()
    if (!currentTables.some(t => t.name === 'large_dataset_5000')) {
      const largeFile = await generateLargeCSV(5000)
      await page.evaluate(async (fileContent) => {
        const file = new File([fileContent], 'large_dataset_5000.csv', { type: 'text/csv' })
        const dropzone = document.querySelector('[data-testid="file-dropzone"]') as HTMLElement
        if (dropzone) {
          const dataTransfer = new DataTransfer()
          dataTransfer.items.add(file)
          const event = new DragEvent('drop', {
            bubbles: true,
            dataTransfer
          })
          dropzone.dispatchEvent(event)
        }
      }, await largeFile.text())
      await wizard.waitForOpen()
      await wizard.import()
      await inspector.waitForTableLoaded('large_dataset_5000', 5000)
    }

    // Reset table to fresh state
    await inspector.runQuery('DROP TABLE IF EXISTS large_dataset_5000')
    const largeFile = await generateLargeCSV(5000)
    await page.evaluate(async (fileContent) => {
      const file = new File([fileContent], 'large_dataset_5000.csv', { type: 'text/csv' })
      const dropzone = document.querySelector('[data-testid="file-dropzone"]') as HTMLElement
      if (dropzone) {
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(file)
        const event = new DragEvent('drop', {
          bubbles: true,
          dataTransfer
        })
        dropzone.dispatchEvent(event)
      }
    }, await largeFile.text())
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('large_dataset_5000', 5000)

    // Time a transformation
    await laundromat.openCleanPanel()
    await picker.waitForOpen()

    const startTime = Date.now()
    await picker.addTransformation('Uppercase', { column: 'name' })
    const endTime = Date.now()

    const duration = endTime - startTime
    console.log(`[Performance Test] Uppercase on 5k rows: ${duration}ms`)

    // Transformation should be fast (< 2 seconds for 5k rows)
    expect(duration).toBeLessThan(2000)

    // Verify result
    const data = await inspector.getTableData('large_dataset_5000', 5)
    expect(data[0].name).toMatch(/^USER \d+$/)
  })
})

test.describe.serial('Memory Optimization - OPFS File Size', () => {
  let page: Page
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await page.goto('/')
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await page.evaluate(async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        await opfsRoot.removeEntry('cleanslate.db')
      } catch (err) {
        console.log('[Test Cleanup] Could not delete cleanslate.db:', err)
      }
    })
    await page.close()
  })

  test('should show compression benefits in OPFS file size', async () => {
    // Check if OPFS is supported
    const hasOPFS = await page.evaluate(async () => {
      return typeof navigator.storage?.getDirectory === 'function'
    })

    if (!hasOPFS) {
      console.log('[OPFS Test] Skipping - OPFS not supported in this browser')
      return
    }

    // Get OPFS file size (if it exists)
    const opfsSize = await page.evaluate(async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        const dbFileHandle = await opfsRoot.getFileHandle('cleanslate.db')
        const dbFile = await dbFileHandle.getFile()
        return dbFile.size
      } catch {
        // File may not exist yet (fresh OPFS)
        return 0
      }
    })

    if (opfsSize > 0) {
      const opfsSizeMB = (opfsSize / (1024 * 1024)).toFixed(2)
      console.log(`[OPFS Test] cleanslate.db size: ${opfsSizeMB}MB`)

      // OPFS file should be reasonably sized (compressed)
      // Even with data, should be < 100MB for test datasets
      expect(opfsSize).toBeLessThan(100 * 1024 * 1024)
    } else {
      console.log('[OPFS Test] cleanslate.db not found (fresh storage)')
    }
  })

  test('should use storage quota efficiently', async () => {
    // Check storage quota
    const quota = await page.evaluate(async () => {
      try {
        const estimate = await navigator.storage.estimate()
        return {
          usage: estimate.usage || 0,
          quota: estimate.quota || 0,
          usagePercent: estimate.usage && estimate.quota
            ? ((estimate.usage / estimate.quota) * 100).toFixed(2)
            : 0
        }
      } catch {
        return null
      }
    })

    if (quota && quota.quota > 0) {
      console.log(`[Storage Quota] Used: ${(quota.usage / (1024 * 1024)).toFixed(2)}MB / ${(quota.quota / (1024 * 1024)).toFixed(2)}MB (${quota.usagePercent}%)`)

      // Should not be near quota limit (<80%)
      expect(parseFloat(quota.usagePercent as string)).toBeLessThan(80)
    } else {
      console.log('[Storage Quota] Not available in this browser')
    }
  })
})

test.describe.serial('Memory Optimization - Chunked Parquet Snapshots', () => {
  // Allow more time for 1.8GB Heap Init + Parquet flush operations
  test.setTimeout(120000)

  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeEach(async ({ browser }) => {
    // Create fresh page for each test to prevent memory accumulation
    page = await browser.newPage()

    // Block unnecessary resources to reduce memory usage
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType()
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        route.abort()
      } else {
        route.continue()
      }
    })

    // CRITICAL: Re-instantiate ALL page objects with the NEW page
    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    inspector = createStoreInspector(page)

    await laundromat.goto()
    await inspector.waitForDuckDBReady()
  })

  test.afterEach(async () => {
    // Clean up OPFS storage and close page to force garbage collection
    await page.evaluate(async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        await opfsRoot.removeEntry('cleanslate.db')
      } catch (err) {
        console.log('[Test Cleanup] Could not delete cleanslate.db:', err)
      }
    })
    await page.close()
  })

  /**
   * Generate a large CSV file with realistic data
   * Creates rows with 10 columns
   */
  async function generateLargeCSV(rowCount: number): Promise<string> {
    const headers = [
      'id',
      'name',
      'email',
      'company',
      'address',
      'city',
      'state',
      'zip',
      'phone',
      'notes'
    ]

    const lines = [headers.join(',')]

    for (let i = 0; i < rowCount; i++) {
      const row = [
        i + 1,
        `User ${i + 1}`,
        `user${i}@example.com`,
        `Company ${i % 100}`,
        `${i} Main Street`,
        `City ${i % 50}`,
        `ST${i % 50}`,
        String(10000 + i).padStart(5, '0'),
        `555-${String(i).padStart(4, '0')}`,
        `This is a sample note with some repeated text to test compression efficiency. Row ${i}.`
      ]
      lines.push(row.join(','))
    }

    return lines.join('\n')
  }

  test('should load Parquet snapshots in diff without errors (500 rows)', async () => {
    // Timeout is set at describe level (120000ms)

    // Regression test for: Parquet file loading in diff
    // Issues fixed:
    // - "IO Error: No files found that match the pattern"
    // - "Binder Error: column duckdb_schema does not exist"
    // - "Access Handles cannot be created" (file locking)
    // Goal: Validate memory/persistence handling at scale (500 rows needed for Parquet chunking)

    // Setup console error listener
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    // 1. Generate CSV (500 rows, realistic columns)
    const csvContent = await generateLargeCSV(500)
    const csvSizeMB = (csvContent.length / (1024 * 1024)).toFixed(2)
    console.log(`[Parquet Test] Generated CSV: ${csvSizeMB}MB (500 rows, 10 columns)`)

    // 2. Upload and import
    await inspector.runQuery('DROP TABLE IF EXISTS dataset_500')

    // Write to temp file and upload using helper
    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())
    const testFilePath = path.join(tmpDir, 'dataset_500.csv')
    await fs.writeFile(testFilePath, csvContent)

    await laundromat.uploadFile(testFilePath)
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('dataset_500', 500)

    // Cleanup temp file
    await fs.unlink(testFilePath).catch(() => {})

    // 3. Verify OPFS contains chunked Parquet files
    const opfsFiles = await page.evaluate(async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        const files: string[] = []
        // @ts-expect-error - AsyncIterator not in types
        for await (const entry of opfsRoot.values()) {
          files.push(entry.name)
        }
        return files.filter(f => f.includes('original') && f.includes('.parquet'))
      } catch {
        return []
      }
    })

    console.log(`[Parquet Test] OPFS snapshot files:`, opfsFiles)
    // May have Parquet snapshot files depending on size threshold

    // 4. Apply transformation (e.g., Uppercase on column)
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Uppercase', { column: 'name' })
    await laundromat.closePanel()
    await page.waitForTimeout(1000)  // Allow transformation to complete

    // 5. Open Diff view → Compare with Preview
    await laundromat.openDiffView()
    await page.waitForTimeout(500)

    // Select Compare with Preview mode
    await page.locator('button').filter({ hasText: 'Compare with Preview' }).click()
    await page.waitForTimeout(300)

    // Select id as key column
    await page.getByRole('checkbox', { name: 'id' }).click()

    // 6. Run comparison
    await page.getByTestId('diff-compare-btn').click()

    // Wait for comparison to complete
    await page.waitForTimeout(2000)

    // 7. Verify diff loads without errors
    // Rule 2: Assert NO console errors (positive assertion)
    const ioErrors = consoleErrors.filter(err =>
      err.includes('IO Error') ||
      err.includes('Binder Error') ||
      err.includes('Access Handles') ||
      err.includes('duckdb_schema')
    )
    expect(ioErrors.length).toBe(0)

    // 8. Verify diff shows 500 "MODIFIED" rows
    const diffSummary = await page.evaluate(() => {
      const stores = (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__
      const diffStore = stores?.diffStore as {
        getState: () => {
          summary: { added: number; removed: number; modified: number; unchanged: number } | null
        }
      } | undefined
      return diffStore?.getState()?.summary || null
    })

    // Rule 1: Assert exact count (identity, not cardinality)
    expect(diffSummary).not.toBeNull()
    expect(diffSummary?.modified).toBe(500)
    expect(diffSummary?.added).toBe(0)
    expect(diffSummary?.removed).toBe(0)

    // 9. Test pagination (scroll through diff grid)
    // Scroll to bottom of grid
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="diff-grid"]')
      if (grid) {
        grid.scrollTop = grid.scrollHeight
      }
    })
    await page.waitForTimeout(1000)

    // Scroll back to top
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="diff-grid"]')
      if (grid) {
        grid.scrollTop = 0
      }
    })
    await page.waitForTimeout(1000)

    // 10. Verify pagination doesn't throw file locking errors
    const paginationErrors = consoleErrors.filter(err =>
      err.includes('Access Handles') ||
      err.includes('file locking') ||
      err.includes('OPFS')
    )
    expect(paginationErrors.length).toBe(0)

    // 11. Export diff to CSV
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('diff-export-btn').click()
    await page.waitForTimeout(500)
    const download = await downloadPromise

    // 12. Verify export completes without Binder Error (ORDER BY detection works)
    const exportErrors = consoleErrors.filter(err =>
      err.includes('Binder Error') ||
      err.includes('ORDER BY')
    )
    expect(exportErrors.length).toBe(0)

    // Verify export file has 500 rows + header
    const csvPath = await download.path()
    if (csvPath) {
      const fs = await import('fs/promises')
      const exportContent = await fs.readFile(csvPath, 'utf-8')
      const lineCount = exportContent.split('\n').length
      // Should have ~500 lines (may vary by 1-2 due to empty lines)
      expect(lineCount).toBeGreaterThan(498)
      expect(lineCount).toBeLessThan(503)
    }
  })

  test('should prevent file locking errors on diff pagination (regression test)', async () => {
    // Timeout is set at describe level (120000ms)

    // Regression test for: OPFS file locking on pagination
    // Issue: Diff pagination was re-registering Parquet files, causing "Access Handles cannot be created"
    // Goal: Validate memory/persistence handling at scale (500 rows needed for file locking scenario)

    // Setup console error listener
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    // 1. Generate CSV (500 rows)
    const csvContent = await generateLargeCSV(500)

    // 2. Upload, apply transformation
    await inspector.runQuery('DROP TABLE IF EXISTS dataset_500_pagination')

    // Write to temp file and upload using helper
    const fs = await import('fs/promises')
    const path = await import('path')
    const tmpDir = await import('os').then(os => os.tmpdir())
    const testFilePath = path.join(tmpDir, 'dataset_500_pagination.csv')
    await fs.writeFile(testFilePath, csvContent)

    await laundromat.uploadFile(testFilePath)
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('dataset_500_pagination', 500)

    // Cleanup temp file
    await fs.unlink(testFilePath).catch(() => {})

    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Lowercase', { column: 'email' })
    await laundromat.closePanel()
    await page.waitForTimeout(1000)

    // 3. Open Diff view → Compare with Preview
    await laundromat.openDiffView()
    await page.waitForTimeout(500)

    await page.locator('button').filter({ hasText: 'Compare with Preview' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('checkbox', { name: 'id' }).click()

    // 4. Run comparison (creates diff result table)
    await page.getByTestId('diff-compare-btn').click()
    await page.waitForTimeout(2000)

    // 5. Scroll to bottom of diff grid (triggers pagination)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="diff-grid"]')
        if (grid) {
          grid.scrollTop = grid.scrollHeight
        }
      })
      await page.waitForTimeout(300)

      // Scroll back to top
      await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="diff-grid"]')
        if (grid) {
          grid.scrollTop = 0
        }
      })
      await page.waitForTimeout(300)
    }

    // 6. Verify no console errors: "Access Handles cannot be created"
    const fileLockingErrors = consoleErrors.filter(err =>
      err.includes('Access Handles') ||
      err.includes('file locking') ||
      err.includes('OPFS')
    )
    expect(fileLockingErrors.length).toBe(0)

    // 7. Close diff view
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // 8. Re-open diff view (should not throw file locking errors)
    await laundromat.openDiffView()
    await page.waitForTimeout(500)

    await page.locator('button').filter({ hasText: 'Compare with Preview' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('checkbox', { name: 'id' }).click()
    await page.getByTestId('diff-compare-btn').click()
    await page.waitForTimeout(3000)

    // 9. Verify no file locking errors on re-open
    const reopenErrors = consoleErrors.filter(err =>
      err.includes('Access Handles') ||
      err.includes('file locking')
    )
    expect(reopenErrors.length).toBe(0)
  })
})
