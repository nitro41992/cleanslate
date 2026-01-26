/**
 * Parameter Preservation Test Helpers
 *
 * Utilities for testing that command parameters survive the undo/redo
 * timeline replay system. When a Tier 3 command is undone, the timeline
 * replays all commands from a snapshot. Custom parameters (like length=9
 * for pad_zeros) must be preserved through this replay.
 *
 * CRITICAL: Use SQL polling pattern - never rely on UI assertions alone.
 */

import { expect } from '@playwright/test'
import { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import { LaundromatPage } from '../page-objects/laundromat.page'
import type { StoreInspector } from './store-inspector'

/**
 * Configuration for a transformation to apply and verify
 */
export interface TransformConfig {
  /** Display name of the transformation (e.g., 'Pad Zeros') */
  name: string
  /** Target column name */
  column: string
  /** Custom parameters (e.g., { 'Length': '9' }) */
  params?: Record<string, string>
  /** Select dropdown parameters (e.g., { 'Mode': 'Split' }) */
  selectParams?: Record<string, string>
}

/**
 * Apply a transformation and trigger timeline replay via unrelated Tier 3 undo.
 *
 * This is the core pattern for testing parameter preservation:
 * 1. Apply target transform with non-default params
 * 2. Apply unrelated transform (causes snapshot)
 * 3. Undo the unrelated transform (triggers replay from snapshot)
 *
 * After calling this, use SQL queries to verify the target transform
 * still uses the correct parameters.
 *
 * @param picker - TransformationPickerPage instance
 * @param laundromat - LaundromatPage instance
 * @param inspector - StoreInspector instance
 * @param targetTransform - The transformation to test
 * @param tableName - Name of the test table
 */
export async function applyAndTriggerReplay(
  picker: TransformationPickerPage,
  laundromat: LaundromatPage,
  inspector: StoreInspector,
  targetTransform: TransformConfig,
  tableName: string
): Promise<void> {
  // Step 1: Apply the target transformation with custom params
  await picker.addTransformation(targetTransform.name, {
    column: targetTransform.column,
    params: targetTransform.params,
    selectParams: targetTransform.selectParams,
  })

  // Wait for transformation to complete by polling the database
  await expect.poll(async () => {
    const tables = await inspector.getTables()
    return tables.some(t => t.name === tableName)
  }, { timeout: 10000 }).toBe(true)

  // Step 2: Apply unrelated Tier 2 transform (Rename Column)
  // This is a Tier 2 command that creates timeline state without heavy snapshots
  const tempColumnName = `__temp_col_${Date.now()}`
  await picker.addTransformation('Rename Column', {
    column: targetTransform.column === 'id' ? 'name' : 'id',
    params: { 'New column name': tempColumnName }
  })

  // Wait for rename to complete
  await expect.poll(async () => {
    const schema = await inspector.runQuery(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY column_name`
    )
    return schema.map(c => c.column_name).includes(tempColumnName)
  }, { timeout: 5000 }).toBe(true)

  // Step 3: Close panel and trigger undo
  await laundromat.closePanel()

  // Wait for panel to close
  await picker.page.getByTestId('panel-clean').waitFor({ state: 'hidden', timeout: 5000 })

  // Step 4: Undo the rename (triggers timeline replay)
  await laundromat.clickUndo()

  // Wait for undo to complete by checking the column name reverted
  await expect.poll(async () => {
    const schema = await inspector.runQuery(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY column_name`
    )
    return !schema.map(c => c.column_name).includes(tempColumnName)
  }, { timeout: 10000 }).toBe(true)
}

/**
 * Validate that parameters were preserved after replay.
 *
 * Uses SQL query as the primary validation layer (most reliable).
 * Timeline params are secondary validation.
 *
 * @param inspector - StoreInspector instance
 * @param tableName - Name of the test table
 * @param sqlAssertion - SQL-based validation function
 */
export async function validateParamPreservation(
  inspector: StoreInspector,
  tableName: string,
  sqlAssertion: () => Promise<void>
): Promise<void> {
  // Layer 1: SQL validation (primary - most reliable)
  await sqlAssertion()

  // Layer 2: Verify table still exists and has data
  const tables = await inspector.getTables()
  const table = tables.find(t => t.name === tableName)
  expect(table).toBeDefined()
  expect(table!.rowCount).toBeGreaterThan(0)
}

/**
 * Test case definition for parameterized testing
 */
export interface ParamTestCase {
  /** Command display name */
  command: string
  /** Target column */
  column: string
  /** Custom params to apply */
  params?: Record<string, string>
  /** Select dropdown params */
  selectParams?: Record<string, string>
  /** SQL check function - returns true if params were preserved */
  sqlCheck: (row: Record<string, unknown>) => boolean
  /** Description of what the sqlCheck verifies */
  checkDescription: string
}

/**
 * Parameterized test cases for commands with custom parameters.
 *
 * Each case defines:
 * - The command to apply
 * - Non-default params to use
 * - SQL check to verify params were preserved after replay
 */
export const PARAM_PRESERVATION_TEST_CASES: ParamTestCase[] = [
  {
    command: 'Pad Zeros',
    column: 'account_number',
    params: { 'Length': '9' },
    sqlCheck: (row) => String(row.account_number).length === 9,
    checkDescription: 'padded to 9 digits'
  },
  {
    command: 'Replace',
    column: 'status',
    params: { 'Find': 'active', 'Replace with': 'ACTIVE' },
    sqlCheck: (row) => row.status === 'ACTIVE' || row.status !== 'active',
    checkDescription: 'replaced "active" with "ACTIVE"'
  },
  // Add more test cases as needed
]

/**
 * Get a subset of test cases by command name
 */
export function getTestCasesForCommands(commands: string[]): ParamTestCase[] {
  return PARAM_PRESERVATION_TEST_CASES.filter(tc =>
    commands.includes(tc.command)
  )
}

/**
 * Create a simple test data CSV content for param preservation tests
 */
export function getParamPreservationTestData(): string {
  return `id,name,account_number,status,amount
1,Alice,123,active,100.50
2,Bob,456,inactive,200.75
3,Charlie,789,active,300.25`
}
