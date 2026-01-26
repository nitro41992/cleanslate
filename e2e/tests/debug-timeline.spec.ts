import { test, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test('debug timeline state and executor', async ({ browser }) => {
  const page = await browser.newPage()
  const laundromat = new LaundromatPage(page)
  const wizard = new IngestionWizardPage(page)
  const picker = new TransformationPickerPage(page)
  await laundromat.goto()
  const inspector = createStoreInspector(page)
  await inspector.waitForDuckDBReady()

  // Load data
  await inspector.runQuery('DROP TABLE IF EXISTS whitespace_data')
  await laundromat.uploadFile(getFixturePath('whitespace-data.csv'))
  await wizard.waitForOpen()
  await wizard.import()
  await inspector.waitForTableLoaded('whitespace_data', 3)

  console.log('=== After load ===')
  let pos = await inspector.getTimelinePosition()
  console.log('Position:', pos)

  // Apply transform
  await laundromat.openCleanPanel()
  await picker.waitForOpen()
  await picker.addTransformation('Trim Whitespace', { column: 'name' })
  await laundromat.closePanel()

  console.log('=== After transform ===')
  pos = await inspector.getTimelinePosition()
  console.log('Position:', pos)

  // Undo
  await page.locator('body').click()
  await page.keyboard.press('Control+z')

  // Wait for undo operation to complete by polling timeline position
  await expect.poll(
    async () => {
      const position = await inspector.getTimelinePosition()
      return position.current
    },
    { timeout: 5000, intervals: [100, 250] }
  ).toBeLessThan(pos.current) // Position should decrease after undo

  console.log('=== After undo ===')
  pos = await inspector.getTimelinePosition()
  console.log('Position:', pos)
  console.log('Future states (calculated):', pos.total - pos.current - 1)

  // Check via executor
  const executorResult = await page.evaluate(() => {
    // Access the global commands module
    const commandsModule = (window as any).__CLEANSLATE_COMMANDS__
    const stores = (window as any).__CLEANSLATE_STORES__
    
    if (!stores?.tableStore) return { error: 'no tableStore' }
    const tableState = stores.tableStore.getState()
    const activeTableId = tableState?.activeTableId
    
    if (!commandsModule) {
      return { 
        error: 'no commands module exposed',
        activeTableId,
        hasTimelineStore: !!stores?.timelineStore
      }
    }
    
    const executor = commandsModule.getCommandExecutor?.()
    if (!executor) return { error: 'no executor', activeTableId }
    
    const count = executor.getFutureStatesCount?.(activeTableId)
    return { 
      executorFutureStates: count,
      activeTableId,
      hasMethod: !!executor.getFutureStatesCount
    }
  })
  console.log('Executor result:', JSON.stringify(executorResult, null, 2))

  await page.close()
})
