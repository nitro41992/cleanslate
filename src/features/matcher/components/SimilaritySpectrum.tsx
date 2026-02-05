import { useMemo } from 'react'
import { DualRangeSlider } from '@/components/ui/dual-range-slider'
import { cn } from '@/lib/utils'
import type { MatchPair } from '@/types'

interface SimilaritySpectrumProps {
  pairs: MatchPair[]
  maybeThreshold: number
  definiteThreshold: number
  onThresholdsChange: (maybe: number, definite: number) => void
  disabled?: boolean
}

export function SimilaritySpectrum({
  pairs,
  maybeThreshold,
  definiteThreshold,
  onThresholdsChange,
  disabled = false,
}: SimilaritySpectrumProps) {
  // Create histogram buckets (20 buckets from 0-100, each 5% wide)
  const histogram = useMemo(() => {
    const bucketCount = 20
    const bucketWidth = 100 / bucketCount // 5%
    const buckets = new Array(bucketCount).fill(0)
    const pendingPairs = pairs.filter((p) => p.status === 'pending')

    pendingPairs.forEach((pair) => {
      const bucketIndex = Math.min(Math.floor(pair.similarity / bucketWidth), bucketCount - 1)
      buckets[bucketIndex]++
    })

    const maxCount = Math.max(...buckets, 1)
    return buckets.map((count, index) => ({
      min: index * bucketWidth,
      max: (index + 1) * bucketWidth,
      count,
      height: (count / maxCount) * 100,
    }))
  }, [pairs])

  // Count pairs in each zone
  const zoneCounts = useMemo(() => {
    const pendingPairs = pairs.filter((p) => p.status === 'pending')
    let notMatch = 0
    let maybe = 0
    let definite = 0

    pendingPairs.forEach((pair) => {
      if (pair.similarity >= definiteThreshold) {
        definite++
      } else if (pair.similarity >= maybeThreshold) {
        maybe++
      } else {
        notMatch++
      }
    })

    return { notMatch, maybe, definite }
  }, [pairs, maybeThreshold, definiteThreshold])

  const handleValueChange = (values: [number, number]) => {
    onThresholdsChange(values[0], values[1])
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium flex items-center gap-2">
        Similarity Spectrum
        <span className="text-xs text-muted-foreground font-normal">
          (drag thresholds to adjust)
        </span>
      </div>

      {/* Histogram */}
      <div className="relative h-16 rounded-lg overflow-hidden bg-muted border border-border">
        <div className="absolute inset-0 flex items-end gap-px p-1">
          {histogram.map((bucket, index) => {
            // Determine bucket color based on thresholds (use midpoint of bucket)
            const bucketMid = bucket.min + (bucket.max - bucket.min) / 2
            let bgColor = 'bg-red-600'
            if (bucketMid >= definiteThreshold) {
              bgColor = 'bg-green-600'
            } else if (bucketMid >= maybeThreshold) {
              bgColor = 'bg-yellow-600'
            }

            return (
              <div
                key={index}
                className={cn(
                  'flex-1 rounded-t transition-all duration-200',
                  bgColor,
                  bucket.count === 0 && 'opacity-20'
                )}
                style={{ height: `${Math.max(bucket.height, 6)}%` }}
                title={`${bucket.min.toFixed(0)}-${bucket.max.toFixed(0)}%: ${bucket.count} pairs`}
              />
            )
          })}
        </div>
      </div>

      {/* Dual Range Slider */}
      <div className="px-1">
        <DualRangeSlider
          value={[maybeThreshold, definiteThreshold]}
          onValueChange={handleValueChange}
          min={0}
          max={100}
          step={1}
          minRange={1}
          disabled={disabled}
        />
      </div>

      {/* Scale labels */}
      <div className="flex justify-between text-xs text-muted-foreground px-1">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>

      {/* Zone Legend */}
      <div className="flex justify-between text-xs pt-3 border-t border-border">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-100 dark:bg-red-950/40 border border-red-300 dark:border-red-800/40">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <span className="text-red-600 dark:text-red-400/80">Not Match</span>
          <span className="font-medium text-red-600 dark:text-red-400 tabular-nums">({zoneCounts.notMatch})</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-yellow-100 dark:bg-yellow-950/40 border border-yellow-300 dark:border-yellow-800/40">
          <div className="w-2 h-2 rounded-full bg-yellow-500" />
          <span className="text-yellow-600 dark:text-yellow-400/80">Maybe</span>
          <span className="font-medium text-yellow-600 dark:text-yellow-400 tabular-nums">({zoneCounts.maybe})</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-100 dark:bg-green-950/40 border border-green-300 dark:border-green-800/40">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-green-600 dark:text-green-400/80">Definite</span>
          <span className="font-medium text-green-600 dark:text-green-400 tabular-nums">({zoneCounts.definite})</span>
        </div>
      </div>

      {/* Threshold Values - Enhanced */}
      <div className="flex justify-between text-xs text-muted-foreground/80">
        <span className="tabular-nums">Maybe cutoff: <span className="text-yellow-600 dark:text-yellow-400">{maybeThreshold}%</span></span>
        <span className="tabular-nums">Definite cutoff: <span className="text-green-600 dark:text-green-400">{definiteThreshold}%</span></span>
      </div>
    </div>
  )
}
