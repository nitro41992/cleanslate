import { useCallback, useRef } from 'react'
import type { MatchPair, BlockingStrategy } from '@/types'
import { findDuplicatesChunked, type ChunkedProgressInfo } from '@/lib/fuzzy-matcher'

/**
 * Detailed progress callback for chunked matching
 */
interface DetailedProgressCallback {
  (info: ChunkedProgressInfo): void
}

interface MatchResult {
  pairs: MatchPair[]
  totalFound: number
  oversizedBlocksCount: number
  blocksProcessed: number
  totalBlocks: number
}

interface UseFuzzyMatcherResult {
  startMatching: (
    tableName: string,
    matchColumn: string,
    blockingStrategy: BlockingStrategy,
    definiteThreshold: number,
    maybeThreshold: number,
    onProgress: DetailedProgressCallback
  ) => Promise<MatchResult>
  cancelMatching: () => void
}

/**
 * Hook for running fuzzy matching with chunked multi-pass processing
 *
 * Processes data block-by-block for scalability:
 * - Analyzes block distribution first
 * - Processes each block separately with bounded memory
 * - Reports progress after each block
 * - Handles oversized blocks by sampling
 * - Supports cancellation between blocks
 *
 * Scales to 2M+ rows with predictable performance.
 */
export function useFuzzyMatcher(): UseFuzzyMatcherResult {
  const cancelledRef = useRef(false)

  const startMatching = useCallback(async (
    tableName: string,
    matchColumn: string,
    blockingStrategy: BlockingStrategy,
    definiteThreshold: number,
    maybeThreshold: number,
    onProgress: DetailedProgressCallback
  ): Promise<MatchResult> => {
    cancelledRef.current = false

    try {
      // Use chunked processing for scalability
      const result = await findDuplicatesChunked(
        tableName,
        matchColumn,
        blockingStrategy,
        definiteThreshold,
        maybeThreshold,
        onProgress,
        () => cancelledRef.current
      )

      if (cancelledRef.current) {
        throw new Error('Matching cancelled')
      }

      return result
    } catch (error) {
      if (cancelledRef.current) {
        throw new Error('Matching cancelled')
      }
      throw error
    }
  }, [])

  const cancelMatching = useCallback(() => {
    cancelledRef.current = true
  }, [])

  return { startMatching, cancelMatching }
}
