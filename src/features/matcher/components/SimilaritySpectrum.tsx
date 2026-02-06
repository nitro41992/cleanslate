import { useMemo } from 'react'
import { DualRangeSlider } from '@/components/ui/dual-range-slider'
import type { MatchPair } from '@/types'

interface SimilaritySpectrumProps {
  pairs: MatchPair[]
  maybeThreshold: number
  definiteThreshold: number
  onThresholdsChange: (maybe: number, definite: number) => void
  disabled?: boolean
}

type Zone = 'not_match' | 'maybe' | 'definite'

interface BarSegment {
  zone: Zone
  fraction: number // 0-1 proportion of the bar
}

/** Classify a value into a zone */
function classifyValue(value: number, maybe: number, definite: number): Zone {
  if (value >= definite) return 'definite'
  if (value >= maybe) return 'maybe'
  return 'not_match'
}

/** Split a bar into segments when thresholds fall within it */
function getBarSegments(
  bucketMin: number,
  bucketMax: number,
  maybe: number,
  definite: number
): BarSegment[] {
  const width = bucketMax - bucketMin
  // Collect thresholds that fall strictly inside this bucket
  const splits: number[] = []
  if (maybe > bucketMin && maybe < bucketMax) splits.push(maybe)
  if (definite > bucketMin && definite < bucketMax && definite !== maybe) splits.push(definite)
  splits.sort((a, b) => a - b)

  if (splits.length === 0) {
    // Entire bar is one zone (use midpoint to classify)
    return [{ zone: classifyValue((bucketMin + bucketMax) / 2, maybe, definite), fraction: 1 }]
  }

  const segments: BarSegment[] = []
  let prev = bucketMin
  for (const split of splits) {
    const fraction = (split - prev) / width
    if (fraction > 0) {
      segments.push({ zone: classifyValue((prev + split) / 2, maybe, definite), fraction })
    }
    prev = split
  }
  // Final segment
  const lastFraction = (bucketMax - prev) / width
  if (lastFraction > 0) {
    segments.push({ zone: classifyValue((prev + bucketMax) / 2, maybe, definite), fraction: lastFraction })
  }
  return segments
}

const zoneColors: Record<Zone, string> = {
  not_match: 'bg-[hsl(var(--matcher-not-match))]',
  maybe: 'bg-[hsl(var(--matcher-maybe))]',
  definite: 'bg-[hsl(var(--matcher-definite))]',
}

export function SimilaritySpectrum({
  pairs,
  maybeThreshold,
  definiteThreshold,
  onThresholdsChange,
  disabled = false,
}: SimilaritySpectrumProps) {
  // Create histogram buckets (10 buckets from 0-100, each 10% wide)
  const histogram = useMemo(() => {
    const bucketCount = 10
    const bucketWidth = 100 / bucketCount // 10%
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

      {/* Histogram with threshold lines */}
      <div className="relative h-20 rounded-xl overflow-hidden bg-muted/50">
        {/* Bars */}
        <div className="absolute inset-0 flex items-end gap-[2px] p-2 pb-1">
          {histogram.map((bucket, index) => {
            const segments = getBarSegments(
              bucket.min,
              bucket.max,
              maybeThreshold,
              definiteThreshold
            )

            return (
              <div
                key={index}
                className="flex-1 flex rounded-md overflow-hidden transition-all duration-300 hover:opacity-90"
                style={{ height: `${Math.max(bucket.height, 4)}%` }}
                title={`${bucket.min.toFixed(0)}-${bucket.max.toFixed(0)}%: ${bucket.count} pairs`}
              >
                {segments.map((seg, si) => (
                  <div
                    key={si}
                    className={`${zoneColors[seg.zone]} ${bucket.count === 0 ? 'opacity-10' : 'opacity-80'}`}
                    style={{ flex: seg.fraction }}
                  />
                ))}
              </div>
            )
          })}
        </div>

        {/* Vertical threshold lines */}
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none opacity-60"
          style={{ left: `${maybeThreshold}%`, background: `hsl(var(--matcher-maybe))` }}
        />
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none opacity-60"
          style={{ left: `${definiteThreshold}%`, background: `hsl(var(--matcher-definite))` }}
        />
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

      {/* Zone legend + threshold values — single compact row */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm bg-[hsl(var(--matcher-not-match)/0.6)]" />
            <span>Not Match</span>
            <span className="tabular-nums font-medium">{zoneCounts.notMatch}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm bg-[hsl(var(--matcher-maybe)/0.8)]" />
            <span className="text-[hsl(var(--matcher-maybe))]">Maybe</span>
            <span className="tabular-nums font-medium text-[hsl(var(--matcher-maybe))]">{zoneCounts.maybe}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm bg-[hsl(var(--matcher-definite)/0.8)]" />
            <span className="text-[hsl(var(--matcher-definite))]">Definite</span>
            <span className="tabular-nums font-medium text-[hsl(var(--matcher-definite))]">{zoneCounts.definite}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 tabular-nums text-muted-foreground/60">
          <span><span className="text-[hsl(var(--matcher-maybe))]">{maybeThreshold}%</span> maybe</span>
          <span><span className="text-[hsl(var(--matcher-definite))]">{definiteThreshold}%</span> definite</span>
        </div>
      </div>
    </div>
  )
}
