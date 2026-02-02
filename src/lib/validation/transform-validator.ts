import type { SemanticValidationResult, ValidatorContext, TransformValidator } from './types'
import { validateRemoveDuplicates } from './validators/remove-duplicates'
import { validateDateColumn } from './validators/date-column'
import { validateFillDown } from './validators/fill-down'
import { validateReplace } from './validators/replace'
import { validateCastType } from './validators/cast-type'

/**
 * Registry mapping transform types to their validators
 * Only transforms that need semantic validation are listed here
 */
const validatorRegistry: Record<string, TransformValidator> = {
  // Duplicate removal
  'remove_duplicates': validateRemoveDuplicates,

  // Date transforms (all use the same validator)
  'standardize_date': validateDateColumn,
  'calculate_age': validateDateColumn,
  'year_only': validateDateColumn,

  // Fill operations
  'fill_down': validateFillDown,

  // Text operations
  'replace': validateReplace,

  // Type conversion
  'cast_type': validateCastType,
}

/**
 * Validate a transform operation before applying
 *
 * @param tableName - Name of the table
 * @param transformType - Type of transform (e.g., 'remove_duplicates', 'standardize_date')
 * @param column - Selected column (if applicable)
 * @param params - Transform-specific parameters
 * @returns Validation result with status and message
 */
export async function validateTransform(
  tableName: string,
  transformType: string,
  column?: string,
  params?: Record<string, unknown>
): Promise<SemanticValidationResult> {
  const validator = validatorRegistry[transformType]

  // No validator for this transform type - skip validation
  if (!validator) {
    return {
      status: 'skipped',
      message: '',
      code: 'NO_VALIDATOR',
    }
  }

  const context: ValidatorContext = {
    tableName,
    column,
    params,
  }

  try {
    return await validator(context)
  } catch (error) {
    // Validation failed due to error - don't block the transform
    console.error(`[Validation] Error validating ${transformType}:`, error)
    return {
      status: 'skipped',
      message: '',
      code: 'VALIDATION_ERROR',
    }
  }
}

/**
 * Check if a transform type has semantic validation
 */
export function hasValidator(transformType: string): boolean {
  return transformType in validatorRegistry
}

/**
 * Get list of transform types that have validators
 */
export function getValidatedTransforms(): string[] {
  return Object.keys(validatorRegistry)
}
