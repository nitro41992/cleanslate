import { useRef, useMemo, useState, useCallback, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, Layers } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ClusterCard } from './ClusterCard'
import { cn } from '@/lib/utils'
import type { ValueCluster } from '@/types'
import type { ClusterFilter } from '@/stores/standardizerStore'

interface ClusterListProps {
  clusters: ValueCluster[]
  filter: ClusterFilter
  searchQuery: string
  expandedId: string | null
  onFilterChange: (filter: ClusterFilter) => void
  onSearchChange: (query: string) => void
  onToggleExpand: (clusterId: string) => void
  onToggleValue: (clusterId: string, valueId: string) => void
  onSetMaster: (clusterId: string, valueId: string) => void
  onSelectAll: (clusterId: string) => void
  onDeselectAll: (clusterId: string) => void
  onSelectAllClusters: () => void
  onDeselectAllClusters: () => void
  onSetReplacement?: (clusterId: string, valueId: string, replacement: string | null) => void
  onReviewClick?: (clusterId: string) => void
}

export function ClusterList({
  clusters,
  filter,
  searchQuery,
  expandedId,
  onFilterChange,
  onSearchChange,
  onToggleExpand,
  onToggleValue,
  onSetMaster,
  onSelectAll,
  onDeselectAll,
  onSelectAllClusters,
  onDeselectAllClusters,
  onSetReplacement,
  onReviewClick,
}: ClusterListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  // Track expand/collapse for smooth virtualizer repositioning
  const [isAnimating, setIsAnimating] = useState(false)
  const animationTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    return () => clearTimeout(animationTimer.current)
  }, [])

  const handleToggleExpand = useCallback((clusterId: string) => {
    setIsAnimating(true)
    onToggleExpand(clusterId)
    clearTimeout(animationTimer.current)
    animationTimer.current = setTimeout(() => setIsAnimating(false), 180)
  }, [onToggleExpand])

  // Filter clusters
  const filteredClusters = useMemo(() => {
    let result = clusters

    // Filter by type
    if (filter === 'actionable') {
      // Actionable = clusters with >1 values (can be standardized)
      result = result.filter((c) => c.values.length > 1)
    } else if (filter === 'all') {
      // "All" shows non-actionable clusters (single values, already unique)
      result = result.filter((c) => c.values.length === 1)
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter((cluster) =>
        cluster.values.some((v) => v.value.toLowerCase().includes(query)) ||
        cluster.clusterKey.toLowerCase().includes(query)
      )
    }

    return result
  }, [clusters, filter, searchQuery])

  // Virtualizer for performance
  const virtualizer = useVirtualizer({
    count: filteredClusters.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const cluster = filteredClusters[index]
      const isExpanded = cluster.id === expandedId
      // Base height + expanded content + gap
      if (isExpanded && cluster.values.length > 1) {
        return 80 + 32 + cluster.values.length * 44 + 8
      }
      return 80 + 8
    },
    paddingStart: 16,
    paddingEnd: 16,
    overscan: 5,
  })

  const actionableCount = clusters.filter((c) => c.values.length > 1).length
  const uniqueCount = clusters.filter((c) => c.values.length === 1).length

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="p-4 border-b border-border/50 space-y-3 bg-card">
        {/* Filter Tabs - Pill style */}
        <div className="flex gap-2 items-center">
          <div className="flex gap-1 p-1 rounded-lg bg-muted border border-border">
            <button
              type="button"
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-all duration-200',
                filter === 'all'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
              onClick={() => onFilterChange('all')}
              data-testid="filter-all"
            >
              Distinct ({uniqueCount})
            </button>
            <button
              type="button"
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-all duration-200',
                filter === 'actionable'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
              onClick={() => onFilterChange('actionable')}
              data-testid="filter-actionable"
            >
              Clusters ({actionableCount})
            </button>
          </div>

          {/* Bulk Selection */}
          <div className="flex-1" />
          <button
            className="px-3 py-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
            onClick={onSelectAllClusters}
            data-testid="select-all-clusters"
          >
            Select All
          </button>
          <span className="text-muted-foreground/30">·</span>
          <button
            className="px-3 py-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
            onClick={onDeselectAllClusters}
            data-testid="deselect-all-clusters"
          >
            Deselect All
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 p-1 rounded bg-muted">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <Input
            type="text"
            placeholder="Search values..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10 bg-muted border-border focus:border-primary focus:ring-primary/50"
            data-testid="cluster-search"
          />
        </div>
      </div>

      {/* Contextual hint for Distinct tab */}
      {filter === 'all' && filteredClusters.length > 0 && (
        <div className="px-4 py-2 bg-muted/20">
          <p className="text-[11px] text-muted-foreground/60 tracking-wide">
            Click any value to set a replacement — like find & replace, one value at a time.
          </p>
        </div>
      )}

      {/* Cluster List */}
      {filteredClusters.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-3">
            <div className="mx-auto w-12 h-12 rounded-xl bg-muted border border-border flex items-center justify-center">
              <Layers className="w-6 h-6 text-muted-foreground/60" />
            </div>
            <div>
              <p className="text-sm font-medium">No clusters found</p>
              {searchQuery && (
                <p className="text-xs text-muted-foreground/70 mt-1">Try adjusting your search</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div key={`${filter}-${filteredClusters.length}`} ref={parentRef} className="flex-1 overflow-auto">
          <div className="px-4">
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const cluster = filteredClusters[virtualRow.index]
                return (
                  <div
                    key={cluster.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      ...(isAnimating && { transition: 'transform 150ms ease-out' }),
                      paddingBottom: 8,
                    }}
                  >
                    <ClusterCard
                      cluster={cluster}
                      isExpanded={expandedId === cluster.id}
                      onToggleExpand={() => handleToggleExpand(cluster.id)}
                      onToggleValue={(valueId) => onToggleValue(cluster.id, valueId)}
                      onSetMaster={(valueId) => onSetMaster(cluster.id, valueId)}
                      onSelectAll={() => onSelectAll(cluster.id)}
                      onDeselectAll={() => onDeselectAll(cluster.id)}
                      onSetReplacement={onSetReplacement ? (valueId, replacement) => onSetReplacement(cluster.id, valueId, replacement) : undefined}
                      onReviewClick={onReviewClick ? () => onReviewClick(cluster.id) : undefined}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
