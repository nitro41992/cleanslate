/**
 * ScrubPreview Component
 *
 * Shows a live preview of how data will be obfuscated before applying.
 * Displays before/after comparison for sample rows with debounced updates.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { Eye, ArrowRight, AlertCircle, Loader2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { obfuscateValue } from '@/lib/obfuscation'
import { useDuckDB } from '@/hooks/useDuckDB'
import { useTableStore } from '@/stores/tableStore'
import { cn } from '@/lib/utils'
import type { ObfuscationMethod } from '@/types'

interface ScrubPreviewProps {
  /** Table name to preview from */
  tableName: string
  /** Target column */
  column: string
  /** Obfuscation method */
  method: ObfuscationMethod
  /** Secret for hashing */
  secret: string
  /** Number of sample rows to show */
  sampleCount?: number
}

interface PreviewRow {
  original: string | null
  result: string | null
}

interface PreviewResult {
  rows: PreviewRow[]
  totalRows: number
  error?: string
}

export function ScrubPreview({
  tableName,
  column,
  method,
  secret,
  sampleCount = 8,
}: ScrubPreviewProps) {
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const { getData } = useDuckDB()
  const isContextSwitching = useTableStore((s) => s.isContextSwitching)

  // Check if preview requirements are met
  const ready = tableName && column && method

  // For hash method, use a default preview secret if none provided
  const DEFAULT_PREVIEW_SECRET = 'preview-secret-placeholder'
  const effectiveSecret = method === 'hash' && !secret ? DEFAULT_PREVIEW_SECRET : secret
  const isUsingDefaultSecret = method === 'hash' && !secret

  // Memoize dependencies for stable comparison
  const depsKey = useMemo(
    () => JSON.stringify({ tableName, column, method, effectiveSecret }),
    [tableName, column, method, effectiveSecret]
  )

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

    // Don't query during context switch - table may be frozen
    if (isContextSwitching) {
      setPreview(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    // Debounce 300ms for live updates
    debounceRef.current = setTimeout(async () => {
      try {
        // Fetch sample data
        const data = await getData(tableName, 0, sampleCount)

        // Generate preview for each row
        const rows: PreviewRow[] = await Promise.all(
          data.map(async (row) => {
            const originalValue = row[column]
            const strValue = originalValue === null || originalValue === undefined
              ? null
              : String(originalValue)

            if (strValue === null) {
              return { original: null, result: null }
            }

            const result = await obfuscateValue(strValue, method, effectiveSecret)
            return { original: strValue, result }
          })
        )

        setPreview({
          rows,
          totalRows: data.length,
        })
      } catch (error) {
        console.error('Scrub preview failed:', error)
        setPreview({
          rows: [],
          totalRows: 0,
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
  }, [depsKey, ready, method, effectiveSecret, tableName, column, sampleCount, getData, isContextSwitching])

  // Don't render if requirements not met
  if (!ready) {
    return null
  }

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
          <Eye className="w-3.5 h-3.5" />
          Live Preview
          {isUsingDefaultSecret && (
            <span className="text-[10px] text-muted-foreground font-normal">(demo secret)</span>
          )}
        </div>
        {preview && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
            {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
            Showing {preview.rows.length} sample rows
          </span>
        )}
      </div>

      {/* Notice when using default secret */}
      {isUsingDefaultSecret && (
        <p className="text-[10px] text-muted-foreground">
          Enter your secret below to see actual hash values
        </p>
      )}

      {/* Content - Show skeleton only on initial load, keep previous data while updating */}
      {isLoading && !preview ? (
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
      ) : preview && preview.rows.length > 0 ? (
        <ScrollArea className="h-[160px]">
          <div className={cn("space-y-0 pr-3 transition-opacity duration-150", isLoading && "opacity-50")}>
            {/* Header row */}
            <div className="flex items-center gap-3 text-[10px] font-medium text-muted-foreground pb-1.5 border-b border-border/50 mb-1.5">
              <span className="min-w-[120px] max-w-[140px]">Original</span>
              <ArrowRight className="w-3 h-3 shrink-0" />
              <span className="min-w-[120px] max-w-[140px]">Obfuscated</span>
            </div>
            {/* Data rows */}
            {preview.rows.map((row, i) => (
              <div
                key={i}
                className="flex items-center gap-3 text-xs font-mono py-1 border-b border-border/20 last:border-0"
              >
                <span
                  className="text-muted-foreground/80 min-w-[120px] max-w-[140px] truncate"
                  title={row.original ?? '(null)'}
                >
                  {formatPreviewValue(row.original)}
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span
                  className="text-green-700 dark:text-green-400/90 min-w-[120px] max-w-[140px] truncate"
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
          No data to preview
        </div>
      ) : null}
    </div>
  )
}

/**
 * Format a preview value for display
 */
function formatPreviewValue(value: string | null, maxLength: number = 20): string {
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
