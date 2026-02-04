import { ChevronUp, ChevronDown, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { RecipeStep } from '@/types'
import { formatRecipeValue } from '@/lib/recipe/format-helpers'
import { getTransformDefinition, getStepIcon, getStepLabel } from '@/lib/recipe/transform-lookup'

interface RecipeStepCardProps {
  step: RecipeStep
  index: number
  totalSteps: number
  isHighlighted?: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onToggleEnabled: () => void
  onDelete: () => void
}

/**
 * RecipeStepCard - Displays a single recipe step with all parameters
 *
 * Key features:
 * - Shows ALL parameters from transform definition, not just stored values
 * - Empty values displayed as "(empty)" in muted italic
 * - Pipeline-style visual with step number and connector
 */
export function RecipeStepCard({
  step,
  index,
  totalSteps,
  isHighlighted = false,
  onMoveUp,
  onMoveDown,
  onToggleEnabled,
  onDelete,
}: RecipeStepCardProps) {
  // Get transform definition for full parameter info
  const transform = getTransformDefinition(step)
  const icon = getStepIcon(step)
  const label = getStepLabel(step)

  // Get human-readable label for a parameter
  const getParamLabel = (name: string): string => {
    // First check if transform has param definition with label
    const paramDef = transform?.params?.find((p) => p.name === name)
    if (paramDef?.label) {
      return paramDef.label
    }
    // Fallback: convert camelCase to Title Case
    return name
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (s) => s.toUpperCase())
      .trim()
  }

  // Build complete parameter list from transform definition
  const getAllParams = (): { name: string; label: string; value: unknown }[] => {
    // If no params defined in transform, or params array is empty, use stored params
    if (!transform?.params || transform.params.length === 0) {
      if (step.params && Object.keys(step.params).length > 0) {
        return Object.entries(step.params).map(([name, value]) => ({
          name,
          label: getParamLabel(name),
          value,
        }))
      }
      return []
    }

    // Return ALL defined params, using stored value or default
    return transform.params.map((paramDef) => {
      const storedValue = step.params?.[paramDef.name]
      const value = storedValue !== undefined ? storedValue : paramDef.default ?? ''

      return {
        name: paramDef.name,
        label: paramDef.label,
        value,
      }
    })
  }

  const params = getAllParams()
  const isFirst = index === 0
  const isLast = index === totalSteps - 1

  return (
    <div className="relative">
      {/* Pipeline connector from previous step */}
      {!isFirst && (
        <div className="absolute left-4 -top-1 w-0.5 h-2 bg-border/60" />
      )}

      {/* Main card */}
      <div
        className={cn(
          'relative rounded-lg border transition-all duration-200',
          step.enabled
            ? 'bg-card border-border/60'
            : 'bg-muted/30 border-border/30 opacity-60',
          isHighlighted && 'ring-2 ring-primary/60 ring-offset-1 ring-offset-background animate-in fade-in slide-in-from-bottom-2 duration-300'
        )}
      >
        {/* Step indicator dot */}
        <div
          className={cn(
            'absolute left-4 top-3 w-2 h-2 rounded-full',
            step.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
          )}
        />

        {/* Header row */}
        <div className="flex items-start gap-2 pl-8 pr-2 pt-2 pb-1">
          {/* Step number and icon */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted-foreground font-medium">
              {index + 1}.
            </span>
            <span className="text-base">{icon}</span>
          </div>

          {/* Label with nested column */}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm leading-tight">
              {label}
            </div>
            {step.column && (
              <div className="text-xs text-muted-foreground pl-3 flex items-center gap-1">
                <span className="text-muted-foreground/60">↳</span>
                <span className="truncate">{step.column}</span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onMoveUp}
                  disabled={isFirst}
                  aria-label="Move step up"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Move up</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onMoveDown}
                  disabled={isLast}
                  aria-label="Move step down"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Move down</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onToggleEnabled}
                  aria-label={step.enabled ? 'Disable step' : 'Enable step'}
                  aria-pressed={step.enabled}
                >
                  {step.enabled ? (
                    <ToggleRight className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <ToggleLeft className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {step.enabled ? 'Disable step' : 'Enable step'}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                  aria-label="Delete step"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Delete step</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Parameters section */}
        {params.length > 0 && (
          <div className="pl-8 pr-3 pb-2 pt-1 border-t border-border/30 mt-1">
            <div className="space-y-1">
              {params.map(({ name, label, value }) => (
                <div
                  key={name}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="text-muted-foreground min-w-[80px] shrink-0">
                    {label}:
                  </span>
                  <span className="text-foreground break-all">
                    {formatRecipeValue(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Pipeline connector to next step */}
      {!isLast && (
        <div className="absolute left-4 -bottom-1 w-0.5 h-2 bg-border/60" />
      )}
    </div>
  )
}
