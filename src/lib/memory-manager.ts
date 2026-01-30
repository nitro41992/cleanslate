/**
 * Memory Management System
 *
 * Industry best practices for tracking and managing browser memory in WASM applications.
 *
 * Key insight: Browser memory consists of multiple components:
 * 1. JS Heap (performance.memory) - ~35-45% of total
 * 2. WASM Linear Memory - cannot shrink without worker termination
 * 3. GPU/Canvas memory - for rendering
 * 4. Browser overhead - V8, DOM, etc.
 *
 * Since we can't use measureUserAgentSpecificMemory() without Cross-Origin Isolation,
 * we use heuristics and multiple data sources for estimation.
 *
 * @see https://web.dev/articles/monitor-total-page-memory-usage
 * @see https://duckdb.org/2024/07/09/memory-management
 */

// Memory thresholds (in bytes)
const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

export const MEMORY_THRESHOLDS = {
  SOFT: 1.0 * GB,         // 1.0 GB - start soft eviction (cache clearing)
  WARNING: 1.5 * GB,      // 1.5 GB - show warning
  CRITICAL: 2.5 * GB,     // 2.5 GB - recommend refresh
  DANGER: 3.5 * GB,       // 3.5 GB - strongly recommend refresh
} as const

export type MemoryHealthLevel = 'healthy' | 'soft' | 'warning' | 'critical' | 'danger'

export interface MemorySnapshot {
  timestamp: number
  jsHeapUsed: number | null       // performance.memory.usedJSHeapSize
  jsHeapTotal: number | null      // performance.memory.totalJSHeapSize
  jsHeapLimit: number | null      // performance.memory.jsHeapSizeLimit
  estimatedWasmMemory: number     // Estimated from DuckDB + buffer overhead
  estimatedTotalMemory: number    // Best estimate of Task Manager value
  healthLevel: MemoryHealthLevel
}

export interface MemoryTrend {
  snapshots: MemorySnapshot[]
  growthRatePerMinute: number     // Bytes per minute
  estimatedTimeToWarning: number | null  // Minutes until warning threshold
  isLeaking: boolean              // True if consistent growth over time
}

// Circular buffer for memory snapshots (last 10 minutes at 30s intervals)
const MAX_SNAPSHOTS = 20
const memoryHistory: MemorySnapshot[] = []

// Track consecutive high-memory readings to avoid flashing warnings
let consecutiveHighReadings = 0
const HIGH_READING_THRESHOLD = 3 // Need 3 consecutive readings (~15s) to show warning

// Cache cleanup callbacks registry
type CleanupCallback = () => Promise<void> | void
const cleanupCallbacks = new Map<string, CleanupCallback>()

/**
 * Register a cleanup callback that will be called when memory is critical.
 * Use this to register cache clearing functions from different modules.
 */
export function registerMemoryCleanup(id: string, callback: CleanupCallback): void {
  cleanupCallbacks.set(id, callback)
  console.log(`[Memory] Registered cleanup callback: ${id}`)
}

/**
 * Unregister a cleanup callback.
 */
export function unregisterMemoryCleanup(id: string): void {
  cleanupCallbacks.delete(id)
}

/**
 * Get JS heap memory (Chrome/Edge only).
 * Returns null on unsupported browsers.
 */
function getJSHeapMemory(): { used: number; total: number; limit: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memory = (performance as any).memory
  if (!memory) return null

  return {
    used: memory.usedJSHeapSize,
    total: memory.totalJSHeapSize,
    limit: memory.jsHeapSizeLimit,
  }
}

/**
 * Estimate WASM memory usage.
 * WASM linear memory can be queried via WebAssembly.Memory if exposed.
 * DuckDB-WASM doesn't directly expose this, so we estimate from:
 * - DuckDB's reported memory usage
 * - Typical overhead multiplier (1.5-2x for allocator fragmentation)
 */
export function estimateWasmMemory(duckdbReportedBytes: number): number {
  // WASM allocators typically have 1.5-2x overhead due to:
  // - Memory page alignment (64KB pages)
  // - Allocator metadata
  // - Fragmentation from malloc/free cycles
  // - Pages that grow but never shrink
  const OVERHEAD_MULTIPLIER = 1.8
  return Math.round(duckdbReportedBytes * OVERHEAD_MULTIPLIER)
}

/**
 * Estimate total browser memory (approximating Task Manager value).
 * This is a heuristic since we can't get exact values without COOP/COEP.
 *
 * Formula based on web.dev research:
 * - JS Heap accounts for ~35-45% of total memory
 * - We use 40% as middle estimate, so total ≈ jsHeap / 0.4
 * - Plus WASM memory which is separate from JS heap
 */
export function estimateTotalMemory(jsHeapUsed: number | null, wasmEstimate: number): number {
  if (jsHeapUsed === null) {
    // Fallback: assume WASM is ~30% of total
    return Math.round(wasmEstimate / 0.3)
  }

  // JS heap is ~40% of non-WASM memory, WASM is additional
  const nonWasmEstimate = jsHeapUsed / 0.4
  return Math.round(nonWasmEstimate + wasmEstimate * 0.5) // Partial overlap adjustment
}

/**
 * Determine health level based on estimated total memory.
 * Uses consecutive reading counter to avoid flashing warnings on transient spikes.
 * Note: 'soft' level is returned without debouncing to enable proactive cleanup.
 */
function getHealthLevel(estimatedTotal: number): MemoryHealthLevel {
  const rawLevel = getRawHealthLevel(estimatedTotal)

  // Soft level doesn't need debouncing - it's for proactive cleanup
  // and doesn't show UI warnings to the user
  if (rawLevel === 'soft') {
    return 'soft'
  }

  // Track consecutive high readings to debounce warnings
  if (rawLevel !== 'healthy') {
    consecutiveHighReadings++
  } else {
    consecutiveHighReadings = 0
  }

  // Only show warning/critical/danger after sustained high readings
  // This prevents false positives from file uploads and GC timing
  if (consecutiveHighReadings < HIGH_READING_THRESHOLD) {
    return 'healthy'
  }

  return rawLevel
}

/**
 * Get raw health level without debouncing (for internal use).
 */
function getRawHealthLevel(estimatedTotal: number): MemoryHealthLevel {
  if (estimatedTotal >= MEMORY_THRESHOLDS.DANGER) return 'danger'
  if (estimatedTotal >= MEMORY_THRESHOLDS.CRITICAL) return 'critical'
  if (estimatedTotal >= MEMORY_THRESHOLDS.WARNING) return 'warning'
  if (estimatedTotal >= MEMORY_THRESHOLDS.SOFT) return 'soft'
  return 'healthy'
}

/**
 * Take a memory snapshot with current values.
 */
export function takeMemorySnapshot(duckdbReportedBytes: number): MemorySnapshot {
  const jsHeap = getJSHeapMemory()
  const wasmEstimate = estimateWasmMemory(duckdbReportedBytes)
  const totalEstimate = estimateTotalMemory(jsHeap?.used ?? null, wasmEstimate)

  const snapshot: MemorySnapshot = {
    timestamp: Date.now(),
    jsHeapUsed: jsHeap?.used ?? null,
    jsHeapTotal: jsHeap?.total ?? null,
    jsHeapLimit: jsHeap?.limit ?? null,
    estimatedWasmMemory: wasmEstimate,
    estimatedTotalMemory: totalEstimate,
    healthLevel: getHealthLevel(totalEstimate),
  }

  // Add to history (circular buffer)
  memoryHistory.push(snapshot)
  if (memoryHistory.length > MAX_SNAPSHOTS) {
    memoryHistory.shift()
  }

  return snapshot
}

/**
 * Analyze memory trend from recent snapshots.
 * Detects memory leaks by checking for SUSTAINED growth over time.
 *
 * Key insight: File uploads and transforms cause sudden spikes - that's normal.
 * A leak is when memory grows consistently over a longer period without dropping.
 */
export function analyzeMemoryTrend(): MemoryTrend {
  if (memoryHistory.length < 2) {
    return {
      snapshots: [...memoryHistory],
      growthRatePerMinute: 0,
      estimatedTimeToWarning: null,
      isLeaking: false,
    }
  }

  // Calculate growth rate from oldest to newest
  const oldest = memoryHistory[0]
  const newest = memoryHistory[memoryHistory.length - 1]
  const timeDiffMinutes = (newest.timestamp - oldest.timestamp) / (1000 * 60)

  // Need at least 2 minutes of history for leak detection
  // This prevents false positives from file uploads and transforms
  if (timeDiffMinutes < 2) {
    return {
      snapshots: [...memoryHistory],
      growthRatePerMinute: 0,
      estimatedTimeToWarning: null,
      isLeaking: false,
    }
  }

  const memoryGrowth = newest.estimatedTotalMemory - oldest.estimatedTotalMemory
  const growthRatePerMinute = memoryGrowth / timeDiffMinutes

  // Detect leak: requires ALL of these conditions:
  // 1. Consistent growth > 50MB/minute over the period
  // 2. At least 10 samples (5+ minutes of data at 30s intervals)
  // 3. Most samples show growth (not just a single spike)
  const LEAK_THRESHOLD = 50 * MB // 50MB per minute sustained growth
  const MIN_SAMPLES_FOR_LEAK = 10 // ~5 minutes of data

  let isLeaking = false
  if (memoryHistory.length >= MIN_SAMPLES_FOR_LEAK && growthRatePerMinute > LEAK_THRESHOLD) {
    // Check that growth is sustained: at least 70% of consecutive pairs show increase
    let growthCount = 0
    for (let i = 1; i < memoryHistory.length; i++) {
      if (memoryHistory[i].estimatedTotalMemory > memoryHistory[i - 1].estimatedTotalMemory) {
        growthCount++
      }
    }
    const growthPercentage = growthCount / (memoryHistory.length - 1)
    isLeaking = growthPercentage >= 0.7 // 70% of samples show growth
  }

  // Estimate time to warning threshold
  let estimatedTimeToWarning: number | null = null
  if (growthRatePerMinute > 0 && newest.estimatedTotalMemory < MEMORY_THRESHOLDS.WARNING) {
    const bytesToWarning = MEMORY_THRESHOLDS.WARNING - newest.estimatedTotalMemory
    estimatedTimeToWarning = bytesToWarning / growthRatePerMinute
  }

  return {
    snapshots: [...memoryHistory],
    growthRatePerMinute,
    estimatedTimeToWarning,
    isLeaking,
  }
}

/**
 * Run all registered cleanup callbacks.
 * Call this when memory is critical to free caches.
 */
export async function runMemoryCleanup(): Promise<{ cleaned: string[]; failed: string[] }> {
  const cleaned: string[] = []
  const failed: string[] = []

  console.log(`[Memory] Running ${cleanupCallbacks.size} cleanup callbacks...`)

  for (const [id, callback] of cleanupCallbacks) {
    try {
      await callback()
      cleaned.push(id)
      console.log(`[Memory] Cleanup succeeded: ${id}`)
    } catch (error) {
      failed.push(id)
      console.error(`[Memory] Cleanup failed: ${id}`, error)
    }
  }

  return { cleaned, failed }
}

/**
 * Get memory recommendations based on current state.
 */
export function getMemoryRecommendations(snapshot: MemorySnapshot, trend: MemoryTrend): string[] {
  const recommendations: string[] = []

  if (snapshot.healthLevel === 'danger') {
    recommendations.push('Memory is critically high. Refresh the page to reclaim memory.')
  } else if (snapshot.healthLevel === 'critical') {
    recommendations.push('Memory usage is high. Consider refreshing the page soon.')
  }

  if (trend.isLeaking) {
    recommendations.push(`Memory is growing at ${formatBytes(trend.growthRatePerMinute)}/min. A memory leak may be occurring.`)
  }

  if (trend.estimatedTimeToWarning !== null && trend.estimatedTimeToWarning < 10) {
    recommendations.push(`At current rate, memory will reach warning level in ~${Math.round(trend.estimatedTimeToWarning)} minutes.`)
  }

  return recommendations
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(1)} ${sizes[i]}`
}

/**
 * Clear memory history (call after page refresh or worker restart).
 */
export function clearMemoryHistory(): void {
  memoryHistory.length = 0
  console.log('[Memory] History cleared')
}
