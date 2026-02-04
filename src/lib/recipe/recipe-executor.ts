/**
 * Recipe Executor
 *
 * Executes recipe steps sequentially against a table.
 * Each step is executed as a separate command (separate undo entry).
 */

import type { Recipe, RecipeStep, ScrubMethod } from '@/types'
import type { ColumnMapping, RecipeExecutionProgress } from '@/stores/recipeStore'
import { createCommand, getCommandExecutor } from '@/lib/commands'
import type { CommandType } from '@/lib/commands'
import { applyMappingToParams } from './column-matcher'
import { getTableColumns, query } from '@/lib/duckdb'
import { useTableStore } from '@/stores/tableStore'

/**
 * Execute a recipe against a table.
 *
 * @param recipe - The recipe to execute
 * @param tableId - Target table ID
 * @param tableName - Target table name
 * @param columnMapping - Mapping from recipe columns to table columns
 * @param onProgress - Progress callback
 * @param secret - Optional secret for hash operations (prompted at apply time, not stored in recipe)
 */
export async function executeRecipe(
  recipe: Recipe,
  tableId: string,
  tableName: string,
  columnMapping: ColumnMapping,
  onProgress?: (progress: RecipeExecutionProgress) => void,
  secret?: string
): Promise<void> {
  const enabledSteps = recipe.steps.filter((s) => s.enabled)

  if (enabledSteps.length === 0) {
    throw new Error('Recipe has no enabled steps')
  }

  console.log(`[Recipe] Executing "${recipe.name}" with ${enabledSteps.length} steps`)

  const executor = getCommandExecutor()

  for (let i = 0; i < enabledSteps.length; i++) {
    const step = enabledSteps[i]

    // Report progress
    if (onProgress) {
      onProgress({
        currentStep: i + 1,
        totalSteps: enabledSteps.length,
        currentStepLabel: step.label || formatStepLabel(step),
      })
    }

    try {
      await executeStep(step, tableId, tableName, columnMapping, executor, secret)
      console.log(`[Recipe] Step ${i + 1}/${enabledSteps.length} completed: ${step.label}`)
    } catch (err) {
      console.error(`[Recipe] Step ${i + 1} failed:`, err)
      throw new Error(`Step ${i + 1} failed: ${step.label}\n${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  console.log(`[Recipe] Completed "${recipe.name}"`)
}

/**
 * Execute a single recipe step.
 */
async function executeStep(
  step: RecipeStep,
  tableId: string,
  tableName: string,
  columnMapping: ColumnMapping,
  executor: ReturnType<typeof getCommandExecutor>,
  secret?: string
): Promise<void> {
  // Validate command type
  const commandType = step.type as CommandType

  // Build command params with column mapping applied
  const mappedColumn = step.column ? columnMapping[step.column] || step.column : undefined
  const mappedParams = step.params ? applyMappingToParams(step.params, columnMapping) : {}

  // Handle backward compatibility for standardize:apply commands
  // Older recipes may not have the algorithm field
  if (commandType === 'standardize:apply' && !mappedParams.algorithm) {
    mappedParams.algorithm = 'fingerprint' // Default to fingerprint algorithm
  }

  // Inject secret for scrub commands that need it
  // The secret is provided at apply time, not stored in recipes for security
  if (secret && (commandType === 'scrub:batch' || commandType === 'scrub:hash')) {
    mappedParams.secret = secret
  }

  // Create the command
  const command = createCommand(commandType, {
    tableId,
    column: mappedColumn,
    ...mappedParams,
  })

  // Execute
  const result = await executor.execute(command)

  if (!result.success) {
    throw new Error(result.error || 'Command execution failed')
  }

  // Register key map table if this was a scrub:batch step with generateKeyMap
  // Note: addTable() makes the new table active, but we want to stay on the main table
  if (commandType === 'scrub:batch' && mappedParams.generateKeyMap) {
    const keyMapTableName = `${tableName}_keymap`
    try {
      const columns = await getTableColumns(keyMapTableName)
      const rowCountResult = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${keyMapTableName}"`
      )
      const rowCount = Number(rowCountResult[0]?.count ?? 0)
      const store = useTableStore.getState()
      store.addTable(keyMapTableName, columns, rowCount)
      // Restore focus to the original table (don't trigger freeze/thaw)
      store.setActiveTable(tableId)
      console.log(`[Recipe] Registered key map table: ${keyMapTableName} with ${rowCount} rows`)
    } catch (error) {
      console.error('[Recipe] Failed to register key map table:', error)
      // Don't fail the whole recipe - the key map was created in DuckDB
    }
  }
}

/**
 * Format a step label for display.
 */
function formatStepLabel(step: RecipeStep): string {
  const type = step.type.replace(/^(transform|scrub|standardize):/, '')
  if (step.column) {
    return `${type} → ${step.column}`
  }
  return type
}

/**
 * Validate that a recipe can be executed.
 * Checks that all command types are registered.
 *
 * @param recipe - The recipe to validate
 * @returns Validation result with errors if any
 */
export function validateRecipe(recipe: Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!recipe.name) {
    errors.push('Recipe name is required')
  }

  if (!recipe.steps || recipe.steps.length === 0) {
    errors.push('Recipe must have at least one step')
  }

  // Check that all command types are valid
  const { isCommandRegistered } = require('@/lib/commands')
  for (const step of recipe.steps) {
    if (!isCommandRegistered(step.type)) {
      errors.push(`Unknown command type: ${step.type}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Get a preview of what a recipe will do.
 * Returns a human-readable description of each step.
 *
 * @param recipe - The recipe to preview
 * @param columnMapping - Optional column mapping
 * @returns Array of step descriptions
 */
export function previewRecipe(recipe: Recipe, columnMapping?: ColumnMapping): string[] {
  return recipe.steps.map((step, index) => {
    const mappedColumn = step.column
      ? columnMapping?.[step.column] || step.column
      : undefined

    const type = step.type.replace(/^(transform|scrub|standardize):/, '')
    const enabledStr = step.enabled ? '' : ' (disabled)'

    if (mappedColumn) {
      return `${index + 1}. ${type} on "${mappedColumn}"${enabledStr}`
    }
    return `${index + 1}. ${type}${enabledStr}`
  })
}

/**
 * Check if a recipe has steps that require a secret (hash operations).
 * Used to determine if a secret prompt is needed before execution.
 *
 * @param recipe - The recipe to check
 * @returns true if any enabled step requires a secret
 */
export function recipeRequiresSecret(recipe: Recipe): boolean {
  return recipe.steps.some((step) => {
    if (!step.enabled) return false
    // Check scrub:batch steps for hash rules
    if (step.type === 'scrub:batch') {
      const rules = step.params?.rules as Array<{ column: string; method: ScrubMethod }> | undefined
      return rules?.some((r) => r.method === 'hash') ?? false
    }
    // Check individual scrub:hash steps
    if (step.type === 'scrub:hash') return true
    return false
  })
}
