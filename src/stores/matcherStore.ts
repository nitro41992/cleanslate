import { create } from 'zustand'
import type { MatchPair, BlockingStrategy } from '@/types'

export type MatchFilter = 'all' | 'definite' | 'maybe' | 'not_match'
export type MatchClassification = 'definite' | 'maybe' | 'not_match'

interface MatcherState {
  // View state
  isViewOpen: boolean

  // Table configuration
  tableId: string | null
  tableName: string | null
  matchColumn: string | null
  blockingStrategy: BlockingStrategy

  // Dual thresholds for similarity classification
  definiteThreshold: number // >= this = "definite" match (default 95%)
  maybeThreshold: number    // >= this = "maybe" match (default 85%)

  // Match pairs and filtering
  pairs: MatchPair[]
  filter: MatchFilter
  currentPairIndex: number
  selectedIds: Set<string>
  expandedId: string | null

  // Processing state
  isMatching: boolean
  progress: number           // 0-100 progress percentage
  pairsFound: number         // Running count during matching
  estimatedPairs: number     // Total expected pairs (for progress bar)

  // Detailed progress for chunked processing
  progressPhase: 'idle' | 'analyzing' | 'processing' | 'complete'
  currentBlock: number
  totalBlocks: number
  currentBlockKey: string | null
  oversizedBlocks: number
  maybeCount: number         // Maybe matches found so far
  definiteCount: number      // Definite matches found so far

  // Statistics
  stats: {
    total: number
    merged: number
    keptSeparate: number
    pending: number
    definiteCount: number
    maybeCount: number
    notMatchCount: number
  }
}

interface MatcherActions {
  // View management
  openView: () => void
  closeView: () => void

  // Table/column configuration
  setTable: (tableId: string | null, tableName: string | null) => void
  setMatchColumn: (column: string | null) => void
  setBlockingStrategy: (strategy: BlockingStrategy) => void

  // Threshold management
  setDefiniteThreshold: (threshold: number) => void
  setMaybeThreshold: (threshold: number) => void
  setThresholds: (definite: number, maybe: number) => void

  // Pairs management
  setPairs: (pairs: MatchPair[]) => void
  setCurrentPairIndex: (index: number) => void
  setIsMatching: (matching: boolean) => void
  setProgress: (progress: number, pairsFound: number, estimatedPairs: number) => void
  setDetailedProgress: (
    phase: 'idle' | 'analyzing' | 'processing' | 'complete',
    currentBlock: number,
    totalBlocks: number,
    pairsFound: number,
    maybeCount: number,
    definiteCount: number,
    currentBlockKey: string | null,
    oversizedBlocks: number
  ) => void
  resetProgress: () => void

  // Selection and expansion
  setFilter: (filter: MatchFilter) => void
  toggleSelect: (pairId: string) => void
  selectAll: (pairIds: string[]) => void
  clearSelection: () => void
  setExpandedId: (id: string | null) => void

  // Actions on pairs
  markPairAsMerged: (pairId: string) => void
  markPairAsKeptSeparate: (pairId: string) => void
  markSelectedAsMerged: () => void
  markSelectedAsKeptSeparate: () => void
  swapKeepRow: (pairId: string) => void
  nextPair: () => void
  previousPair: () => void

  // Utility
  classifyPair: (similarity: number) => MatchClassification
  getFilteredPairs: () => MatchPair[]
  clearPairs: () => void  // Clear pairs but keep config (for "New Search")
  reset: () => void       // Full reset (for closing the view)
}

const initialState: MatcherState = {
  isViewOpen: false,
  tableId: null,
  tableName: null,
  matchColumn: null,
  blockingStrategy: 'double_metaphone',
  definiteThreshold: 95,
  maybeThreshold: 85,
  pairs: [],
  filter: 'all',
  currentPairIndex: 0,
  selectedIds: new Set(),
  expandedId: null,
  isMatching: false,
  progress: 0,
  pairsFound: 0,
  estimatedPairs: 0,
  progressPhase: 'idle',
  currentBlock: 0,
  totalBlocks: 0,
  currentBlockKey: null,
  oversizedBlocks: 0,
  maybeCount: 0,
  definiteCount: 0,
  stats: {
    total: 0,
    merged: 0,
    keptSeparate: 0,
    pending: 0,
    definiteCount: 0,
    maybeCount: 0,
    notMatchCount: 0,
  },
}

function classifyPairWithThresholds(
  similarity: number,
  definiteThreshold: number,
  maybeThreshold: number
): MatchClassification {
  if (similarity >= definiteThreshold) return 'definite'
  if (similarity >= maybeThreshold) return 'maybe'
  return 'not_match'
}

function calculateStats(
  pairs: MatchPair[],
  definiteThreshold: number,
  maybeThreshold: number
) {
  let merged = 0
  let keptSeparate = 0
  let pending = 0
  let definiteCount = 0
  let maybeCount = 0
  let notMatchCount = 0

  for (const pair of pairs) {
    if (pair.status === 'merged') {
      merged++
    } else if (pair.status === 'kept_separate') {
      keptSeparate++
    } else {
      pending++
      const classification = classifyPairWithThresholds(
        pair.similarity,
        definiteThreshold,
        maybeThreshold
      )
      if (classification === 'definite') definiteCount++
      else if (classification === 'maybe') maybeCount++
      else notMatchCount++
    }
  }

  return {
    total: pairs.length,
    merged,
    keptSeparate,
    pending,
    definiteCount,
    maybeCount,
    notMatchCount,
  }
}

export const useMatcherStore = create<MatcherState & MatcherActions>((set, get) => ({
  ...initialState,

  // View management
  openView: () => set({ isViewOpen: true }),
  closeView: () => set({ isViewOpen: false }),

  // Table/column configuration
  setTable: (tableId, tableName) => {
    set({
      tableId,
      tableName,
      matchColumn: null,
      pairs: [],
      selectedIds: new Set(),
      expandedId: null,
      filter: 'all',
      stats: initialState.stats,
    })
  },

  setMatchColumn: (column) => set({ matchColumn: column }),

  setBlockingStrategy: (strategy) => set({ blockingStrategy: strategy }),

  // Threshold management
  setDefiniteThreshold: (threshold) => {
    const { pairs, maybeThreshold } = get()
    set({
      definiteThreshold: threshold,
      stats: calculateStats(pairs, threshold, maybeThreshold),
    })
  },

  setMaybeThreshold: (threshold) => {
    const { pairs, definiteThreshold } = get()
    set({
      maybeThreshold: threshold,
      stats: calculateStats(pairs, definiteThreshold, threshold),
    })
  },

  setThresholds: (definite, maybe) => {
    const { pairs } = get()
    set({
      definiteThreshold: definite,
      maybeThreshold: maybe,
      stats: calculateStats(pairs, definite, maybe),
    })
  },

  // Pairs management
  setPairs: (pairs) => {
    const { definiteThreshold, maybeThreshold } = get()
    set({
      pairs,
      currentPairIndex: 0,
      selectedIds: new Set(),
      expandedId: null,
      filter: 'all',
      stats: calculateStats(pairs, definiteThreshold, maybeThreshold),
    })
  },

  setCurrentPairIndex: (index) => set({ currentPairIndex: index }),
  setIsMatching: (matching) => set({ isMatching: matching }),
  setProgress: (progress, pairsFound, estimatedPairs) => set({ progress, pairsFound, estimatedPairs }),
  setDetailedProgress: (phase, currentBlock, totalBlocks, pairsFound, maybeCount, definiteCount, currentBlockKey, oversizedBlocks) => {
    const progress = totalBlocks > 0 ? Math.round((currentBlock / totalBlocks) * 100) : 0
    set({
      progressPhase: phase,
      currentBlock,
      totalBlocks,
      pairsFound,
      maybeCount,
      definiteCount,
      currentBlockKey,
      oversizedBlocks,
      progress,
    })
  },
  resetProgress: () => set({
    progress: 0,
    pairsFound: 0,
    estimatedPairs: 0,
    progressPhase: 'idle',
    currentBlock: 0,
    totalBlocks: 0,
    currentBlockKey: null,
    oversizedBlocks: 0,
    maybeCount: 0,
    definiteCount: 0,
  }),

  // Selection and filtering
  setFilter: (filter) => set({ filter, selectedIds: new Set() }),

  toggleSelect: (pairId) => {
    const { selectedIds } = get()
    const newSelected = new Set(selectedIds)
    if (newSelected.has(pairId)) {
      newSelected.delete(pairId)
    } else {
      newSelected.add(pairId)
    }
    set({ selectedIds: newSelected })
  },

  selectAll: (pairIds) => {
    set({ selectedIds: new Set(pairIds) })
  },

  clearSelection: () => {
    set({ selectedIds: new Set() })
  },

  setExpandedId: (id) => set({ expandedId: id }),

  // Actions on pairs
  markPairAsMerged: (pairId) => {
    const { pairs, definiteThreshold, maybeThreshold, selectedIds } = get()
    const updatedPairs = pairs.map((p) =>
      p.id === pairId ? { ...p, status: 'merged' as const } : p
    )
    const newSelected = new Set(selectedIds)
    newSelected.delete(pairId)
    set({
      pairs: updatedPairs,
      selectedIds: newSelected,
      stats: calculateStats(updatedPairs, definiteThreshold, maybeThreshold),
    })
  },

  markPairAsKeptSeparate: (pairId) => {
    const { pairs, definiteThreshold, maybeThreshold, selectedIds } = get()
    const updatedPairs = pairs.map((p) =>
      p.id === pairId ? { ...p, status: 'kept_separate' as const } : p
    )
    const newSelected = new Set(selectedIds)
    newSelected.delete(pairId)
    set({
      pairs: updatedPairs,
      selectedIds: newSelected,
      stats: calculateStats(updatedPairs, definiteThreshold, maybeThreshold),
    })
  },

  markSelectedAsMerged: () => {
    const { pairs, definiteThreshold, maybeThreshold, selectedIds } = get()
    const updatedPairs = pairs.map((p) =>
      selectedIds.has(p.id) ? { ...p, status: 'merged' as const } : p
    )
    set({
      pairs: updatedPairs,
      selectedIds: new Set(),
      stats: calculateStats(updatedPairs, definiteThreshold, maybeThreshold),
    })
  },

  markSelectedAsKeptSeparate: () => {
    const { pairs, definiteThreshold, maybeThreshold, selectedIds } = get()
    const updatedPairs = pairs.map((p) =>
      selectedIds.has(p.id) ? { ...p, status: 'kept_separate' as const } : p
    )
    set({
      pairs: updatedPairs,
      selectedIds: new Set(),
      stats: calculateStats(updatedPairs, definiteThreshold, maybeThreshold),
    })
  },

  swapKeepRow: (pairId) => {
    const { pairs, definiteThreshold, maybeThreshold } = get()
    const updatedPairs = pairs.map((p) =>
      p.id === pairId ? { ...p, keepRow: p.keepRow === 'A' ? 'B' as const : 'A' as const } : p
    )
    set({
      pairs: updatedPairs,
      stats: calculateStats(updatedPairs, definiteThreshold, maybeThreshold),
    })
  },

  nextPair: () => {
    const { currentPairIndex, pairs } = get()
    for (let i = currentPairIndex + 1; i < pairs.length; i++) {
      if (pairs[i].status === 'pending') {
        set({ currentPairIndex: i })
        return
      }
    }
  },

  previousPair: () => {
    const { currentPairIndex, pairs } = get()
    for (let i = currentPairIndex - 1; i >= 0; i--) {
      if (pairs[i].status === 'pending') {
        set({ currentPairIndex: i })
        return
      }
    }
  },

  // Utility
  classifyPair: (similarity) => {
    const { definiteThreshold, maybeThreshold } = get()
    return classifyPairWithThresholds(similarity, definiteThreshold, maybeThreshold)
  },

  getFilteredPairs: () => {
    const { pairs, filter, definiteThreshold, maybeThreshold } = get()
    return pairs.filter((pair) => {
      if (pair.status !== 'pending') return false
      if (filter === 'all') return true
      const classification = classifyPairWithThresholds(
        pair.similarity,
        definiteThreshold,
        maybeThreshold
      )
      return classification === filter
    })
  },

  clearPairs: () => set({
    pairs: [],
    filter: 'all',
    currentPairIndex: 0,
    selectedIds: new Set(),
    expandedId: null,
    isMatching: false,
    progress: 0,
    pairsFound: 0,
    estimatedPairs: 0,
    progressPhase: 'idle',
    currentBlock: 0,
    totalBlocks: 0,
    currentBlockKey: null,
    oversizedBlocks: 0,
    maybeCount: 0,
    definiteCount: 0,
    stats: initialState.stats,
  }),

  reset: () => set({ ...initialState, selectedIds: new Set() }),
}))
