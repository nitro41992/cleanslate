/**
 * Recipe Step Status Detection
 *
 * Determines if a recipe step has already been applied to the current table
 * by analyzing the timeline command history.
 */

import { useTimelineStore } from '@/stores/timelineStore'
import type { RecipeStep } from '@/types'

export type StepApplicationStatus =
  | 'not_applied'
  | 'already_applied'
  | 'modified_since'

/**
 * Commands that modify row structure (affect all columns).
 * When these run, any previously-applied column-specific transforms
 * are invalidated because the row context has changed.
 */
const STRUCTURE_MODIFYING_COMMANDS = new Set([
  'remove_duplicates',
  'filter_empty',
  'data:delete_row',
  'data:insert_row',
  'match:merge',
])

/**
 * Extracts the transform type from a step or command type.
 * Examples:
 *   'transform:trim' -> 'trim'
 *   'scrub:hash' -> 'hash'
 *   'standardize:apply' -> 'apply'
 */
function extractTransformType(type: string): string {
  return type.replace(/^(transform|scrub|standardize):/, '')
}

/**
 * Check if a recipe step has already been applied to a table.
 *
 * @param step - The recipe step to check
 * @param tableId - The table ID to check against
 * @param columnMapping - Optional mapping of recipe columns to table columns
 * @returns The application status of the step
 */
export function getStepApplicationStatus(
  step: RecipeStep,
  tableId: string,
  columnMapping: Record<string, string> = {}
): StepApplicationStatus {
  const timeline = useTimelineStore.getState().getTimeline(tableId)
  if (!timeline) return 'not_applied'

  // Map the recipe column name to the actual table column name
  const mappedColumn = step.column
    ? columnMapping[step.column] || step.column
    : undefined

  // Extract transform type from step.type
  const transformType = extractTransformType(step.type)

  // Search timeline for a matching command (only active commands, not undone)
  const matchIndex = timeline.commands.findIndex((cmd, idx) => {
    // Skip undone commands (those after currentPosition)
    if (idx > timeline.currentPosition) return false

    const params = cmd.params as unknown as Record<string, unknown>

    // For transform commands, check transformationType from nested params
    const cmdTransformType = params.transformationType as string | undefined
    if (cmdTransformType !== transformType) return false

    // Check column match (if the step targets a specific column)
    if (mappedColumn) {
      const cmdColumn = params.column as string | undefined
      if (cmdColumn !== mappedColumn) return false
    }

    // For commands with params, check if they match
    // This handles cases like replace (find/replace values) or pad_zeros (length)
    if (step.params && Object.keys(step.params).length > 0) {
      const cmdParams = params.params as Record<string, unknown> | undefined
      if (!cmdParams) return false

      // Check all step params exist in command params
      for (const [key, value] of Object.entries(step.params)) {
        if (cmdParams[key] !== value) return false
      }
    }

    return true
  })

  if (matchIndex === -1) return 'not_applied'

  // Check if the column was modified after the match,
  // OR if a structure-modifying command ran (which invalidates ALL column-specific steps)
  const laterModification = timeline.commands
    .slice(matchIndex + 1, timeline.currentPosition + 1)
    .some((cmd) => {
      const p = cmd.params as unknown as Record<string, unknown>
      const cmdTransformType = p.transformationType as string | undefined

      // Structure-modifying commands invalidate ALL column-specific steps
      if (cmdTransformType && STRUCTURE_MODIFYING_COMMANDS.has(cmdTransformType)) {
        return true
      }

      // Also check the full command type for data operations
      if (STRUCTURE_MODIFYING_COMMANDS.has(cmd.commandType)) {
        return true
      }

      // Column-specific modification
      if (mappedColumn && p.column === mappedColumn) {
        return true
      }

      return false
    })

  return laterModification ? 'modified_since' : 'already_applied'
}

/**
 * Check multiple steps at once (for efficiency).
 *
 * @param steps - Array of recipe steps to check
 * @param tableId - The table ID to check against
 * @param columnMapping - Optional mapping of recipe columns to table columns
 * @returns Map of step IDs to their application status
 */
export function getStepApplicationStatuses(
  steps: RecipeStep[],
  tableId: string,
  columnMapping: Record<string, string> = {}
): Map<string, StepApplicationStatus> {
  const result = new Map<string, StepApplicationStatus>()

  for (const step of steps) {
    result.set(step.id, getStepApplicationStatus(step, tableId, columnMapping))
  }

  return result
}
