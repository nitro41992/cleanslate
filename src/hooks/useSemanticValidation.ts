/**
 * useSemanticValidation Hook
 *
 * Provides live semantic validation for transform operations.
 * Debounced (300ms) to avoid excessive DB queries while user is selecting options.
 *
 * Returns validation status that can be used to:
 * - Disable the Apply button (no_op, invalid)
 * - Show inline feedback messages
 * - Indicate affected row counts
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import {
  validateTransform,
  hasValidator,
  type SemanticValidationResult,
} from '@/lib/validation'

const DEBOUNCE_MS = 300

/**
 * Default result for initial/skip states
 */
const DEFAULT_RESULT: SemanticValidationResult = {
  status: 'skipped',
  message: '',
  code: 'INITIAL',
}

/**
 * Pending result shown during debounce/query
 */
const PENDING_RESULT: SemanticValidationResult = {
  status: 'pending',
  message: '',
  code: 'VALIDATING',
}

interface UseSemanticValidationOptions {
  /** Whether to run validation (default: true) */
  enabled?: boolean
}

/**
 * Hook for live semantic validation of transforms
 *
 * @param tableName - Name of the table being transformed
 * @param transformType - Type of transform (e.g., 'remove_duplicates')
 * @param column - Selected column (if applicable)
 * @param params - Transform-specific parameters
 * @param options - Hook options
 * @returns Validation result with status, message, and affected count
 */
export function useSemanticValidation(
  tableName: string | undefined,
  transformType: string | undefined,
  column: string | undefined,
  params: Record<string, string> | undefined,
  options: UseSemanticValidationOptions = {}
): SemanticValidationResult {
  const { enabled = true } = options

  const [result, setResult] = useState<SemanticValidationResult>(DEFAULT_RESULT)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Stable params key for dependency tracking
  const paramsKey = useMemo(() => JSON.stringify(params ?? {}), [params])

  // Check if validation should run
  const shouldValidate = useMemo(() => {
    if (!enabled) return false
    if (!tableName) return false
    if (!transformType) return false
    if (!hasValidator(transformType)) return false
    return true
  }, [enabled, tableName, transformType])

  useEffect(() => {
    // Clear existing debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    // Skip validation if requirements not met
    if (!shouldValidate || !tableName || !transformType) {
      setResult(DEFAULT_RESULT)
      return
    }

    // Show pending state
    setResult(PENDING_RESULT)

    // Debounce validation query
    debounceRef.current = setTimeout(async () => {
      try {
        const validationResult = await validateTransform(
          tableName,
          transformType,
          column,
          params
        )
        setResult(validationResult)
      } catch (error) {
        console.error('[useSemanticValidation] Error:', error)
        // Don't block on validation errors - return skipped
        setResult({
          status: 'skipped',
          message: '',
          code: 'VALIDATION_ERROR',
        })
      }
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [shouldValidate, tableName, transformType, column, paramsKey, params])

  return result
}
