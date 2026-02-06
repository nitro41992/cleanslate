import { useState, useRef, useEffect } from 'react'
import { ChevronRight, Star, Pencil, X, ArrowRight, Eye } from 'lucide-react'
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
        'rounded-xl transition-all duration-200',
        isExpanded
          ? 'bg-card ring-1 ring-border/60 shadow-sm'
          : 'bg-card/60 hover:bg-card',
        hasSelectedChanges && !isExpanded && 'ring-1 ring-primary/20 bg-card'
      )}
      data-testid="cluster-card"
    >
      {/* Header */}
      <div className="w-full px-4 py-3 flex items-center gap-3">
        <button
          className="flex items-center gap-3 flex-1 min-w-0"
          onClick={onToggleExpand}
        >
          <ChevronRight className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-150 text-muted-foreground',
            isExpanded && 'rotate-90 text-foreground'
          )} />

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
                <p>{selectedVariationRowCount.toLocaleString()} rows will be replaced</p>
              ) : (
                <p>{selectableCount} variations available to replace</p>
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

      {/* Expandable Content */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-150 ease-out',
          isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden min-h-0">
          {/* Bulk Actions */}
          <div className="mx-3 px-1 py-2 flex items-center gap-3 text-xs border-t border-border/20">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onSelectAll()
              }}
              className="text-primary hover:text-primary/80 transition-colors font-medium"
            >
              Select all
            </button>
            <span className="text-muted-foreground/30">·</span>
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

            {selectedCount > 0 && (
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">
                {selectedCount === selectableCount ? 'All selected' : `${selectedCount} of ${selectableCount}`}
              </span>
            )}
          </div>

          {/* Value List */}
          <div className="px-2 pb-2 space-y-px">
            {cluster.values.map((value) => (
              <ClusterValueRow
                key={value.id}
                value={value}
                onToggle={() => onToggleValue(value.id)}
                onSetMaster={() => onSetMaster(value.id)}
              />
            ))}
          </div>
        </div>
      </div>
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
  // Check if customReplacement is defined (not undefined) to allow empty string replacements
  const hasReplacement = value?.customReplacement !== undefined && value.customReplacement !== value.value
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
      // Use customReplacement if defined (including empty string), otherwise fall back to original value
      setEditValue(value?.customReplacement !== undefined ? value.customReplacement : (value?.value || ''))
    }
    setIsEditing(open)
  }

  const handleConfirm = () => {
    if (onSetReplacement && value) {
      const trimmed = editValue.trim()
      // Set null only if same as original (no change)
      // Allow empty string as a valid replacement to blank out values
      if (trimmed === value.value) {
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
        'rounded-lg overflow-hidden transition-all duration-200',
        hasReplacement
          ? 'bg-primary/5 border border-primary/20 border-l-2 border-l-primary'
          : 'bg-transparent border border-border/40 hover:border-border',
      )}
      data-testid="cluster-card"
    >
      <div className="px-3 py-2 flex items-center gap-2.5">
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
                    title={value?.customReplacement || '(empty)'}
                  >
                    {value?.customReplacement || '(empty)'}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="text-sm text-foreground/80 truncate group-hover:text-foreground transition-colors"
                    title={value?.value || '(empty)'}
                  >
                    {value?.value || '(empty)'}
                  </span>
                  <Pencil className="h-3 w-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-72 p-4 shadow-lg shadow-primary/5 ring-1 ring-primary/20"
            align="start"
            sideOffset={8}
          >
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Replace with
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <Input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter replacement value"
                className="h-9 text-sm bg-background"
                data-testid="unique-value-replacement-input"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1 h-8 text-xs text-muted-foreground"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs"
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
        <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0 font-mono">
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
}

function ClusterValueRow({ value, onToggle, onSetMaster }: ClusterValueRowProps) {
  return (
    <div
      className={cn(
        'group px-3 py-2 flex items-center gap-3 rounded-lg transition-colors',
        value.isMaster
          ? 'bg-amber-500/[0.06]'
          : 'hover:bg-muted/50'
      )}
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
          className="shrink-0 gap-1 bg-transparent border-amber-300 dark:border-amber-700/50 text-amber-600 dark:text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-900/40"
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
