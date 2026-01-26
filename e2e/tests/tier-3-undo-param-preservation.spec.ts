import { test, expect, Page } from '@playwright/test'
import { LaundromatPage } from '../page-objects/laundromat.page'
import { IngestionWizardPage } from '../page-objects/ingestion-wizard.page'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { createStoreInspector, StoreInspector } from '../helpers/store-inspector'
import { getFixturePath } from '../helpers/file-upload'

test.describe.serial('Bug: Tier 3 Undo Parameter Preservation', () => {
  let page: Page
  let laundromat: LaundromatPage
  let wizard: IngestionWizardPage
  let picker: TransformationPickerPage
  let inspector: StoreInspector

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()

    // Capture browser console logs
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[UNDO DEBUG]') || text.includes('[Executor]')) {
        console.log(`[BROWSER] ${text}`)
      }
    })

    laundromat = new LaundromatPage(page)
    wizard = new IngestionWizardPage(page)
    picker = new TransformationPickerPage(page)
    await laundromat.goto()
    inspector = createStoreInspector(page)
    await inspector.waitForDuckDBReady()
  })

  test.afterAll(async () => {
    await inspector.runQuery('DROP TABLE IF EXISTS undo_param_test')
    await page.close()
  })

  test('pad zeros params should persist after unrelated rename undo', async () => {
    // Setup: Import test data
    await inspector.runQuery('DROP TABLE IF EXISTS undo_param_test')
    await laundromat.uploadFile(getFixturePath('undo-param-test.csv'))
    await wizard.waitForOpen()
    await wizard.import()
    await inspector.waitForTableLoaded('undo_param_test', 3)

    // Step 1: Apply pad zeros with length=9 to account_number
    await laundromat.openCleanPanel()
    await picker.waitForOpen()
    await picker.addTransformation('Pad Zeros', {
      column: 'account_number',
      params: { length: '9' }  // CRITICAL: Use 9, not default 5
    })

    // Wait for transformation to complete
    await expect.poll(async () => {
      const rows = await inspector.getTableData('undo_param_test')
      return rows[0]?.account_number
    }, { timeout: 10000 }).toBe('000000123')

    // Verify all rows have 9 digits
    const dataBefore = await inspector.getTableData('undo_param_test')
    console.log('[TEST] Data after pad zeros:', dataBefore)
    expect(dataBefore[0].account_number).toBe('000000123')
    expect(dataBefore[1].account_number).toBe('000000456')
    expect(dataBefore[2].account_number).toBe('000000789')

    // Verify timeline has correct params
    const timelineBefore = await inspector.getAuditEntries()
    const padEntry = timelineBefore.find(e => e.action.includes('Pad'))
    console.log('[TEST] Pad zeros audit entry:', padEntry)

    // Step 2: Rename DIFFERENT column (name → customer_name)
    await picker.addTransformation('Rename Column', {
      column: 'name',
      params: { 'New column name': 'customer_name' }
    })

    // Verify rename worked
    await expect.poll(async () => {
      const schema = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'undo_param_test' ORDER BY column_name"
      )
      return schema.map(c => c.column_name)
    }, { timeout: 5000 }).toContain('customer_name')

    // Close picker
    await laundromat.closePanel()

    // Step 3: Undo the rename
    console.log('[TEST] Clicking Undo button to undo rename...')

    // Verify data is still correct before undo
    const dataBeforeUndo = await inspector.runQuery(
      'SELECT account_number FROM undo_param_test ORDER BY id'
    )
    console.log('[TEST] Data BEFORE undo (should be 9 zeros):', dataBeforeUndo)

    await laundromat.clickUndo()

    // Give it a moment to complete
    await page.waitForTimeout(500)

    // Wait for undo to complete (column 'name' should exist again)
    await expect.poll(async () => {
      const schema = await inspector.runQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'undo_param_test' ORDER BY column_name"
      )
      return schema.map(c => c.column_name)
    }, { timeout: 5000 }).toContain('name')

    // CRITICAL ASSERTIONS: Verify data still has 9 zeros (NOT 5!)

    // Layer 1: Direct DuckDB query (bypass UI entirely)
    const dataAfterUndo = await inspector.runQuery(
      'SELECT account_number FROM undo_param_test ORDER BY id'
    )
    console.log('[TEST] Data after undo (direct SQL):', dataAfterUndo)

    // Assert exact values (identity, not just length)
    expect(dataAfterUndo[0].account_number).toBe('000000123')  // NOT '00123'
    expect(dataAfterUndo[1].account_number).toBe('000000456')  // NOT '00456'
    expect(dataAfterUndo[2].account_number).toBe('000000789')  // NOT '00789'

    // Layer 2: Verify timeline still has correct params
    const commandExecutor = await page.evaluate(() => {
      const { getCommandExecutor } = window as any
      const executor = getCommandExecutor()
      const timeline = executor.getTimeline('undo_param_test')
      return {
        position: timeline?.position,
        commands: timeline?.commands.map((c: any) => ({
          type: c.commandType,
          params: c.params,
          tier: c.tier
        }))
      }
    })
    console.log('[TEST] Timeline state:', JSON.stringify(commandExecutor, null, 2))

    const padCommand = commandExecutor.commands.find((c: any) =>
      c.type === 'transform:pad_zeros'
    )
    expect(padCommand).toBeDefined()
    expect(padCommand.params.length).toBe(9)  // NOT 5 or undefined

    // Layer 3: Verify via getTableData (uses same path as grid)
    const gridData = await inspector.getTableData('undo_param_test')
    console.log('[TEST] Data via getTableData (grid path):', gridData)
    expect(gridData[0].account_number).toBe('000000123')
  })
})
