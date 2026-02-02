import { validateCastType as validateCastTypeOriginal } from '@/lib/transformations'
import type { SemanticValidationResult, ValidatorContext } from '../types'

/**
 * Validate cast_type transform
 * Wraps existing validateCastType from transformations.ts
 */
export async function validateCastType(
  context: ValidatorContext
): Promise<SemanticValidationResult> {
  const { tableName, column, params } = context

  if (!column) {
    return {
      status: 'invalid',
      message: 'No column selected',
      code: 'NO_COLUMN',
    }
  }

  const targetType = params?.targetType as string | undefined

  if (!targetType) {
    return {
      status: 'skipped',
      message: '',
      code: 'NO_TARGET_TYPE',
    }
  }

  const result = await validateCastTypeOriginal(tableName, column, targetType)

  if (result.totalRows === 0) {
    return {
      status: 'no_op',
      message: 'Column has no values to convert',
      affectedCount: 0,
      code: 'EMPTY_COLUMN',
    }
  }

  if (result.failCount > 0) {
    const failPct = Math.round(result.failurePercentage)
    return {
      status: 'warning',
      message: `${result.failCount} of ${result.totalRows} values (${failPct}%) will become NULL`,
      affectedCount: result.successCount,
      code: 'PARTIAL_CAST',
    }
  }

  return {
    status: 'valid',
    message: `All ${result.totalRows} values will be converted`,
    affectedCount: result.totalRows,
    code: 'ALL_CASTABLE',
  }
}
