import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Star, Check, Pencil, X, ArrowRight, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ValueCluster, ClusterValue } from '@/types'

interface ClusterCardProps {
  cluster: ValueCluster
  isExpanded: boolean
  onToggleExpand: () => void
  onToggleValue: (valueId: string) => void
  onSetMaster: (valueId: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onSetReplacement?: (valueId: string, replacement: string | null) => void
  onReviewClick?: () => void
}

export function ClusterCard({
  cluster,
  isExpanded,
  onToggleExpand,
  onToggleValue,
  onSetMaster,
  onSelectAll,
  onDeselectAll,
  onSetReplacement,
  onReviewClick,
}: ClusterCardProps) {
  const isActionable = cluster.values.length > 1
  const hasSelectedChanges = cluster.selectedCount > 0
  // Fix: Exclude master from selectedCount to match selectableCount calculation
  const selectedCount = cluster.values.filter((v) => v.isSelected && !v.isMaster).length
  const selectableCount = cluster.values.filter((v) => !v.isMaster).length
  const selectionRatio = selectableCount > 0 ? selectedCount / selectableCount : 0

  // Calculate row counts for the badge
  const masterRowCount = cluster.values.find((v) => v.isMaster)?.count ?? 0
  const selectedVariationRowCount = cluster.values
    .filter((v) => v.isSelected && !v.isMaster)
    .reduce((sum, v) => sum + v.count, 0)

  // Render compact card for unique (single-value) clusters
  if (!isActionable) {
    return <UniqueValueCard cluster={cluster} onSetReplacement={onSetReplacement} />
  }

  // Render full actionable card for clusters with multiple values
  return (
    <div
      className={cn(
        'rounded-xl overflow-hidden transition-all duration-200',
        'bg-card',
        'border border-border',
        hasSelectedChanges && 'shadow-sm'
      )}
      data-testid="cluster-card"
    >
      {/* Header */}
      <div className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted transition-colors">
        <button
          className="flex items-center gap-3 flex-1 min-w-0"
          onClick={onToggleExpand}
        >
          <div className={cn(
            'p-1.5 rounded-md transition-colors',
            isExpanded ? 'bg-accent' : 'bg-muted'
          )}>
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-primary shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
          </div>

          <span className="font-medium text-sm truncate flex-1 text-left">
            {cluster.masterValue || '(empty)'}
          </span>
        </button>

        {/* Combined badge with tooltip */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <Badge
                  variant="secondary"
                  className="tabular-nums bg-muted text-muted-foreground border-0"
                >
                  {masterRowCount.toLocaleString()} → {hasSelectedChanges ? selectedVariationRowCount.toLocaleString() : selectableCount}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[250px]">
              <p>{masterRowCount.toLocaleString()} rows remain as "{cluster.masterValue || '(empty)'}"</p>
              {hasSelectedChanges ? (
                <p>{selectedVariationRowCount.toLocaleString()} rows will be standardized</p>
              ) : (
                <p>{selectableCount} variations available to standardize</p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Review button */}
        {onReviewClick && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onReviewClick()
            }}
            data-testid={`review-cluster-${cluster.id}`}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-border">
          {/* Bulk Actions with Progress Bar */}
          <div className="px-4 py-2.5 flex items-center gap-3 bg-muted text-xs">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onSelectAll()
              }}
              className="text-primary hover:text-primary/80 transition-colors font-medium"
            >
              Select all
            </button>
            <span className="text-border/60">|</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDeselectAll()
              }}
              className="text-primary hover:text-primary/80 transition-colors font-medium"
            >
              Clear
            </button>

            <div className="flex-1" />

            {/* Selection Progress Micro-visualization */}
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${selectionRatio * 100}%` }}
                />
              </div>
              <span className="text-muted-foreground tabular-nums">
                {selectedCount}/{selectableCount}
              </span>
            </div>
          </div>

          {/* Value List */}
          <div className="divide-y divide-border">
            {cluster.values.map((value, index) => (
              <ClusterValueRow
                key={value.id}
                value={value}
                onToggle={() => onToggleValue(value.id)}
                onSetMaster={() => onSetMaster(value.id)}
                animationDelay={index * 10}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Compact card for unique (single-value) clusters.
 * Users can click to add a custom replacement for the value.
 */
function UniqueValueCard({
  cluster,
  onSetReplacement,
}: {
  cluster: ValueCluster
  onSetReplacement?: (valueId: string, replacement: string | null) => void
}) {
  const value = cluster.values[0]
  const hasReplacement = value?.customReplacement && value.customReplacement !== value.value
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value?.customReplacement || '')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when popover opens
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setEditValue(value?.customReplacement || value?.value || '')
    }
    setIsEditing(open)
  }

  const handleConfirm = () => {
    if (onSetReplacement && value) {
      const trimmed = editValue.trim()
      // Set null if empty or same as original
      if (!trimmed || trimmed === value.value) {
        onSetReplacement(value.id, null)
      } else {
        onSetReplacement(value.id, trimmed)
      }
    }
    setIsEditing(false)
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onSetReplacement && value) {
      onSetReplacement(value.id, null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setIsEditing(false)
    }
  }

  return (
    <div
      className={cn(
        'rounded-lg overflow-hidden',
        hasReplacement ? 'bg-primary/5' : 'bg-muted/30',
        hasReplacement ? 'border border-primary/30' : 'border border-border/50',
      )}
      data-testid="cluster-card"
    >
      <div className="px-3 py-2 flex items-center gap-2.5">
        {/* Status indicator */}
        {hasReplacement ? (
          <Checkbox
            checked={true}
            disabled
            className="h-4 w-4 shrink-0"
            data-testid={`unique-value-checkbox-${value?.id}`}
          />
        ) : (
          <div className="p-1 rounded bg-emerald-500/10 shrink-0">
            <Check className="h-3 w-3 text-emerald-500" />
          </div>
        )}

        {/* Value display with edit popover */}
        <Popover open={isEditing} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'group flex-1 flex items-center gap-2 min-w-0 text-left',
                'hover:bg-muted/50 rounded px-1 -mx-1 py-0.5 transition-colors'
              )}
            >
              {hasReplacement ? (
                <>
                  <span
                    className="text-sm text-muted-foreground/60 line-through truncate"
                    title={value?.value || '(empty)'}
                  >
                    {value?.value || '(empty)'}
                  </span>
                  <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                  <span
                    className="text-sm text-primary font-medium truncate"
                    title={value?.customReplacement}
                  >
                    {value?.customReplacement}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="text-sm text-muted-foreground truncate"
                    title={value?.value || '(empty)'}
                  >
                    {value?.value || '(empty)'}
                  </span>
                  <Pencil className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Replace with:
              </label>
              <Input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter replacement value"
                className="h-8 text-sm"
                data-testid="unique-value-replacement-input"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-xs"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-7 text-xs"
                  onClick={handleConfirm}
                  data-testid="unique-value-replacement-confirm"
                >
                  Confirm
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* Clear button when replacement is set */}
        {hasReplacement && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleClear}
            data-testid={`unique-value-clear-${value?.id}`}
          >
            <X className="h-3 w-3" />
          </Button>
        )}

        {/* Row count */}
        <span className="text-xs text-muted-foreground/70 tabular-nums shrink-0">
          {value?.count.toLocaleString() ?? 0} rows
        </span>
      </div>
    </div>
  )
}

interface ClusterValueRowProps {
  value: ClusterValue
  onToggle: () => void
  onSetMaster: () => void
  animationDelay?: number
}

function ClusterValueRow({ value, onToggle, onSetMaster, animationDelay = 0 }: ClusterValueRowProps) {
  return (
    <div
      className={cn(
        'group px-4 py-2.5 flex items-center gap-3 transition-colors',
        'animate-in fade-in-0 slide-in-from-left-1 duration-75',
        value.isMaster
          ? 'bg-amber-950/40'
          : 'hover:bg-muted'
      )}
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      <Checkbox
        checked={value.isSelected}
        onCheckedChange={onToggle}
        disabled={value.isMaster}
        className={cn(
          'transition-all',
          value.isMaster && 'opacity-40'
        )}
        data-testid={`cluster-value-checkbox-${value.id}`}
      />

      <span
        className={cn(
          'flex-1 text-sm truncate',
          value.isMaster && 'font-medium text-amber-600 dark:text-amber-500'
        )}
        title={value.value}
      >
        {value.value}
      </span>

      <Badge
        variant="outline"
        className="shrink-0 text-xs tabular-nums bg-transparent border-border"
      >
        {value.count.toLocaleString()}
      </Badge>

      {value.isMaster ? (
        <Badge
          variant="outline"
          className="shrink-0 gap-1 bg-transparent border-amber-700/50 text-amber-600 dark:text-amber-500 hover:bg-amber-900/40"
        >
          <Star className="h-3 w-3 fill-amber-500/30" />
          Master
        </Badge>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 text-xs transition-all duration-200',
            'opacity-0 group-hover:opacity-100',
            'text-muted-foreground hover:text-primary hover:bg-accent'
          )}
          onClick={(e) => {
            e.stopPropagation()
            onSetMaster()
          }}
          data-testid={`set-master-${value.id}`}
        >
          Set Master
        </Button>
      )}
    </div>
  )
}
