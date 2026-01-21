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
      <div className="text-sm font-medium">Similarity Spectrum</div>

      {/* Histogram */}
      <div className="relative h-16">
        <div className="absolute inset-0 flex items-end gap-px">
          {histogram.map((bucket, index) => {
            // Determine bucket color based on thresholds (use midpoint of bucket)
            const bucketMid = bucket.min + (bucket.max - bucket.min) / 2
            let bgColor = 'bg-red-500/40'
            if (bucketMid >= definiteThreshold) {
              bgColor = 'bg-green-500/40'
            } else if (bucketMid >= maybeThreshold) {
              bgColor = 'bg-yellow-500/40'
            }

            return (
              <div
                key={index}
                className={cn(
                  'flex-1 rounded-t transition-all',
                  bgColor,
                  bucket.count === 0 && 'opacity-30'
                )}
                style={{ height: `${Math.max(bucket.height, 8)}%` }}
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
      <div className="flex justify-between text-xs pt-2 border-t border-border/50">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-red-500/40" />
          <span className="text-muted-foreground">Not Match</span>
          <span className="font-medium">({zoneCounts.notMatch})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-yellow-500/40" />
          <span className="text-muted-foreground">Maybe</span>
          <span className="font-medium">({zoneCounts.maybe})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-green-500/40" />
          <span className="text-muted-foreground">Definite</span>
          <span className="font-medium">({zoneCounts.definite})</span>
        </div>
      </div>

      {/* Threshold Values */}
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Maybe cutoff: {maybeThreshold}%</span>
        <span>Definite cutoff: {definiteThreshold}%</span>
      </div>
    </div>
  )
}
