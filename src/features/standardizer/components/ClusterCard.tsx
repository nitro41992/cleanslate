import { ChevronDown, ChevronRight, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
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
}

export function ClusterCard({
  cluster,
  isExpanded,
  onToggleExpand,
  onToggleValue,
  onSetMaster,
  onSelectAll,
  onDeselectAll,
}: ClusterCardProps) {
  const isActionable = cluster.values.length > 1
  const hasSelectedChanges = cluster.selectedCount > 0
  const selectedCount = cluster.values.filter((v) => v.isSelected).length
  const selectableCount = cluster.values.filter((v) => !v.isMaster).length
  const selectionRatio = selectableCount > 0 ? selectedCount / selectableCount : 0

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
      <button
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted transition-colors"
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
          "{cluster.masterValue || '(empty)'}"
        </span>

        <Badge
          variant="secondary"
          className="shrink-0 bg-muted text-muted-foreground border-0"
        >
          {cluster.values.length} value{cluster.values.length !== 1 ? 's' : ''}
        </Badge>

        {hasSelectedChanges && (
          <Badge
            variant="default"
            className="shrink-0 bg-primary/20 text-primary border border-primary hover:bg-primary/30"
          >
            {cluster.selectedCount} to change
          </Badge>
        )}
      </button>

      {/* Master Value Summary */}
      <div className="px-4 pb-3 text-xs text-muted-foreground flex items-center gap-2">
        <span className="tabular-nums">
          {cluster.values.find((v) => v.isMaster)?.count.toLocaleString()} rows
        </span>
        {cluster.values.length > 1 && (
          <>
            <span className="text-border">·</span>
            <span>{cluster.values.length - 1} variation{cluster.values.length > 2 ? 's' : ''}</span>
          </>
        )}
      </div>

      {/* Expanded Content */}
      {isExpanded && isActionable && (
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
                animationDelay={index * 30}
              />
            ))}
          </div>
        </div>
      )}

      {/* Single Value Indicator */}
      {isExpanded && !isActionable && (
        <div className="px-4 py-3 text-sm text-muted-foreground border-t border-border bg-muted">
          This cluster has only one unique value - no standardization needed.
        </div>
      )}
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
        'animate-in fade-in-0 slide-in-from-left-1',
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
        "{value.value}"
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
