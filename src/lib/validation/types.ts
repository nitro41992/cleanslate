/**
 * Semantic validation for transform operations
 * Validates whether a transform will have meaningful effect on data
 */

export type SemanticValidationStatus =
  | 'valid'     // Transform will make changes
  | 'no_op'     // Transform would have no effect (e.g., no duplicates to remove)
  | 'invalid'   // Transform cannot be applied (e.g., no parseable dates)
  | 'warning'   // Transform will work but with caveats (e.g., some values will become NULL)
  | 'pending'   // Validation in progress
  | 'skipped'   // Validation not applicable for this transform

export interface SemanticValidationResult {
  /** Current validation status */
  status: SemanticValidationStatus
  /** User-facing explanation of the validation result */
  message: string
  /** Number of rows that will be affected by the transform */
  affectedCount?: number
  /** Machine-readable code for testing and programmatic handling */
  code: string
}

export interface ValidatorContext {
  tableName: string
  column?: string
  params?: Record<string, unknown>
}

export type TransformValidator = (
  context: ValidatorContext
) => Promise<SemanticValidationResult>
