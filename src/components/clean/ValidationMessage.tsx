/**
 * ValidationMessage Component
 *
 * Displays inline validation feedback for transform operations.
 * Color-coded by severity:
 * - Red for no_op/invalid (blocking)
 * - Yellow for warning (non-blocking)
 * - Green for valid with affected count (informational)
 */

import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { SemanticValidationResult } from '@/lib/validation'

interface ValidationMessageProps {
  result: SemanticValidationResult
  /** Show affected count for valid results (default: false) */
  showValidCount?: boolean
}

export function ValidationMessage({
  result,
  showValidCount = false,
}: ValidationMessageProps) {
  // Don't render for skipped/pending states
  if (result.status === 'skipped' || result.status === 'pending') {
    return null
  }

  // Don't render valid state unless showValidCount is true
  if (result.status === 'valid' && !showValidCount) {
    return null
  }

  // Determine styling based on status
  const config = getStatusConfig(result.status)

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs ${config.containerClass}`}
      role="alert"
      data-testid="validation-message"
      data-status={result.status}
    >
      <config.Icon className={`w-3.5 h-3.5 shrink-0 ${config.iconClass}`} />
      <span className={config.textClass}>{result.message}</span>
    </div>
  )
}

type StatusConfig = {
  Icon: typeof AlertCircle
  containerClass: string
  iconClass: string
  textClass: string
}

function getStatusConfig(status: SemanticValidationResult['status']): StatusConfig {
  switch (status) {
    case 'no_op':
    case 'invalid':
      return {
        Icon: AlertCircle,
        containerClass: 'bg-destructive/10 border border-destructive/20',
        iconClass: 'text-destructive',
        textClass: 'text-destructive',
      }

    case 'warning':
      return {
        Icon: AlertTriangle,
        containerClass: 'bg-amber-500/10 border border-amber-500/20',
        iconClass: 'text-amber-500',
        textClass: 'text-amber-500',
      }

    case 'valid':
    default:
      return {
        Icon: CheckCircle2,
        containerClass: 'bg-green-500/10 border border-green-500/20',
        iconClass: 'text-green-500',
        textClass: 'text-green-500',
      }
  }
}
