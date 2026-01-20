import { create } from 'zustand'
import type { MatchPair } from '@/types'

type BlockingStrategy = 'first_letter' | 'soundex' | 'exact'

interface MatcherState {
  tableId: string | null
  tableName: string | null
  matchColumn: string | null
  blockingStrategy: BlockingStrategy
  threshold: number
  pairs: MatchPair[]
  currentPairIndex: number
  isMatching: boolean
  stats: {
    total: number
    merged: number
    keptSeparate: number
    pending: number
  }
}

interface MatcherActions {
  setTable: (tableId: string | null, tableName: string | null) => void
  setMatchColumn: (column: string | null) => void
  setBlockingStrategy: (strategy: BlockingStrategy) => void
  setThreshold: (threshold: number) => void
  setPairs: (pairs: MatchPair[]) => void
  setCurrentPairIndex: (index: number) => void
  setIsMatching: (matching: boolean) => void
  markPairAsMerged: (pairId: string) => void
  markPairAsKeptSeparate: (pairId: string) => void
  nextPair: () => void
  previousPair: () => void
  reset: () => void
}

const initialState: MatcherState = {
  tableId: null,
  tableName: null,
  matchColumn: null,
  blockingStrategy: 'first_letter',
  threshold: 3,
  pairs: [],
  currentPairIndex: 0,
  isMatching: false,
  stats: {
    total: 0,
    merged: 0,
    keptSeparate: 0,
    pending: 0,
  },
}

export const useMatcherStore = create<MatcherState & MatcherActions>((set, get) => ({
  ...initialState,

  setTable: (tableId, tableName) => set({ tableId, tableName }),
  setMatchColumn: (column) => set({ matchColumn: column }),
  setBlockingStrategy: (strategy) => set({ blockingStrategy: strategy }),
  setThreshold: (threshold) => set({ threshold }),
  setPairs: (pairs) => {
    set({
      pairs,
      currentPairIndex: 0,
      stats: {
        total: pairs.length,
        merged: 0,
        keptSeparate: 0,
        pending: pairs.length,
      },
    })
  },
  setCurrentPairIndex: (index) => set({ currentPairIndex: index }),
  setIsMatching: (matching) => set({ isMatching: matching }),

  markPairAsMerged: (pairId) => {
    const { pairs, stats } = get()
    const updatedPairs = pairs.map((p) =>
      p.id === pairId ? { ...p, status: 'merged' as const } : p
    )
    set({
      pairs: updatedPairs,
      stats: {
        ...stats,
        merged: stats.merged + 1,
        pending: stats.pending - 1,
      },
    })
  },

  markPairAsKeptSeparate: (pairId) => {
    const { pairs, stats } = get()
    const updatedPairs = pairs.map((p) =>
      p.id === pairId ? { ...p, status: 'kept_separate' as const } : p
    )
    set({
      pairs: updatedPairs,
      stats: {
        ...stats,
        keptSeparate: stats.keptSeparate + 1,
        pending: stats.pending - 1,
      },
    })
  },

  nextPair: () => {
    const { currentPairIndex, pairs } = get()
    // Find next pending pair
    for (let i = currentPairIndex + 1; i < pairs.length; i++) {
      if (pairs[i].status === 'pending') {
        set({ currentPairIndex: i })
        return
      }
    }
    // No more pending pairs
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

  reset: () => set(initialState),
}))
