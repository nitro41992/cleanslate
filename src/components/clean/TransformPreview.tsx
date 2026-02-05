/**
 * TransformPreview Component
 *
 * Shows a live preview of how data will transform before applying.
 * Displays before/after comparison for sample rows with debounced updates.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { Eye, ArrowRight, AlertCircle, AlertTriangle } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import type { TransformationType } from '@/types'
import {
  generatePreview,
  isPreviewReady,
  PREVIEW_SUPPORTED_TRANSFORMS,
  type PreviewResult,
} from '@/lib/preview/transform-preview'

/** Preview state reported to parent components */
export interface PreviewState {
  /** Whether preview is currently loading */
  isLoading: boolean
  /** Total rows that match the transform criteria */
  totalMatching: number
  /** Whether preview encountered an error */
  hasError: boolean
  /** Whether preview is ready (requirements met) */
  isReady: boolean
  /** Number of rows where the result is NULL (silent failure warning) */
  nullCount?: number
}

interface TransformPreviewProps {
  /** Table name to preview from */
  tableName: string
  /** Target column (optional for some transforms) */
  column?: string
  /** Type of transformation */
  transformType: TransformationType
  /** Transformation parameters */
  params: Record<string, string>
  /** Number of sample rows to show */
  sampleCount?: number
  /** Callback when preview state changes (for validation) */
  onPreviewStateChange?: (state: PreviewState) => void
}

export function TransformPreview({
  tableName,
  column,
  transformType,
  params,
  sampleCount = 10,
  onPreviewStateChange,
}: TransformPreviewProps) {
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Check if this transform supports preview
  const supportsPreview = PREVIEW_SUPPORTED_TRANSFORMS.includes(transformType)

  // Check if preview requirements are met
  const ready = supportsPreview && isPreviewReady(transformType, column, params)

  // Memoize params string to use as stable dependency
  const paramsKey = useMemo(() => JSON.stringify(params), [params])

  // Debounced preview generation
  useEffect(() => {
    // Clear existing debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    // Reset preview if not ready
    if (!ready) {
      setPreview(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    // Debounce 300ms for live updates
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await generatePreview(
          tableName,
          column,
          transformType,
          params,
          sampleCount
        )
        setPreview(result)
      } catch (error) {
        console.error('Preview failed:', error)
        setPreview({
          rows: [],
          totalMatching: 0,
          error: error instanceof Error ? error.message : 'Preview failed',
        })
      } finally {
        setIsLoading(false)
      }
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [tableName, column, transformType, paramsKey, sampleCount, ready, params])

  // Report preview state changes to parent
  useEffect(() => {
    if (onPreviewStateChange) {
      onPreviewStateChange({
        isLoading,
        totalMatching: preview?.totalMatching ?? 0,
        hasError: !!preview?.error,
        isReady: ready,
        nullCount: preview?.nullCount,
      })
    }
  }, [onPreviewStateChange, isLoading, preview?.totalMatching, preview?.error, preview?.nullCount, ready])

  // Don't render if transform doesn't support preview
  if (!supportsPreview) {
    return null
  }

  // Don't render if requirements not met (waiting for user input)
  if (!ready) {
    return null
  }

  // Calculate display count for header
  const displayCount = preview?.combineRows?.length ?? preview?.splitRows?.length ?? preview?.rows.length ?? 0
  const hasSplitData = preview?.splitRows && preview.splitRows.length > 0
  const hasCombineData = preview?.combineRows && preview.combineRows.length > 0
  const hasStandardData = preview?.rows && preview.rows.length > 0

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
          <Eye className="w-3.5 h-3.5" />
          Live Preview
        </div>
        {preview && !isLoading && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {displayCount} of {preview.totalMatching.toLocaleString()} matching
            </span>
            {preview.nullCount !== undefined && preview.nullCount > 0 && (
              <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500">
                <AlertTriangle className="w-3 h-3" />
                <span>{preview.nullCount.toLocaleString()} rows produce NULL</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : preview?.error ? (
        <div className="flex items-center gap-2 text-xs text-destructive py-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {preview.error}
        </div>
      ) : hasCombineData ? (
        /* Combine Columns Preview - Table Layout */
        <ScrollArea className="h-[180px]">
          <div className="space-y-0 pr-3">
            {/* Header row */}
            <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground pb-1.5 border-b border-border/50 mb-1.5">
              {preview.combineColumns!.map((col, i) => (
                <span
                  key={i}
                  className="flex-1 min-w-[60px] truncate"
                  title={col}
                >
                  {truncateColumnName(col, 12)}
                </span>
              ))}
              <ArrowRight className="w-3 h-3 shrink-0 mx-1" />
              <span className="flex-1 min-w-[80px] text-amber-600 dark:text-amber-600 dark:text-amber-400/70">Result</span>
            </div>
            {/* Data rows */}
            {preview.combineRows!.map((row, i) => (
              <div
                key={i}
                className="flex items-center gap-1 text-xs font-mono py-1 border-b border-border/20 last:border-0"
              >
                {row.sourceValues.map((val, j) => (
                  <span
                    key={j}
                    className="flex-1 min-w-[60px] text-muted-foreground/80 truncate"
                    title={val ?? '(null)'}
                  >
                    {formatPreviewValue(val, 10)}
                  </span>
                ))}
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0 mx-1" />
                <span
                  className="flex-1 min-w-[80px] text-green-700 dark:text-green-400/90 truncate"
                  title={row.result ?? '(null)'}
                >
                  {formatPreviewValue(row.result, 20)}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : hasSplitData ? (
        /* Split Column Preview - Table Layout */
        <ScrollArea className="h-[180px]">
          <div className="space-y-0 pr-3">
            {/* Header row */}
            <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground pb-1.5 border-b border-border/50 mb-1.5">
              <span className="w-[90px] shrink-0">Original</span>
              <ArrowRight className="w-3 h-3 shrink-0 mx-1" />
              {preview.splitRows![0]?.parts.map((_, i) => (
                <span key={i} className="flex-1 min-w-[60px] text-center text-amber-600 dark:text-amber-600 dark:text-amber-400/70">
                  {preview.splitColumn}_{i + 1}
                </span>
              ))}
            </div>
            {/* Data rows */}
            {preview.splitRows!.map((row, i) => (
              <div
                key={i}
                className="flex items-center gap-1 text-xs font-mono py-1 border-b border-border/20 last:border-0"
              >
                <span
                  className="w-[90px] shrink-0 text-muted-foreground/80 truncate"
                  title={row.original ?? '(null)'}
                >
                  {formatPreviewValue(row.original, 12)}
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0 mx-1" />
                {row.parts.map((part, j) => (
                  <span
                    key={j}
                    className="flex-1 min-w-[60px] text-green-700 dark:text-green-400/90 truncate text-center"
                    title={part ?? '(empty)'}
                  >
                    {formatPreviewValue(part, 10)}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : hasStandardData ? (
        /* Standard Before/After Preview */
        <ScrollArea className="h-[160px]">
          <div className="space-y-1.5 pr-3">
            {preview.rows.map((row, i) => (
              <div
                key={i}
                className="flex items-center gap-3 text-xs font-mono py-1 border-b border-border/30 last:border-0"
              >
                <span
                  className="text-muted-foreground/80 min-w-[100px] max-w-[140px] truncate"
                  title={row.original ?? '(null)'}
                >
                  {formatPreviewValue(row.original)}
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span
                  className="text-green-700 dark:text-green-400/90 min-w-[100px] max-w-[140px] truncate"
                  title={row.result ?? '(null)'}
                >
                  {formatPreviewValue(row.result)}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : preview ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          No matching rows found
        </div>
      ) : null}
    </div>
  )
}

/**
 * Format a preview value for display
 */
function formatPreviewValue(value: string | null, maxLength: number = 30): string {
  if (value === null || value === undefined) {
    return '(null)'
  }
  if (value === '') {
    return '(empty)'
  }
  // Truncate long values
  if (value.length > maxLength) {
    return value.slice(0, maxLength - 3) + '...'
  }
  return value
}

/**
 * Truncate column name for header display
 */
function truncateColumnName(name: string, maxLength: number = 12): string {
  if (name.length <= maxLength) return name
  return name.slice(0, maxLength - 1) + '…'
}
