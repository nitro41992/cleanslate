import { useRef, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ClusterCard } from './ClusterCard'
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
}: ClusterListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  // Filter clusters
  const filteredClusters = useMemo(() => {
    let result = clusters

    // Filter by actionable
    if (filter === 'actionable') {
      result = result.filter((c) => c.values.length > 1)
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
      // Base height + expanded content
      if (isExpanded && cluster.values.length > 1) {
        return 80 + 32 + cluster.values.length * 44
      }
      return 80
    },
    overscan: 5,
  })

  const actionableCount = clusters.filter((c) => c.values.length > 1).length

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="p-4 border-b space-y-3">
        {/* Filter Tabs */}
        <div className="flex gap-2">
          <button
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-muted/80 text-muted-foreground'
            }`}
            onClick={() => onFilterChange('all')}
            data-testid="filter-all"
          >
            All ({clusters.length})
          </button>
          <button
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              filter === 'actionable'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-muted/80 text-muted-foreground'
            }`}
            onClick={() => onFilterChange('actionable')}
            data-testid="filter-actionable"
          >
            Actionable ({actionableCount})
          </button>

          {/* Bulk Selection */}
          <div className="flex-1" />
          <button
            className="px-3 py-1.5 text-sm text-primary hover:underline"
            onClick={onSelectAllClusters}
            data-testid="select-all-clusters"
          >
            Select All
          </button>
          <span className="text-muted-foreground py-1.5">|</span>
          <button
            className="px-3 py-1.5 text-sm text-primary hover:underline"
            onClick={onDeselectAllClusters}
            data-testid="deselect-all-clusters"
          >
            Deselect All
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search values..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
            data-testid="cluster-search"
          />
        </div>
      </div>

      {/* Cluster List */}
      {filteredClusters.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-sm">No clusters found</p>
            {searchQuery && (
              <p className="text-xs mt-1">Try adjusting your search</p>
            )}
          </div>
        </div>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto">
          <div
            className="p-4"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
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
                    paddingBottom: '8px',
                  }}
                >
                  <ClusterCard
                    cluster={cluster}
                    isExpanded={expandedId === cluster.id}
                    onToggleExpand={() => onToggleExpand(cluster.id)}
                    onToggleValue={(valueId) => onToggleValue(cluster.id, valueId)}
                    onSetMaster={(valueId) => onSetMaster(cluster.id, valueId)}
                    onSelectAll={() => onSelectAll(cluster.id)}
                    onDeselectAll={() => onDeselectAll(cluster.id)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
