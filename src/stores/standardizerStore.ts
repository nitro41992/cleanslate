import { create } from 'zustand'
import type { ValueCluster, ClusteringAlgorithm } from '@/types'

export type ClusterFilter = 'all' | 'actionable'

interface StandardizerState {
  // View state
  isViewOpen: boolean

  // Table configuration
  tableId: string | null
  tableName: string | null
  columnName: string | null
  algorithm: ClusteringAlgorithm

  // Clusters and filtering
  clusters: ValueCluster[]
  filter: ClusterFilter
  searchQuery: string
  expandedId: string | null

  // Processing state
  isAnalyzing: boolean
  progress: number
  progressPhase: 'idle' | 'validating' | 'clustering' | 'complete'
  currentChunk: number
  totalChunks: number

  // Validation state
  validationError: string | null
  uniqueValueCount: number

  // Statistics
  stats: {
    totalClusters: number
    actionableClusters: number
    totalValues: number
    selectedValues: number
  }

  // Record preview drawer state
  previewClusterId: string | null
  previewRecords: Record<string, unknown>[] | null
  previewLoading: boolean
}

interface StandardizerActions {
  // View management
  openView: () => void
  closeView: () => void

  // Table/column configuration
  setTable: (tableId: string | null, tableName: string | null) => void
  setColumn: (columnName: string | null) => void
  setAlgorithm: (algorithm: ClusteringAlgorithm) => void

  // Clusters management
  setClusters: (clusters: ValueCluster[]) => void
  setFilter: (filter: ClusterFilter) => void
  setSearchQuery: (query: string) => void
  setExpandedId: (id: string | null) => void

  // Value selection within clusters
  toggleValueSelection: (clusterId: string, valueId: string) => void
  selectAllInCluster: (clusterId: string) => void
  deselectAllInCluster: (clusterId: string) => void
  setMasterValue: (clusterId: string, valueId: string) => void

  // Bulk selection across all clusters
  selectAllClusters: () => void
  deselectAllClusters: () => void

  // Processing state
  setIsAnalyzing: (analyzing: boolean) => void
  setProgress: (progress: number, phase: 'idle' | 'validating' | 'clustering' | 'complete', currentChunk?: number, totalChunks?: number) => void
  resetProgress: () => void

  // Validation
  setValidationError: (error: string | null) => void
  setUniqueValueCount: (count: number) => void

  // Custom replacement for unique values
  setCustomReplacement: (clusterId: string, valueId: string, replacement: string | null) => void

  // Record preview drawer
  setPreviewCluster: (clusterId: string | null) => void
  setPreviewRecords: (records: Record<string, unknown>[] | null) => void
  setPreviewLoading: (loading: boolean) => void
  closePreview: () => void

  // Utility
  getFilteredClusters: () => ValueCluster[]
  getSelectedMappings: () => { fromValue: string; toValue: string; rowCount: number }[]
  clearClusters: () => void
  reset: () => void
}

const initialState: StandardizerState = {
  isViewOpen: false,
  tableId: null,
  tableName: null,
  columnName: null,
  algorithm: 'fingerprint',
  clusters: [],
  filter: 'actionable',
  searchQuery: '',
  expandedId: null,
  isAnalyzing: false,
  progress: 0,
  progressPhase: 'idle',
  currentChunk: 0,
  totalChunks: 0,
  validationError: null,
  uniqueValueCount: 0,
  stats: {
    totalClusters: 0,
    actionableClusters: 0,
    totalValues: 0,
    selectedValues: 0,
  },
  previewClusterId: null,
  previewRecords: null,
  previewLoading: false,
}

function calculateStats(clusters: ValueCluster[]) {
  let totalValues = 0
  let selectedValues = 0
  let actionableClusters = 0

  for (const cluster of clusters) {
    totalValues += cluster.values.length
    if (cluster.values.length > 1) {
      actionableClusters++
    }
    for (const value of cluster.values) {
      // Count selected non-master values in multi-value clusters
      if (value.isSelected && !value.isMaster) {
        selectedValues++
      }
      // Count unique values with custom replacements (single-value clusters)
      // Check !== undefined to allow empty string replacements
      if (cluster.values.length === 1 && value.customReplacement !== undefined && value.customReplacement !== value.value) {
        selectedValues++
      }
    }
  }

  return {
    totalClusters: clusters.length,
    actionableClusters,
    totalValues,
    selectedValues,
  }
}

export const useStandardizerStore = create<StandardizerState & StandardizerActions>((set, get) => ({
  ...initialState,

  // View management
  openView: () => set({ isViewOpen: true }),
  closeView: () => set({ isViewOpen: false }),

  // Table/column configuration
  setTable: (tableId, tableName) => {
    set({
      tableId,
      tableName,
      columnName: null,
      clusters: [],
      expandedId: null,
      filter: 'actionable',
      searchQuery: '',
      validationError: null,
      uniqueValueCount: 0,
      stats: initialState.stats,
    })
  },

  setColumn: (columnName) => {
    set({
      columnName,
      clusters: [],
      expandedId: null,
      validationError: null,
      uniqueValueCount: 0,
      stats: initialState.stats,
    })
  },

  setAlgorithm: (algorithm) => {
    set({
      algorithm,
      clusters: [],
      expandedId: null,
      stats: initialState.stats,
    })
  },

  // Clusters management
  setClusters: (clusters) => {
    set({
      clusters,
      expandedId: null,
      filter: 'actionable',
      searchQuery: '',
      stats: calculateStats(clusters),
    })
  },

  setFilter: (filter) => set({ filter }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setExpandedId: (id) => set({ expandedId: id }),

  // Value selection within clusters
  toggleValueSelection: (clusterId, valueId) => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      if (cluster.id !== clusterId) return cluster

      const updatedValues = cluster.values.map((value) => {
        if (value.id !== valueId) return value
        // Don't allow deselecting the master value
        if (value.isMaster) return value
        return { ...value, isSelected: !value.isSelected }
      })

      const selectedCount = updatedValues.filter((v) => v.isSelected && !v.isMaster).length

      return {
        ...cluster,
        values: updatedValues,
        selectedCount,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  selectAllInCluster: (clusterId) => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      if (cluster.id !== clusterId) return cluster

      const updatedValues = cluster.values.map((value) => ({
        ...value,
        isSelected: true,
      }))

      const selectedCount = updatedValues.filter((v) => !v.isMaster).length

      return {
        ...cluster,
        values: updatedValues,
        selectedCount,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  deselectAllInCluster: (clusterId) => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      if (cluster.id !== clusterId) return cluster

      const updatedValues = cluster.values.map((value) => ({
        ...value,
        isSelected: value.isMaster, // Keep master selected
      }))

      return {
        ...cluster,
        values: updatedValues,
        selectedCount: 0,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  setMasterValue: (clusterId, valueId) => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      if (cluster.id !== clusterId) return cluster

      const newMasterValue = cluster.values.find((v) => v.id === valueId)
      if (!newMasterValue) return cluster

      const updatedValues = cluster.values.map((value) => ({
        ...value,
        isMaster: value.id === valueId,
        isSelected: true, // Select all when changing master
      }))

      const selectedCount = updatedValues.filter((v) => !v.isMaster).length

      return {
        ...cluster,
        values: updatedValues,
        masterValue: newMasterValue.value,
        selectedCount,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  // Custom replacement for unique values
  setCustomReplacement: (clusterId, valueId, replacement) => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      if (cluster.id !== clusterId) return cluster

      const updatedValues = cluster.values.map((value) => {
        if (value.id !== valueId) return value

        // Clear replacement if null (explicit clear) or same as original (no change)
        // Allow empty string as a valid replacement to blank out values
        if (replacement === null || replacement === value.value) {
          return {
            ...value,
            customReplacement: undefined,
            isSelected: false,
          }
        }

        // Set replacement and auto-select (including empty string)
        return {
          ...value,
          customReplacement: replacement,
          isSelected: true,
        }
      })

      return {
        ...cluster,
        values: updatedValues,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  // Bulk selection across all clusters
  selectAllClusters: () => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      // Only select values in actionable clusters (more than 1 value)
      if (cluster.values.length <= 1) return cluster

      const updatedValues = cluster.values.map((value) => ({
        ...value,
        isSelected: true,
      }))

      const selectedCount = updatedValues.filter((v) => !v.isMaster).length

      return {
        ...cluster,
        values: updatedValues,
        selectedCount,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  deselectAllClusters: () => {
    const { clusters } = get()
    const updatedClusters = clusters.map((cluster) => {
      const updatedValues = cluster.values.map((value) => ({
        ...value,
        isSelected: value.isMaster, // Keep only master selected
      }))

      return {
        ...cluster,
        values: updatedValues,
        selectedCount: 0,
      }
    })

    set({
      clusters: updatedClusters,
      stats: calculateStats(updatedClusters),
    })
  },

  // Processing state
  setIsAnalyzing: (analyzing) => set({ isAnalyzing: analyzing }),

  setProgress: (progress, phase, currentChunk = 0, totalChunks = 0) => {
    set({
      progress,
      progressPhase: phase,
      currentChunk,
      totalChunks,
    })
  },

  resetProgress: () => set({
    progress: 0,
    progressPhase: 'idle',
    currentChunk: 0,
    totalChunks: 0,
  }),

  // Validation
  setValidationError: (error) => set({ validationError: error }),
  setUniqueValueCount: (count) => set({ uniqueValueCount: count }),

  // Record preview drawer
  setPreviewCluster: (clusterId) => set({ previewClusterId: clusterId }),
  setPreviewRecords: (records) => set({ previewRecords: records }),
  setPreviewLoading: (loading) => set({ previewLoading: loading }),
  closePreview: () => set({
    previewClusterId: null,
    previewRecords: null,
    previewLoading: false,
  }),

  // Utility
  getFilteredClusters: () => {
    const { clusters, filter, searchQuery } = get()
    let filtered = clusters

    // Filter by actionable (clusters with > 1 value)
    if (filter === 'actionable') {
      filtered = filtered.filter((c) => c.values.length > 1)
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter((cluster) =>
        cluster.values.some((v) => v.value.toLowerCase().includes(query)) ||
        cluster.clusterKey.toLowerCase().includes(query)
      )
    }

    return filtered
  },

  getSelectedMappings: () => {
    const { clusters } = get()
    const mappings: { fromValue: string; toValue: string; rowCount: number }[] = []

    for (const cluster of clusters) {
      // Handle single-value clusters (unique values) with custom replacements
      if (cluster.values.length === 1) {
        const value = cluster.values[0]
        // Check !== undefined to allow empty string replacements
        if (value.customReplacement !== undefined && value.customReplacement !== value.value) {
          mappings.push({
            fromValue: value.value,
            toValue: value.customReplacement,
            rowCount: value.count,
          })
        }
        continue
      }

      // Handle multi-value clusters (actionable clusters)
      const masterValue = cluster.values.find((v) => v.isMaster)
      if (!masterValue) continue

      for (const value of cluster.values) {
        if (value.isSelected && !value.isMaster && value.value !== masterValue.value) {
          mappings.push({
            fromValue: value.value,
            toValue: masterValue.value,
            rowCount: value.count,
          })
        }
      }
    }

    return mappings
  },

  clearClusters: () => set({
    clusters: [],
    filter: 'actionable',
    searchQuery: '',
    expandedId: null,
    isAnalyzing: false,
    progress: 0,
    progressPhase: 'idle',
    currentChunk: 0,
    totalChunks: 0,
    stats: initialState.stats,
    previewClusterId: null,
    previewRecords: null,
    previewLoading: false,
  }),

  reset: () => set({ ...initialState }),
}))
