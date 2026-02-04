/**
 * Transform Lookup Utilities
 *
 * Maps command types to TRANSFORMATIONS definitions for consistent display.
 */

import { TRANSFORMATIONS } from '@/lib/transformations'
import type { RecipeStep } from '@/types'

/**
 * Maps command type IDs (after prefix stripping) to TRANSFORMATIONS IDs.
 * Needed when command naming doesn't match transform ID.
 *
 * Example: 'scrub:batch' → strip prefix → 'batch' → map to 'privacy_batch'
 */
const COMMAND_TO_TRANSFORM_ID: Record<string, string> = {
  batch: 'privacy_batch', // scrub:batch → privacy_batch transform
}

/**
 * Get the transform ID from a step type, handling command-to-transform mapping.
 */
export function getTransformId(stepType: string): string {
  const rawId = stepType.replace(/^(transform|scrub|standardize):/, '')
  return COMMAND_TO_TRANSFORM_ID[rawId] || rawId
}

/**
 * Get the TRANSFORMATIONS entry for a recipe step.
 */
export function getTransformDefinition(step: RecipeStep) {
  const transformId = getTransformId(step.type)
  return TRANSFORMATIONS.find((t) => t.id === transformId)
}

/**
 * Get the icon for a recipe step.
 */
export function getStepIcon(step: RecipeStep): string {
  const transform = getTransformDefinition(step)
  return transform?.icon || '🔄'
}

/**
 * Get the label for a recipe step.
 */
export function getStepLabel(step: RecipeStep): string {
  const transform = getTransformDefinition(step)
  const rawId = step.type.replace(/^(transform|scrub|standardize):/, '')
  return transform?.label || rawId
}

/**
 * Get the category from step type (Transform, Scrub, Smart Replace).
 */
export function getStepCategory(stepType: string): string {
  if (stepType.startsWith('scrub:')) return 'Scrub'
  if (stepType.startsWith('standardize:')) return 'Smart Replace'
  return 'Transform'
}

/**
 * Get a user-friendly type display (Category: Label format).
 */
export function getReadableStepType(step: RecipeStep): string {
  const category = getStepCategory(step.type)
  const label = getStepLabel(step)
  return `${category}: ${label}`
}
