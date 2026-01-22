import { ChevronDown, ChevronRight, Star, Link2 } from 'lucide-react'
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

  return (
    <div
      className={cn(
        'border rounded-lg overflow-hidden transition-all',
        isExpanded ? 'border-primary/50 bg-card' : 'border-border/50 bg-card/50',
        hasSelectedChanges && 'ring-1 ring-primary/30'
      )}
      data-testid="cluster-card"
    >
      {/* Header */}
      <button
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/50 transition-colors"
        onClick={onToggleExpand}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}

        <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />

        <span className="font-medium text-sm truncate flex-1 text-left">
          "{cluster.masterValue || '(empty)'}"
        </span>

        <Badge variant="secondary" className="shrink-0">
          {cluster.values.length} value{cluster.values.length !== 1 ? 's' : ''}
        </Badge>

        {hasSelectedChanges && (
          <Badge variant="default" className="shrink-0">
            {cluster.selectedCount} to change
          </Badge>
        )}
      </button>

      {/* Master Value Summary */}
      <div className="px-4 pb-2 text-xs text-muted-foreground">
        {cluster.values.find((v) => v.isMaster)?.count.toLocaleString()} rows
        {cluster.values.length > 1 && ` · ${cluster.values.length - 1} variation${cluster.values.length > 2 ? 's' : ''}`}
      </div>

      {/* Expanded Content */}
      {isExpanded && isActionable && (
        <div className="border-t">
          {/* Bulk Actions */}
          <div className="px-4 py-2 flex items-center gap-2 bg-muted/30 text-xs">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onSelectAll()
              }}
              className="text-primary hover:underline"
            >
              Select all
            </button>
            <span className="text-muted-foreground">|</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDeselectAll()
              }}
              className="text-primary hover:underline"
            >
              Deselect all
            </button>
          </div>

          {/* Value List */}
          <div className="divide-y divide-border/50">
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
      )}

      {/* Single Value Indicator */}
      {isExpanded && !isActionable && (
        <div className="px-4 py-3 text-sm text-muted-foreground border-t bg-muted/20">
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
}

function ClusterValueRow({ value, onToggle, onSetMaster }: ClusterValueRowProps) {
  return (
    <div
      className={cn(
        'px-4 py-2 flex items-center gap-3',
        value.isMaster && 'bg-primary/5'
      )}
    >
      <Checkbox
        checked={value.isSelected}
        onCheckedChange={onToggle}
        disabled={value.isMaster}
        data-testid={`cluster-value-checkbox-${value.id}`}
      />

      <span
        className={cn(
          'flex-1 text-sm truncate',
          value.isMaster && 'font-medium'
        )}
        title={value.value}
      >
        "{value.value}"
      </span>

      <Badge variant="outline" className="shrink-0 text-xs">
        {value.count.toLocaleString()}
      </Badge>

      {value.isMaster ? (
        <Badge className="shrink-0 gap-1 bg-amber-500/20 text-amber-600 hover:bg-amber-500/30 border-amber-500/30">
          <Star className="h-3 w-3" />
          Master
        </Badge>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
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
