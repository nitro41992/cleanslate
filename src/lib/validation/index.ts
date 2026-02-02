/**
 * Semantic Validation for Transform Operations
 *
 * This module provides live validation for transforms to prevent
 * no-op operations and provide helpful feedback to users.
 *
 * Architecture:
 * - Level 2 module (depends only on duckdb, not on stores or components)
 * - Each transform type has a dedicated validator in validators/
 * - transform-validator.ts provides the facade for routing
 */

export type {
  SemanticValidationStatus,
  SemanticValidationResult,
  ValidatorContext,
  TransformValidator,
} from './types'

export {
  validateTransform,
  hasValidator,
  getValidatedTransforms,
} from './transform-validator'

// Individual validators (for testing/direct use)
export { validateRemoveDuplicates } from './validators/remove-duplicates'
export { validateDateColumn } from './validators/date-column'
export { validateFillDown } from './validators/fill-down'
export { validateReplace } from './validators/replace'
export { validateCastType } from './validators/cast-type'
